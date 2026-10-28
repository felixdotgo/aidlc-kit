import { spawn } from "node:child_process";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 4096;
const MAX_RESULT_CHARS = 8192;
const MAX_DIAGNOSTICS = 16;

const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const redact = (value) => String(value ?? "")
  .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))=([^\s]+)/gi, "$1=[REDACTED]")
  .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
  .replace(/\s+/g, " ").trim();
const diagnostic = (value) => redact(value).slice(0, 512);
const isId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f]/.test(value);
const emit = async (callback, event) => { if (callback) await callback(event); };

/**
 * Run exactly one Codex or Claude turn. The returned session ID is the CLI's exact
 * ID; the caller must persist it when onSessionId fires, before the turn completes.
 * Transport and protocol failures reject with a bounded, redacted error message.
 */
export async function runAgentTurn({ agent, root, sessionId, prompt, timeoutMs, onSessionId, onEvent, signal, env } = {}) {
  if (agent !== "codex" && agent !== "claude") throw new Error("agent must be codex or claude");
  if (typeof root !== "string" || !root) throw new Error("root must be a nonempty path");
  if (typeof prompt !== "string" || !prompt) throw new Error("prompt must be nonempty");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  if (sessionId !== undefined && !isId(sessionId)) throw new Error("invalid explicit session ID");
  if (onSessionId !== undefined && typeof onSessionId !== "function") throw new Error("onSessionId must be a function");
  if (onEvent !== undefined && typeof onEvent !== "function") throw new Error("onEvent must be a function");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("signal must be an AbortSignal");
  if (signal?.aborted) throw new Error("agent turn aborted before start");

  const args = agent === "codex"
    ? ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", root, ...(sessionId ? ["resume", sessionId] : []), prompt]
    : ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits", ...(sessionId ? ["--resume", sessionId] : []), prompt];
  const child = spawn(agent, args, { cwd: root, shell: false, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
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
    if (agent === "codex") {
      if (event.type === "thread.started") await captureId(event.thread_id);
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.failed" || event.type === "error") throw new Error(`codex reported ${event.type}: ${diagnostic(JSON.stringify(event.error ?? event.message ?? "unknown"))}`);
      const item = record(event.item);
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") resultText = item.text.slice(0, MAX_RESULT_CHARS);
      if (event.type === "item.completed" && item?.type === "command_execution") await commandEvent(item.exit_code, item.status);
    } else {
      if (event.session_id !== undefined) await captureId(event.session_id);
      if (event.type === "result") {
        resultSeen = true;
        completed = true;
        if (event.is_error === true) throw new Error(`claude reported an error: ${diagnostic(event.result)}`);
        if (typeof event.result === "string") resultText = event.result.slice(0, MAX_RESULT_CHARS);
      }
      const message = record(event.message);
      if (Array.isArray(message?.content)) for (const block of message.content) {
        if (!record(block)) continue;
        if (block.type === "tool_use" && typeof block.id === "string" && block.name === "Bash") {
          toolUses.set(block.id, true);
        }
        if (block.type === "tool_result" && typeof block.tool_use_id === "string" && toolUses.has(block.tool_use_id)) {
          toolUses.delete(block.tool_use_id);
          await commandEvent(block.is_error === true ? 1 : 0, block.is_error === true ? "failed" : "completed");
        }
      }
    }
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
  if (!completed) throw new Error(`${agent} turn ended without a completion event`);
  if (stderrText.trim()) addDiagnostic(`stderr: ${stderrText}`);
  await emit(onEvent, { type: "turn_completed" });
  return { sessionId: exactId, resultText, diagnostics };
}
