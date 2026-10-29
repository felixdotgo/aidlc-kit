import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
const MAX_RESULT_CHARS = 8192;
const MAX_DIAGNOSTICS = 16;

/** One runtime enumeration for every loop provider. Host gates import this
 * list; container paths reject providers that need file-based credentials. */
export const LOOP_PROVIDERS = Object.freeze(["codex", "claude", "opencode"]);
export const LOOP_PROVIDER_LIST = `${LOOP_PROVIDERS.slice(0, -1).join(", ")}, or ${LOOP_PROVIDERS[LOOP_PROVIDERS.length - 1]}`;
export const isLoopProvider = (value) => typeof value === "string" && LOOP_PROVIDERS.includes(value);
const OPENCODE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:#[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const redact = (value) => String(value ?? "")
  .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gi, "$1=[REDACTED]")
  .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
  .replace(/\s+/g, " ").trim();
const diagnostic = (value) => redact(value).slice(0, 512);
const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);
const emit = async (callback, event) => { if (callback) await callback(event); };

// Adapters are registered by trusted application code, never loaded from a
// project configuration or shell string. Each adapter owns its CLI protocol.
const adapters = new Map();
export function registerAgentAdapter(name, adapter) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || adapters.has(name)) throw new Error("invalid or duplicate agent adapter");
  if (!adapter || typeof adapter.command !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(adapter.command) || typeof adapter.arguments !== "function" || typeof adapter.parse !== "function" || (adapter.preflight !== undefined && typeof adapter.preflight !== "function") || (adapter.completesOnExit !== undefined && typeof adapter.completesOnExit !== "boolean")) throw new Error("agent adapter requires a command, arguments, parser, and optional preflight");
  adapters.set(name, Object.freeze({ ...adapter }));
}
export async function preflightAgentAdapter(name, { env = process.env, root } = {}) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unknown agent adapter: ${name}`);
  const paths = (env.PATH ?? process.env.PATH ?? "").split(delimiter);
  if (!paths.some((entry) => { try { accessSync(join(entry || ".", adapter.command), constants.X_OK); return true; } catch { return false; } })) throw new Error(`Worker provider CLI is unavailable: ${name}`);
  if (adapter.preflight) await adapter.preflight({ env, root });
}
registerAgentAdapter("codex", {
  command: "codex",
  arguments: ({ root, sessionId }) => ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", root, ...(sessionId ? ["resume", sessionId] : []), "-"],
  input: (prompt) => prompt,
  parse: async (event, context) => {
    if (event.type === "thread.started") await context.captureId(event.thread_id);
    if (event.type === "turn.completed") context.complete();
    if (event.type === "turn.failed" || event.type === "error") throw new Error(`codex reported ${event.type}: ${diagnostic(JSON.stringify(event.error ?? event.message ?? "unknown"))}`);
    const item = record(event.item);
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") context.result(item.text);
    if (event.type === "item.completed" && item?.type === "command_execution") await context.commandEvent(item.exit_code, item.status);
  }
});
registerAgentAdapter("claude", {
  command: "claude",
  arguments: ({ sessionId }) => ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-mode", "acceptEdits", ...(sessionId ? ["--resume", sessionId] : [])],
  input: (prompt) => `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
  parse: async (event, context) => {
    if (event.session_id !== undefined) await context.captureId(event.session_id);
    if (event.type === "result") {
      if (event.is_error === true) throw new Error(`claude reported an error: ${diagnostic(event.result)}`);
      context.complete();
      if (typeof event.result === "string") context.result(event.result);
    }
    const message = record(event.message);
    if (Array.isArray(message?.content)) for (const block of message.content) {
      if (!record(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && block.name === "Bash") context.toolUses.set(block.id, true);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" && context.toolUses.has(block.tool_use_id)) {
        context.toolUses.delete(block.tool_use_id);
        await context.commandEvent(block.is_error === true ? 1 : 0, block.is_error === true ? "failed" : "completed");
      }
    }
  }
});

registerAgentAdapter("opencode", {
  command: "opencode",
  completesOnExit: true,
  arguments: ({ sessionId, prompt, env }) => {
    const model = (env ?? process.env).AIDLC_OPENCODE_MODEL;
    if (typeof model !== "string" || !OPENCODE_MODEL.test(model)) throw new Error("opencode provider requires AIDLC_OPENCODE_MODEL");
    return ["run", "--format", "json", "--standalone", "--auto", ...(sessionId ? ["--session", sessionId] : []), "--model", model, prompt];
  },
  parse: async (event, context) => {
    if (event.sessionID !== undefined) await context.captureId(event.sessionID);
    const part = record(event.part);
    if (event.type === "text" && typeof part?.text === "string") context.result(part.text);
    if (event.type === "tool_use" && part?.tool === "shell") {
      const state = record(part.state);
      const metadata = record(record(state?.metadata)?.metadata);
      await context.commandEvent(metadata?.exit, state?.status === "error" ? "failed" : state?.status);
    }
    if (event.type === "step_finish" && part?.reason === "stop") context.complete();
  }
});

/**
 * Run exactly one agent turn for a registered provider. The returned session ID
 * is the CLI's exact ID; onSessionId observes it immediately. Callers decide when
 * a checkpoint is durable. Transport and protocol failures reject with a bounded,
 * redacted error message.
 */
export async function runAgentTurn({ agent, root, sessionId, prompt, timeoutMs, onSessionId, onEvent, signal, env, spawnProcess = spawn } = {}) {
  const adapter = adapters.get(agent);
  if (!adapter) throw new Error(`agent must be ${LOOP_PROVIDER_LIST} or a trusted registered adapter`);
  if (typeof root !== "string" || !root) throw new Error("root must be a nonempty path");
  if (typeof prompt !== "string" || !prompt) throw new Error("prompt must be nonempty");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  if (sessionId !== undefined && !isId(sessionId)) throw new Error("invalid explicit session ID");
  if (onSessionId !== undefined && typeof onSessionId !== "function") throw new Error("onSessionId must be a function");
  if (onEvent !== undefined && typeof onEvent !== "function") throw new Error("onEvent must be a function");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("signal must be an AbortSignal");
  if (signal?.aborted) throw new Error("agent turn aborted before start");

  const args = adapter.arguments({ root, sessionId, prompt, env });
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("agent adapter arguments must be an array of strings");
  if (typeof spawnProcess !== "function") throw new Error("spawnProcess must be a function");
  const input = adapter.input?.(prompt);
  if (input !== undefined && typeof input !== "string") throw new Error("agent adapter input must be a string");
  const child = spawnProcess(adapter.command, args, { cwd: root, shell: false, env: { ...(env ?? process.env), PWD: root }, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (input !== undefined) {
    if (!child.stdin) throw new Error("agent transport lacks stdin");
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  }
  const diagnostics = [];
  let exactId = sessionId;
  let resultText = "";
  let stdoutBuffer = "";
  let stderrText = "";
  let stderrBytes = 0;
  let failed;
  let timedOut = false;
  let aborted = false;
  let completed = false;
  let resultSeen = false;
  let processing = Promise.resolve();
  let killTimer;
  const toolUses = new Map();
  const addDiagnostic = (value) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic(value));
  };
  const fail = (message) => {
    if (!failed) failed = diagnostic(message);
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  const abort = () => { aborted = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const captureId = async (value) => {
    if (!isId(value)) throw new Error(`${agent} reported an invalid session ID`);
    if (exactId && exactId !== value) throw new Error(`${agent} session ID changed during turn`);
    if (!exactId) {
      exactId = value;
      await emit(onSessionId, value);
    }
  };
  const commandEvent = async (exitCode, status) => {
    const safeExitCode = Number.isSafeInteger(exitCode) ? exitCode : null;
    const safeStatus = ["completed", "failed", "in_progress"].includes(status) ? status : "unknown";
    await emit(onEvent, { type: "lifecycle_command", exitCode: safeExitCode, status: safeStatus });
    if ((safeExitCode !== null && safeExitCode !== 0) || safeStatus === "failed") addDiagnostic(`commandFailed exitCode=${String(safeExitCode ?? "unknown")} status=${safeStatus}`);
  };
  const parseEvent = async (line) => {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`${agent} emitted malformed JSONL`); }
    if (!record(event) || typeof event.type !== "string") throw new Error(`${agent} emitted malformed event`);
    await adapter.parse(event, { captureId, commandEvent, toolUses, complete: () => { completed = true; resultSeen = true; }, result: (value) => { resultText = value.slice(0, MAX_RESULT_CHARS); } });
    await emit(onEvent, { type: "agent_event", eventType: event.type });
  };
  const queueLine = (line) => {
    processing = processing.then(() => parseEvent(line)).catch((error) => fail(error.message));
  };
  child.stdout.on("data", (chunk) => {
    if (failed) return;
    stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES && !stdoutBuffer.includes("\n")) { fail(`${agent} JSONL line exceeded limit`); return; }
    let end;
    while ((end = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, end).trim();
      stdoutBuffer = stdoutBuffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) { fail(`${agent} JSONL line exceeded limit`); return; }
      if (line) queueLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    const remaining = MAX_STDERR_BYTES - stderrBytes;
    if (remaining > 0) { stderrText += chunk.subarray(0, remaining).toString("utf8"); stderrBytes += Math.min(chunk.length, remaining); }
  });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); }, timeoutMs);
  timer.unref();
  const exit = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  signal?.removeEventListener("abort", abort);
  if (stdoutBuffer.trim() && !failed) queueLine(stdoutBuffer.trim());
  await processing;
  if (timedOut) throw new Error(`${agent} turn timed out after ${timeoutMs} ms`);
  if (aborted) throw new Error(`${agent} turn aborted`);
  if (exit.error) throw new Error(`${agent} failed to start: ${diagnostic(exit.error.message)}`);
  if (failed) throw new Error(failed);
  if (exit.code !== 0) throw new Error(`${agent} exited ${exit.code ?? exit.signal}: ${diagnostic(stderrText)}`);
  if (!exactId) throw new Error(`${agent} turn ended without an explicit captured session ID`);
  if (agent === "claude" && !resultSeen) throw new Error("claude turn ended without a result event");
  if (!completed && adapter.completesOnExit === true) completed = true;
  if (!completed) throw new Error(`${agent} turn ended without a completion event`);
  if (stderrText.trim()) addDiagnostic(`stderr: ${stderrText}`);
  await emit(onEvent, { type: "turn_completed" });
  return { sessionId: exactId, resultText, diagnostics };
}
