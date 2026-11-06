import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The event-log sidecar rotates to `<path>.1` (one generation kept) once it
 * reaches this size, so a 24/7 daemon cannot grow it without bound. */
export const EVENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

let preparedDirectory;

/** Append one structured event to the optional UI event-log sidecar (JSONL).
 * Each record gets an `at` timestamp; the directory is created on demand. */
function appendEventLog(event) {
  const path = process.env.AIDLC_LOOP_EVENT_LOG;
  if (!path) return;
  try {
    const directory = dirname(path);
    if (preparedDirectory !== directory) { mkdirSync(directory, { recursive: true }); preparedDirectory = directory; }
    try { if (statSync(path).size >= EVENT_LOG_MAX_BYTES) renameSync(path, `${path}.1`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    const record = event && typeof event === "object" && !Array.isArray(event) && !("at" in event) ? { at: new Date().toISOString(), ...event } : event;
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch { /* best-effort: never break the loop on a log write failure */ }
}

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
      process.stderr.write(`  › tool: ${event.tool ?? "?"}\n`);
      break;
    case "lifecycle_command":
      process.stderr.write(`  › command ${event.status ?? "?"} (exit ${event.exitCode ?? "?"})\n`);
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
