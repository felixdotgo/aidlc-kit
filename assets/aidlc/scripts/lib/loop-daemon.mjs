import { lstatSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { requireLocalAuthority } from "./authority.mjs";
import { isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";
import { acquireHolder, describeHolder, LEASE_TTL_MS, readHolder } from "./loop-holder.mjs";
import { validateLimits, validateRoot, readLoopRecord } from "./loop-runtime.mjs";
import { createIsolatedLocalSupervisor } from "./loop-supervisor-run-local.mjs";
import { loadState, nextAction } from "./store.mjs";
import { resolveTaskRuntimeRead } from "./task-runtime.mjs";
import { migrateAllTaskRuntime } from "./task-runtime-migrate.mjs";

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
 * dashboard: `.agents/data/tasks/<id>/runtime/intake.json`) or already has a loop
 * run record. Tasks created by an interactive lead are not loop-owned, so the
 * daemon never runs them concurrently with that lead. */
export function isLoopOwned(root, taskId) {
  if (!ID.test(taskId ?? "")) return false;
  try { if (lstatSync(resolveTaskRuntimeRead(root, taskId, "intake.json")).isFile()) return true; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return readLoopRecord(root, taskId) !== null;
}

/** Path of the singleton daemon lock (one local daemon per project root). */
export const daemonLockPath = (root) => join(root, ".agents", "data", "loop", "daemon.lock");

/** Read the daemon lease: `null` when absent, otherwise `{ pid, startedAt,
 * alive, state, holder }` where `state` is live|stale|corrupt (see
 * `loop-holder.mjs`). `pid`/`startedAt` stay top-level for the web UI. */
export function readDaemonLock(root) {
  const entry = readHolder(daemonLockPath(root), { ttlMs: LEASE_TTL_MS });
  if (entry.state === "absent") return null;
  if (entry.state === "corrupt") return { pid: null, startedAt: null, alive: false, state: "corrupt", holder: null };
  const { holder } = entry;
  return { pid: holder.pid, startedAt: holder.startedAt ?? null, alive: entry.state === "live", state: entry.state, holder };
}

/** Acquire the singleton daemon lease (`loop/daemon.lock`, kind lease, scope
 * daemon, 60s TTL renewed every 15s). A stale holder (expired, or its pid is
 * gone on this host) or an old corrupt file is reclaimed under the holder
 * guard; a live owner or a recent corrupt file fails closed with the holder
 * details and the `leases` command. Returns a release function. */
export function acquireDaemonLock(root, { onWarning = () => {}, onLost } = {}) {
  const path = daemonLockPath(root);
  const handle = acquireHolder({
    path, kind: "lease", scope: "daemon", purpose: "loop daemon (one per project root)", onWarning, onLost,
    busyMessage: (entry) => `Loop daemon already running (pid ${entry.holder.pid}): ${describeHolder(entry)}`,
  });
  return () => handle.release();
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

/** Move pre-runtime per-task files under `runtime/` once at daemon start; one
 * diagnostic summarises the result, nothing when there was nothing to move. */
function migrateTaskRuntimeOnStart(root, onEvent) {
  let result;
  try { result = migrateAllTaskRuntime(root); }
  catch (error) { onEvent({ type: "diagnostic", message: `Task runtime migration failed: ${error.message}` }); return; }
  if (result.moved || result.skipped) onEvent({ type: "diagnostic", message: `Task runtime migration: moved ${result.moved} file(s) under .agents/data/tasks/<id>/runtime/, skipped ${result.skipped} (run loop-entry.mjs migrate-data --dry-run --json for details)` });
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
/**
 * Shared loop daemon (local and fleet): the same singleton lock, round-robin,
 * backoff, two-stage shutdown, and taskId-stamped events over a loop authority
 * from `loop-authority.mjs` (`listActionable` + `runTask`). The authority alone
 * decides which tasks are loop-owned and how one bounded run executes.
 */
export async function runLoopDaemon({ root: rootInput, authority, pollMs = DEFAULT_DAEMON_POLL_MS, signal, cancelSignal, onEvent = () => {}, now = Date.now } = {}) {
  const root = validateRoot(rootInput);
  if (!authority || typeof authority.listActionable !== "function" || typeof authority.runTask !== "function") throw new Error("Loop daemon requires a loop authority");
  const poll = validateDaemonPollMs(pollMs);
  const lost = new AbortController();
  const releaseLock = acquireDaemonLock(root, { onWarning: onEvent, onLost: (reason) => { onEvent({ type: "daemon_lease_lost", message: `Daemon lease lost; stopping after the current turn: ${reason}` }); lost.abort(); } });
  try {
    onEvent({ type: "daemon_start", authority: authority.mode ?? "unknown", pid: process.pid });
    migrateTaskRuntimeOnStart(root, onEvent);
    return await daemonLoop({ root, poll, signal: signal ? AbortSignal.any([signal, lost.signal]) : lost.signal, cancelSignal, onEvent, now, listActionable: () => authority.listActionable(), turn: ({ taskId, signal: runSignal, cancelSignal: runCancel, onEvent: runEvent }) => authority.runTask({ taskId, signal: runSignal, cancelSignal: runCancel, onEvent: runEvent }) });
  } finally { releaseLock(); }
}

export async function runLocalDaemon({ root: rootInput, agent, workers = {}, workerImages = {}, limits, pollMs = DEFAULT_DAEMON_POLL_MS, signal, cancelSignal, onEvent = () => {}, now = Date.now } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!isLoopProvider(agent)) throw new Error(`local lead agent must be ${LOOP_PROVIDER_LIST}`);
  if (!workers || typeof workers !== "object" || Array.isArray(workers) || !Object.keys(workers).length) throw new Error("Loop requires a configured lead and worker providers");
  for (const [id, provider] of Object.entries(workers)) if (!ID.test(id) || !isLoopProvider(provider)) throw new Error(`invalid local worker: ${id}`);
  const poll = validateDaemonPollMs(pollMs);
  // Fail fast on a bad config.loop.limits instead of failing every task turn.
  if (limits !== undefined) validateLimits(limits);
  const lost = new AbortController();
  const releaseLock = acquireDaemonLock(root, { onWarning: onEvent, onLost: (reason) => { onEvent({ type: "daemon_lease_lost", message: `Daemon lease lost; stopping after the current turn: ${reason}` }); lost.abort(); } });
  try {
    migrateTaskRuntimeOnStart(root, onEvent);
    return await daemonLoop({ root, agent, workers, workerImages, limits, poll, signal: signal ? AbortSignal.any([signal, lost.signal]) : lost.signal, cancelSignal, onEvent, now, turn: runTaskTurn });
  } finally { releaseLock(); }
}

/** Run results that leave the task actionable without progress; retried with backoff like errors. */
const RETRY_STATUSES = new Set(["blocked", "reconcile"]);

/** Poll/run loop. Exported for tests (inject `turn`, `now`, and optionally `listActionable`). */
export async function daemonLoop({ root, agent, workers, workerImages, limits, poll, signal, cancelSignal, onEvent, now = Date.now, turn = runTaskTurn, isOwned, listActionable }) {
  const backoff = new Map();
  let lastPollKey = null; // null forces the next successful poll to be emitted
  for (;;) {
    if (signal?.aborted) return { status: "stopped" };
    let actionable;
    try { actionable = listActionable ? await listActionable() : actionableTasks(loadState(root), root, isOwned ? { isOwned } : {}); }
    catch (error) {
      lastPollKey = null;
      // An unreachable authority (e.g. the fleet service) must not stop the daemon.
      onEvent({ type: "daemon_poll_error", message: error instanceof Error ? error.message : String(error) });
      try { await sleep(poll, undefined, { signal }); } catch (sleepError) { if (sleepError?.name === "AbortError") return { status: "stopped" }; throw sleepError; }
      continue;
    }
    // Forget backoff for tasks that are no longer actionable (e.g. a human
    // paused or approved them), so they start fresh when they come back.
    for (const id of [...backoff.keys()]) if (!actionable.some((task) => task.id === id)) backoff.delete(id);
    // Emit a poll only when it carries news: the first poll, the first poll
    // after a poll error (that clears the dashboard's poll error), or a change
    // in the actionable or backing-off sets (that clears stale turn errors).
    const pollKey = JSON.stringify([actionable.map((task) => task.id).sort(), [...backoff.keys()].sort()]);
    if (pollKey !== lastPollKey) {
      onEvent({ type: "daemon_poll", actionable: actionable.map((task) => task.id), ...(backoff.size ? { backingOff: [...backoff.keys()] } : {}) });
      lastPollKey = pollKey;
    }
    for (const task of actionable) {
      if (signal?.aborted) return { status: "stopped" };
      const delay = backoff.get(task.id);
      if (delay && now() < delay.nextAt) continue;
      // Stamp every event of this run with its task id so the UI can filter.
      const taskEvent = (event) => onEvent(event && typeof event === "object" && !event.taskId ? { ...event, taskId: task.id } : event);
      try {
        const result = await turn({ root, taskId: task.id, agent, workers, workerImages, limits, pollMs: poll, signal, cancelSignal, onEvent: taskEvent });
        if (result?.status === "gate" && !result.gateEmitted) onEvent({ type: "gate", taskId: task.id, gate: result.gate, gateView: result.gateView });
        onEvent({ type: "daemon_turn", taskId: task.id, status: result?.status ?? "unknown", ...(result?.gate ? { gate: result.gate } : {}), ...(result?.reason ? { reason: result.reason } : {}) });
        if (RETRY_STATUSES.has(result?.status)) {
          const failures = (backoff.get(task.id)?.failures ?? 0) + 1;
          backoff.set(task.id, { failures, nextAt: now() + backoffDelay(poll, failures) });
        } else backoff.delete(task.id);
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
