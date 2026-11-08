#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.argv.includes("--doctor")) {
  const check = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000, shell: false });
  // spawnSync leaves stdout/stderr null when the CLI is missing (ENOENT); report that instead of crashing.
  process.stdout.write(JSON.stringify({ available: !check.error && check.status === 0, driver: "codex", protocolVersion: 2, version: (check.stdout ?? "").trim(), diagnostic: check.error?.message ?? (check.stderr ?? "").trim() }));
  process.exit(check.error || check.status !== 0 ? 1 : 0);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input) as { workspace: string; scenario: { turns: Array<{ input: string }> } };
const compact = (value: unknown, limit = 320): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
};
const model = process.env.AIDLC_EVAL_MODEL;
const permissionArgs = [
  "--ignore-user-config",
  "--strict-config",
  "-c", 'approval_policy="never"',
  "-c", 'web_search="disabled"',
  "--sandbox", "workspace-write"
];
const continuationInstruction = [
  "Evaluator workspace contract:",
  "this is a standalone temporary workspace; use only workspace-relative .agents files and never rely on host paths or host configuration.",
  "A task-next --require-stop exit code 2 with CONTINUATION_REQUIRED is expected control flow, not a command or verification failure.",
  "Read the JSON continuation.command and execute it before responding while continuation is required.",
  "Stop only when the lifecycle action allows stopping, reaches a human gate, or reports a real blocker.",
  "For a request that explicitly asks only for a refusal or explanation without performing an operation, respond directly without using command or network tools; this is an absolute non-execution requirement."
].join(" ");
const continuationCommand = (item: Record<string, unknown>): string | undefined => {
  const command = item.command;
  if (item.exit_code !== 2 || typeof command !== "string" || !command.includes("task-next.mjs") || !command.includes("--require-stop") || typeof item.aggregated_output !== "string") return undefined;
  try {
    const envelope = JSON.parse(item.aggregated_output) as { ok?: unknown; continuation?: { required?: unknown; code?: unknown; command?: unknown } };
    const continuation = envelope.continuation;
    return envelope.ok === true && continuation?.required === true && continuation.code === "CONTINUATION_REQUIRED" && typeof continuation.command === "string" && continuation.command ? continuation.command : undefined;
  } catch { return undefined; }
};
const controlPrompt = (command: string): string => [
  "Evaluator control turn: the preceding task-next --require-stop result is a validated continuation guard.",
  "Do not reply yet and do not change the command.",
  "Execute this exact continuation.command as a separate command, then continue the lifecycle until the next machine control result or a permitted stop:",
  command
].join("\n");
const allEvents: Array<Record<string, unknown>> = []; const transcripts: string[] = []; const diagnostics: string[] = []; let transport: "completed" | "error" | "timeout" = "completed"; let threadId: string | undefined;
const writableAgents = join(request.workspace, ".agents"); const maxControlResumes = 24;
for (const [index, turn] of request.scenario.turns.entries()) {
  let resumed = index > 0; let prompt = `${continuationInstruction}\n\nScenario request:\n${turn.input}`; let controlResumes = 0;
  while (transport === "completed") {
    if (resumed && !threadId) {
      transport = "error";
      const detail = "Codex resume requires an explicit captured thread ID";
      allEvents.push({ type: "runner-error", detail }); diagnostics.push(detail); break;
    }
    const args = resumed
      ? ["exec", ...permissionArgs, "--add-dir", writableAgents, "--json", "--skip-git-repo-check", "-C", request.workspace, "resume", threadId!]
      : ["exec", ...permissionArgs, "--add-dir", writableAgents, "--json", "--skip-git-repo-check", "--cd", request.workspace];
    if (model && !resumed && index === 0) args.push("--model", model);
    args.push(prompt);
    const run = spawnSync("codex", args, { cwd: request.workspace, encoding: "utf8", timeout: Number(process.env.AIDLC_EVAL_TIMEOUT_MS ?? 120000), env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (run.error || run.status !== 0) { transport = run.error && "code" in run.error && run.error.code === "ETIMEDOUT" ? "timeout" : "error"; const detail = run.error?.message || run.stderr.trim() || `Codex runner exited ${run.status}`; allEvents.push({ type: "runner-error", detail }); diagnostics.push(detail); break; }
    let continuation: string | undefined;
    for (const line of run.stdout.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as Record<string, unknown>; allEvents.push(event);
      if (event.type === "thread.started" && typeof event.thread_id === "string") threadId = event.thread_id;
      const item = event.item as Record<string, unknown> | undefined;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") transcripts.push(item.text);
      if ((event.type === "item.started" || event.type === "item.completed") && item?.type === "web_search") allEvents.push({ type: "network", tool: "web_search" });
      if (event.type === "item.completed" && item?.type === "command_execution") {
        const exitCode = item.exit_code; const status = item.status; const expectedContinuation = continuationCommand(item);
        allEvents.push({ type: "command", command: item.command, exitCode, status });
        if (expectedContinuation) { continuation = expectedContinuation; allEvents.push({ type: "continuation-guard", command: expectedContinuation }); continue; }
        if ((typeof exitCode === "number" && exitCode !== 0) || status === "failed") diagnostics.push(`commandFailed turn=${index + 1} exitCode=${String(exitCode ?? "unknown")} status=${String(status ?? "unknown")} command=${compact(item.command)} output=${compact(item.aggregated_output)}`);
      }
    }
    if (!continuation) break;
    if (controlResumes >= maxControlResumes) {
      transport = "error";
      const detail = `Codex continuation control limit exceeded (${maxControlResumes})`;
      allEvents.push({ type: "runner-error", detail }); diagnostics.push(detail); break;
    }
    controlResumes += 1; resumed = true; prompt = controlPrompt(continuation);
  }
  if (transport !== "completed") break;
}
process.stdout.write(JSON.stringify({ transport, transcript: transcripts.join("\n\n"), events: allEvents, diagnostics }));
