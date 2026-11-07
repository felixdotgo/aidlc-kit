/**
 * Loop daemon status/health and the thin facades that spawn installed workflow scripts
 * (`loop-entry.mjs`, `state.mjs`). This module never mutates lifecycle state itself.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { readRange } from "./files.js";
import { daemonLockPath, daemonLogPath, eventsLogPath, loopArgs, loopDataDir, scrubbedEnv, stateScriptPath } from "./options.js";

/** Runs an installed workflow script with the current Node binary without
 * blocking the event loop; rejects with the child's stderr attached. */
export const runNode = (root: string, args: string[], options: { input?: string; timeout: number; env?: Record<string, string> }): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    const child = execFile(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: options.timeout, env: scrubbedEnv(options.env) }, (error, stdout, stderr) => {
      if (error) { rejectRun(Object.assign(error, { stderr })); return; }
      resolveRun(stdout);
    });
    child.stdin?.end(options.input ?? "");
  });

/** The child's structured error message (or stderr) for a failed `runNode`. */
export const childError = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    try { const parsed = JSON.parse(stderr) as { error?: { message?: string } }; if (parsed.error?.message) return parsed.error.message; } catch { /* not JSON */ }
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
};

export interface DaemonStatus { running: boolean; pid: number | null; startedAt: string | null }

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/** Reads the singleton loop daemon lock written by `loop-daemon.mjs`. */
export const daemonStatus = (root: string): DaemonStatus => {
  try {
    const lock = JSON.parse(readFileSync(daemonLockPath(root), "utf8")) as { pid?: unknown; startedAt?: unknown };
    const pid = typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0 ? lock.pid : null;
    return { running: pid !== null && pidAlive(pid), pid, startedAt: typeof lock.startedAt === "string" ? lock.startedAt : null };
  } catch {
    return { running: false, pid: null, startedAt: null };
  }
};

export interface DaemonError { taskId?: string; message: string; at?: string; failures?: number; retryInMs?: number }
/** How much of the event-log tail the daemon health check scans. */
const HEALTH_TAIL_BYTES = 64 * 1024;

/**
 * Unresolved daemon errors from the tail of the event-log sidecar: a task's
 * `daemon_turn_error` stays open until a later `daemon_turn` for that task, a
 * poll that no longer lists it as actionable, or a daemon restart; a
 * `daemon_poll_error` stays open until the next successful poll.
 */
export const daemonHealth = (root: string): DaemonError[] => {
  const path = eventsLogPath(root);
  let text = "";
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - HEALTH_TAIL_BYTES);
    text = readRange(path, start, size).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch { return []; }
  const turnErrors = new Map<string, DaemonError>();
  let pollError: DaemonError | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const taskId = typeof event.taskId === "string" ? event.taskId : undefined;
    const record = (): DaemonError => ({
      ...(taskId ? { taskId } : {}),
      message: typeof event.message === "string" ? event.message : "error",
      ...(typeof event.at === "string" ? { at: event.at } : {}),
      ...(typeof event.failures === "number" ? { failures: event.failures } : {}),
      ...(typeof event.retryInMs === "number" ? { retryInMs: event.retryInMs } : {}),
    });
    switch (event.type) {
      case "daemon_start": turnErrors.clear(); pollError = null; break;
      case "daemon_poll_error": pollError = record(); break;
      case "daemon_poll": {
        pollError = null;
        const actionable = Array.isArray(event.actionable) ? event.actionable : [];
        for (const id of [...turnErrors.keys()]) if (!actionable.includes(id)) turnErrors.delete(id);
        break;
      }
      case "daemon_turn": if (taskId) turnErrors.delete(taskId); break;
      case "daemon_turn_error": if (taskId) turnErrors.set(taskId, record()); break;
      default: break;
    }
  }
  return [...(pollError ? [pollError] : []), ...turnErrors.values()];
};

/** Starts the local daemon unless a live one already holds the singleton lock.
 * The daemon's stderr goes to `daemon.log` so start-up failures are visible. */
export const ensureDaemon = (root: string): { pid: number | null; started: boolean } => {
  const current = daemonStatus(root);
  if (current.running) return { pid: current.pid, started: false };
  mkdirSync(loopDataDir(root), { recursive: true });
  const log = openSync(daemonLogPath(root), "a");
  try {
    const child = spawn(process.execPath, loopArgs(root, "start"), {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      // The daemon (and every lead/worker it spawns) never sees UI or reviewer credentials.
      env: scrubbedEnv({ AIDLC_LOOP_EVENT_LOG: eventsLogPath(root) }),
    });
    // Without a listener a spawn failure would be an unhandled 'error' event and
    // crash the UI server; the daemon's own start-up errors go to daemon.log.
    child.on("error", () => { /* reported via daemon status on the next render */ });
    child.unref();
    return { pid: child.pid ?? null, started: true };
  } finally { closeSync(log); }
};

export const intakeTask = async (root: string, requirement: string): Promise<{ taskId: string; title: string }> => {
  const output = await runNode(root, loopArgs(root, "intake"), { input: requirement, timeout: 30000 });
  const parsed = JSON.parse(output) as { taskId?: unknown; title?: unknown };
  if (typeof parsed.taskId !== "string" || typeof parsed.title !== "string") throw new Error("loop intake returned no task id");
  return { taskId: parsed.taskId, title: parsed.title };
};

export const activateTask = async (root: string, taskId: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "task", "status", taskId, "--status", "active", "--root", root], { timeout: 30000 })) as unknown;

export const loopStatusJson = async (root: string, taskId: string): Promise<unknown> =>
  JSON.parse(await runNode(root, loopArgs(root, "status", taskId), { timeout: 5000 })) as unknown;

export const approveGate = async (root: string, taskId: string, gate: string, source: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "gate", "approve", taskId, "--gate", gate, "--source", source, "--root", root], { timeout: 30000 })) as unknown;

/** Human feedback keeps the task at its current gate. The audited status cancel
 * records `Cancelled gate wait at <gate>: <feedback>` evidence and sets the task
 * `active`; the loop runtime turns that into a "revise the review artifact, then
 * re-present the gate" prompt — the same mechanism as typing feedback in the
 * trusted terminal (`loop-gate.mjs`). It never approves anything. */
export const feedbackGate = async (root: string, taskId: string, feedback: string, source: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "task", "status", taskId, "--status", "active", "--mode", "audited", "--reason", feedback, "--source", source, "--root", root], { timeout: 30000 })) as unknown;
