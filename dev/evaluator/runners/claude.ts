#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--doctor")) {
  const check = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000, shell: false });
  // spawnSync leaves stdout/stderr null when the CLI is missing (ENOENT); report that instead of crashing.
  process.stdout.write(JSON.stringify({ available: !check.error && check.status === 0, driver: "claude", protocolVersion: 2, version: (check.stdout ?? "").trim(), diagnostic: check.error?.message ?? (check.stderr ?? "").trim() }));
  process.exit(check.error || check.status !== 0 ? 1 : 0);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input) as { workspace: string; suiteId?: string; scenario: { turns: Array<{ input: string }> } };
const compact = (value: unknown, limit = 320): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, limit);
};
const commandPermission = (command: unknown, args: unknown): string | undefined => {
  if (typeof command !== "string" || !Array.isArray(args) || !args.every((item) => typeof item === "string")) return undefined;
  const tokens = [command, ...args] as string[];
  if (!tokens.every((token) => /^[A-Za-z0-9_./:@%+=-]+$/.test(token))) return undefined;
  return `Bash(${tokens.join(" ")})`;
};
const allowedTools = (workspace: string, suiteId?: string): string[] => {
  const lifecycle = `${workspace}/.agents/aidlc/scripts/*`;
  const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node .agents/aidlc/scripts/*)", "Bash(rtk node .agents/aidlc/scripts/*)", `Bash(node ${lifecycle})`, `Bash(rtk node ${lifecycle})`];
  if (suiteId !== "aidlc-official-agentic") return tools;
  const configPath = join(workspace, ".agents/config.json");
  if (!existsSync(configPath)) return tools;
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { commands?: Record<string, { command?: unknown; args?: unknown }> };
  for (const spec of Object.values(config.commands ?? {})) {
    const permission = commandPermission(spec.command, spec.args);
    if (permission) tools.push(permission);
  }
  return [...new Set(tools)];
};
const toolSurface = "Bash,Read,Edit,Write,Glob,Grep";
const approvedTools = allowedTools(request.workspace, request.suiteId).join(",");
const evaluatorPrompt = "Evaluation policy: use Read, Glob, and Grep for file inspection. Use Bash only for installed .agents/aidlc lifecycle scripts and configured verification commands. Do not access user memory, user MCP servers, or paths outside the evaluation workspace. Follow the installed project instructions and the canonical nextAction loop.";
const transcripts: string[] = []; const events: Array<Record<string, unknown>> = []; const diagnostics: string[] = []; let transport: "completed" | "error" | "timeout" = "completed"; let sessionId: string | undefined; let inputTokens = 0; let outputTokens = 0; let costUsd = 0;
for (const turn of request.scenario.turns) {
  const toolUses = new Map<string, { name: unknown; input: unknown }>();
  const args = ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits", "--tools", toolSurface, "--allowedTools", approvedTools, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--append-system-prompt", evaluatorPrompt];
  if (process.env.AIDLC_EVAL_MODEL) args.push("--model", process.env.AIDLC_EVAL_MODEL);
  if (sessionId) args.push("--resume", sessionId);
  args.push(turn.input);
  const run = spawnSync("claude", args, { cwd: request.workspace, encoding: "utf8", timeout: Number(process.env.AIDLC_EVAL_TIMEOUT_MS ?? 120000), env: process.env, shell: false });
  if (run.error || run.status !== 0) { transport = run.error && "code" in run.error && run.error.code === "ETIMEDOUT" ? "timeout" : "error"; const detail = run.error?.message || run.stderr.trim() || `Claude runner exited ${run.status}`; events.push({ type: "runner-error", detail }); diagnostics.push(detail); break; }
  for (const line of run.stdout.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as Record<string, unknown>; events.push(event);
    if (typeof event.session_id === "string") sessionId = event.session_id;
    if (event.type === "result" && typeof event.result === "string") transcripts.push(event.result);
    const usage = event.usage as Record<string, unknown> | undefined;
    if (usage) { inputTokens += Number(usage.input_tokens ?? 0); outputTokens += Number(usage.output_tokens ?? 0); }
    costUsd += Number(event.total_cost_usd ?? 0);
    if (event.type === "tool_use") events.push({ type: "command", tool: event.name });
    if (event.type === "tool_use" && (event.name === "WebFetch" || event.name === "WebSearch")) events.push({ type: "network", tool: event.name });
    const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const block of message?.content ?? []) {
      if (block.type === "tool_use") {
        events.push({ type: "command", tool: block.name, input: block.input });
        if (block.name === "WebFetch" || block.name === "WebSearch") events.push({ type: "network", tool: block.name });
        if (typeof block.id === "string") toolUses.set(block.id, { name: block.name, input: block.input });
      }
      if (block.type === "tool_result" && block.is_error === true) {
        const use = typeof block.tool_use_id === "string" ? toolUses.get(block.tool_use_id) : undefined;
        diagnostics.push(`commandFailed tool=${compact(use?.name ?? "unknown")} input=${compact(use?.input)} output=${compact(block.content)}`);
      }
    }
  }
}
process.stdout.write(JSON.stringify({ transport, transcript: transcripts.join("\n\n"), events, usage: { inputTokens, outputTokens, costUsd }, diagnostics }));
