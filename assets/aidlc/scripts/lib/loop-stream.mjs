import { appendFileSync, lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** The event-log sidecar rotates to `<path>.1` (one generation kept) once it
 * reaches this size, so a 24/7 daemon cannot grow it without bound. */
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Per-task history files (`<log dir>/events/<taskId>.jsonl`) rotate the same
 * way at a smaller bound, since one exists for every task. */
export const TASK_EVENT_LOG_MAX_BYTES = 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let preparedDirectory;

const rotate = (path, limit) => {
  try { if (statSync(path).size >= limit) renameSync(path, `${path}.1`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
};

/** True when `path` is missing or a real (non-symlink) entry of the expected kind. */
const safeEntry = (path, directory) => {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile());
  } catch (error) { if (error?.code === "ENOENT") return true; throw error; }
};

/** Path of the per-task history file for `taskId` next to the global event log
 * `logPath`, or null when the id is not a canonical task id. */
export const taskEventLogPath = (logPath, taskId) =>
  typeof logPath === "string" && logPath && typeof taskId === "string" && TASK_ID.test(taskId) ? join(dirname(logPath), "events", `${taskId}.jsonl`) : null;

/** Append one line to a task's history. Refuses symlinked (or non-regular) log
 * directories and files so a planted link cannot redirect the write. */
function appendTaskEventLog(logPath, taskId, line) {
  const path = taskEventLogPath(logPath, taskId);
  if (!path) return;
  const directory = dirname(path);
  if (!safeEntry(dirname(directory), true) || !safeEntry(directory, true)) return;
  mkdirSync(directory, { recursive: true });
  if (!safeEntry(directory, true) || !safeEntry(path, false) || !safeEntry(`${path}.1`, false)) return;
  rotate(path, TASK_EVENT_LOG_MAX_BYTES);
  appendFileSync(path, line);
}

/** Append one structured event to the optional UI event-log sidecar (JSONL)
 * and, when it carries a valid `taskId`, to that task's history file. Each
 * record gets an `at` timestamp; directories are created on demand. */
function appendEventLog(event) {
  const path = process.env.AIDLC_LOOP_EVENT_LOG;
  if (!path) return;
  let line;
  try {
    const directory = dirname(path);
    if (preparedDirectory !== directory) { mkdirSync(directory, { recursive: true }); preparedDirectory = directory; }
    rotate(path, EVENT_LOG_MAX_BYTES);
    const record = event && typeof event === "object" && !Array.isArray(event) && !("at" in event) ? { at: new Date().toISOString(), ...event } : event;
    line = `${JSON.stringify(record)}\n`;
    appendFileSync(path, line);
  } catch { /* best-effort: never break the loop on a log write failure */ }
  try { if (line && typeof event?.taskId === "string") appendTaskEventLog(path, event.taskId, line); }
  catch { /* best-effort, independently of the global log */ }
}

const withSummary = (event, separator) => typeof event.summary === "string" && event.summary ? `${separator}${event.summary}` : "";

/** Render foreground loop progress to stderr without polluting stdout JSON. */
export function streamLog(event) {
  appendEventLog(event);
  if (!event || typeof event.type !== "string") return;
  switch (event.type) {
    case "turn_start":
      process.stderr.write(`\n━━ turn ${Number(event.iteration ?? 0) + 1} · phase ${event.phase ?? "?"} · agent ${event.agent ?? "?"} ━━\n`);
      break;
    case "turn_end":
      process.stderr.write(`━━ turn done ━━\n`);
      break;
    case "agent_text":
      process.stderr.write(`${event.text ?? ""}\n`);
      break;
    case "agent_tool":
      process.stderr.write(`  › tool: ${event.tool ?? "?"}${withSummary(event, " · ")}\n`);
      break;
    case "lifecycle_command":
      process.stderr.write(`  › command ${event.status ?? "?"} (exit ${event.exitCode ?? "?"})${withSummary(event, ": ")}\n`);
      break;
    case "daemon_turn_error":
      process.stderr.write(`  ! ${event.taskId ?? "?"}: ${event.message ?? "error"} (retry in ${Math.round(Number(event.retryInMs ?? 0) / 1000)}s)\n`);
      break;
    case "loop_stopped":
      process.stderr.write(`  ■ ${event.taskId ?? "?"} stopped: ${event.reason ?? ""}\n`);
      break;
    case "gate":
      process.stderr.write(`\n${event.gateView ?? `Gate ${event.gate ?? "?"} reached — approve from the trusted terminal.`}\n`);
      break;
    case "worker_image_build":
      process.stderr.write(`\n▶ building worker image ${event.image ?? "?"} (provider ${event.provider ?? "?"})…\n`);
      break;
    default:
      break;
  }
}
