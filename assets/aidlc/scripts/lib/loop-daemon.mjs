import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requireLocalAuthority } from "./authority.mjs";
import { isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";
import { validateLimits, validateRoot, readLoopRecord } from "./loop-runtime.mjs";
import { createIsolatedLocalSupervisor } from "./loop-supervisor-run-local.mjs";
import { loadState, nextAction } from "./store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DAEMON_POLL_MIN = 1000;
export const DAEMON_POLL_MAX = 300000;
export const DEFAULT_DAEMON_POLL_MS = 5000;

export function validateDaemonPollMs(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < DAEMON_POLL_MIN || n > DAEMON_POLL_MAX) throw new Error(`daemon pollMs must be an integer from ${DAEMON_POLL_MIN} to ${DAEMON_POLL_MAX}`);
  return n;
}

/** A task is loop-owned when it was created through loop intake (CLI or web
 * dashboard: `.agents/data/tasks/<id>/loop-intake.json`) or already has a loop
 * run record. Tasks created by an interactive lead are not loop-owned, so the
 * daemon never runs them concurrently with that lead. */
export function isLoopOwned(root, taskId) {
  if (!ID.test(taskId ?? "")) return false;
  try { if (lstatSync(join(root, ".agents", "data", "tasks", taskId, "loop-intake.json")).isFile()) return true; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return readLoopRecord(root, taskId) !== null;
}

/** Path of the singleton daemon lock (one local daemon per project root). */
export const daemonLockPath = (root) => join(root, ".agents", "data", "loop", "daemon.lock");

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
};

const parseDaemonLock = (path) => {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; return { corrupt: true }; }
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== "string" || !value.token) return { corrupt: true };
  return value;
};

/** Read the daemon lock: `null` when absent, otherwise `{ pid, startedAt, alive }`. */
export function readDaemonLock(root) {
  const lock = parseDaemonLock(daemonLockPath(root));
  if (!lock) return null;
  if (lock.corrupt) return { pid: null, startedAt: null, alive: false };
  return { pid: lock.pid, startedAt: lock.startedAt ?? null, alive: pidAlive(lock.pid) };
}

/** Run `action` under a short-lived exclusive guard file so two starters
 * cannot both reclaim the same stale lock (one would delete the other's fresh
 * lock). A guard older than 10s is treated as abandoned. */
function withReclaimGuard(path, action) {
  const guard = `${path}.guard`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try { writeFileSync(guard, String(process.pid), { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try { if (Date.now() - lstatSync(guard).mtimeMs > 10000) { unlinkSync(guard); continue; } }
      catch (statError) { if (statError?.code === "ENOENT") continue; throw statError; }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the loop daemon lock guard");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return action(); }
  finally { try { unlinkSync(guard); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
}

/** Acquire the singleton daemon lock. A lock owned by a dead pid (or a corrupt
 * lock) is reclaimed under a guard after re-checking it is still the same stale
 * lock; a live owner fails closed. Liveness is a pid probe, like the loop and
 * supervisor leases, so a recycled pid can keep a stale lock "alive" until the
 * file is removed by hand. Returns a release function. */
export function acquireDaemonLock(root) {
  const path = daemonLockPath(root);
  mkdirSync(join(root, ".agents", "data", "loop"), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return () => {
        const current = parseDaemonLock(path);
        if (current && !current.corrupt && current.token === token) { try { unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stat;
      try { stat = lstatSync(path); } catch (statError) { if (statError?.code === "ENOENT") continue; throw statError; }
      if (stat.isSymbolicLink()) throw new Error(`Daemon lock is a symlink: ${path}`);
      const observed = parseDaemonLock(path);
      if (!observed) continue;
      if (!observed.corrupt && pidAlive(observed.pid)) throw new Error(`Loop daemon already running (pid ${observed.pid})`);
      withReclaimGuard(path, () => {
        const current = parseDaemonLock(path);
        const same = current && (observed.corrupt ? current.corrupt : !current.corrupt && current.token === observed.token);
        if (same) { try { unlinkSync(path); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; } }
      });
    }
  }
  throw new Error("Could not acquire the loop daemon lock");
}

/** Enumerate actionable, loop-owned tasks from canonical state in a
 * deterministic order: every task whose derived nextAction classification is
 * `run_phase` and that `isOwned` accepts, sorted by updatedAt then id so a task
 * that just ran moves to the back of the queue. A loop record that cannot be
 * read counts as owned so its error surfaces through the turn (and backoff)
 * instead of being silently skipped. */
export function actionableTasks(state, root, { isOwned = (id) => isLoopOwned(root, id) } = {}) {
  const owned = (id) => { try { return isOwned(id); } catch { return true; } };
  return Object.values(state.tasks)
    .filter((task) => nextAction(task, root).classification === "run_phase" && owned(task.id))
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")) || a.id.localeCompare(b.id));
}

export const DAEMON_BACKOFF_MAX_MS = 600000;

/** Exponential retry delay for a task whose turn keeps throwing: the poll
 * interval doubled per consecutive failure, capped at 10 minutes. */
export function backoffDelay(pollMs, failures) {
  if (failures < 1) return 0;
  return Math.min(pollMs * 2 ** Math.min(failures - 1, 30), DAEMON_BACKOFF_MAX_MS);
}

/** Run one supervised lead run for an existing task (no requirement intake):
 * a single runLoop invocation that continues until the next gate, block,
 * pause, completion, or stop — bounded by the per-run `maxTurns`. A task with a
 * loop run record is resumed; a freshly intaken task has none and starts. */
async function runTaskTurn({ root, taskId, agent, workers, workerImages, limits, pollMs, signal, cancelSignal, onEvent }) {
  const supervisor = createIsolatedLocalSupervisor({ root, taskId, agent, workers, workerImages, limits, pollMs, signal, cancelSignal, untilStop: true, onEvent });
  const record = readLoopRecord(root, taskId);
  return record ? supervisor.resume() : supervisor.start();
}

/**
 * Local multi-task daemon: a foreground long-running loop (one per project,
 * enforced by the singleton lock) that polls canonical state and, for every
 * actionable loop-owned task, runs one supervised lead run via the isolated
 * local supervisor. Tasks are served one at a time in updatedAt order, so a
 * long run delays the others until it reaches its next stop. A task that
 * reaches a gate, blocks, completes, or terminates stops being actionable and
 * is skipped on the next poll; a task whose run throws is retried with
 * exponential backoff. Gate approval stays human-only. `signal` stops after the
 * current turn; `cancelSignal` also cancels the in-flight agent turn.
 */
export async function runLocalDaemon({ root: rootInput, agent, workers = {}, workerImages = {}, limits, pollMs = DEFAULT_DAEMON_POLL_MS, signal, cancelSignal, onEvent = () => {}, now = Date.now } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!isLoopProvider(agent)) throw new Error(`local lead agent must be ${LOOP_PROVIDER_LIST}`);
  if (!workers || typeof workers !== "object" || Array.isArray(workers) || !Object.keys(workers).length) throw new Error("Loop requires a configured lead and worker providers");
  for (const [id, provider] of Object.entries(workers)) if (!ID.test(id) || !isLoopProvider(provider)) throw new Error(`invalid local worker: ${id}`);
  const poll = validateDaemonPollMs(pollMs);
  // Fail fast on a bad config.loop.limits instead of failing every task turn.
  if (limits !== undefined) validateLimits(limits);
  const releaseLock = acquireDaemonLock(root);
  try {
    return await daemonLoop({ root, agent, workers, workerImages, limits, poll, signal, cancelSignal, onEvent, now, turn: runTaskTurn });
  } finally { releaseLock(); }
}

/** Poll/run loop. Exported for tests (inject `turn` and `now`). */
export async function daemonLoop({ root, agent, workers, workerImages, limits, poll, signal, cancelSignal, onEvent, now = Date.now, turn = runTaskTurn, isOwned }) {
  const backoff = new Map();
  for (;;) {
    if (signal?.aborted) return { status: "stopped" };
    const state = loadState(root);
    const actionable = actionableTasks(state, root, isOwned ? { isOwned } : {});
    // Forget backoff for tasks that are no longer actionable (e.g. a human
    // paused or approved them), so they start fresh when they come back.
    for (const id of [...backoff.keys()]) if (!actionable.some((task) => task.id === id)) backoff.delete(id);
    onEvent({ type: "daemon_poll", actionable: actionable.map((task) => task.id), ...(backoff.size ? { backingOff: [...backoff.keys()] } : {}) });
    for (const task of actionable) {
      if (signal?.aborted) return { status: "stopped" };
      const delay = backoff.get(task.id);
      if (delay && now() < delay.nextAt) continue;
      // Stamp every event of this run with its task id so the UI can filter.
      const taskEvent = (event) => onEvent(event && typeof event === "object" && !event.taskId ? { ...event, taskId: task.id } : event);
      try {
        const result = await turn({ root, taskId: task.id, agent, workers, workerImages, limits, pollMs: poll, signal, cancelSignal, onEvent: taskEvent });
        backoff.delete(task.id);
        if (result?.status === "gate") onEvent({ type: "gate", taskId: task.id, gate: result.gate, gateView: result.gateView });
        onEvent({ type: "daemon_turn", taskId: task.id, status: result?.status ?? "unknown", ...(result?.gate ? { gate: result.gate } : {}) });
      } catch (error) {
        // A failing task must not take the daemon down; surface it, back off, move on.
        const failures = (backoff.get(task.id)?.failures ?? 0) + 1;
        const retryInMs = backoffDelay(poll, failures);
        backoff.set(task.id, { failures, nextAt: now() + retryInMs });
        onEvent({ type: "daemon_turn_error", taskId: task.id, message: error instanceof Error ? error.message : String(error), failures, retryInMs });
      }
    }
    try { await sleep(poll, undefined, { signal }); }
    catch (error) { if (error?.name === "AbortError") return { status: "stopped" }; throw error; }
  }
}
