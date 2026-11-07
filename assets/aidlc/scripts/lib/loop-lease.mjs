import { lstatSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireHolder, clearStaleHolder, describeHolder, GUARD_STALE_MS, LEASE_TTL_MS, readHolder } from "./loop-holder.mjs";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function assertLoopPath(root, taskId, suffix = ".json") {
  if (!idPattern.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const base = resolve(root);
  let cursor = base;
  for (const part of [".agents", "data", "loop", `${taskId}${suffix}`]) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Loop path crosses a symlink: ${cursor}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return cursor;
}

export const loopLeasePath = (root, taskId) => assertLoopPath(root, taskId, ".lease");

// Task lease handles held by this process, so a supervisor's lease is shared
// with the runLoop it drives instead of being acquired twice.
const held = new Map();
const heldKey = (root, taskId) => `${resolve(root)}\0${taskId}`;

function checkScope(entry, taskId) {
  const holder = entry.holder;
  if (!holder) return;
  const scope = entry.version === 2 ? holder.scope : holder.taskId ? `task:${holder.taskId}` : null;
  if (scope && scope !== `task:${taskId}`) throw new Error(`Conflicting loop lease in ${entry.path}: ${scope}`);
}

/** Inspect the task lease (`loop/<task>.lease`) without changing it; see
 * `readHolder` in loop-holder.mjs. */
export function readTaskLease(root, taskId) {
  const entry = readHolder(loopLeasePath(root, taskId), { ttlMs: LEASE_TTL_MS });
  checkScope(entry, taskId);
  return entry;
}

/** The live task lease holder while a loop turn runs (activity "turn"), else
 * null. A supervisor waiting at a human gate (activity "waiting") does not
 * count, so gate approval stays available. A v1 runner lease counts when its
 * pid is alive. A corrupt lease fails closed. */
export function readLiveLease(root, taskId) {
  const entry = readTaskLease(root, taskId);
  if (entry.state === "corrupt") throw new Error(`Corrupt loop lease: ${describeHolder(entry)}`);
  if (entry.state !== "live") return null;
  if (entry.version === 2 && entry.holder.activity !== "turn") return null;
  return entry.holder;
}

// Older versions kept a separate `<task>.supervisor.lease` (+ `.supervisor.guard`).
function migrateLegacySupervisorLease(root, taskId) {
  const legacy = assertLoopPath(root, taskId, ".supervisor.lease");
  const entry = readHolder(legacy, { ttlMs: LEASE_TTL_MS });
  if (entry.state === "live") throw new Error(`A loop from a previous aidlc-kit version is still running for ${taskId} (pid ${entry.holder.pid}, ${legacy}); stop the loop daemon and any \`loop start\` before upgrading, then retry`);
  if (entry.state !== "absent") {
    const cleared = clearStaleHolder(legacy, { ttlMs: LEASE_TTL_MS });
    if (!cleared && readHolder(legacy, { ttlMs: LEASE_TTL_MS }).state !== "absent") throw new Error(`${describeHolder(entry)} (legacy supervisor lease)`);
  }
  const legacyGuard = assertLoopPath(root, taskId, ".supervisor.guard");
  try { if (Date.now() - lstatSync(legacyGuard).mtimeMs > GUARD_STALE_MS) unlinkSync(legacyGuard); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

/** Acquire the task lease. `activity` is "waiting" (supervisor between runs,
 * human may approve gates) or "turn" (a loop run is executing; gate approval is
 * refused). `label` names the caller in the busy error. Returns the holder
 * handle (`assertOwned`, `setActivity`, `heartbeat`, `release`). */
export function acquireTaskLease(root, taskId, { activity = "waiting", label = "loop", purpose = `loop ${activity}`, onWarning } = {}) {
  const path = loopLeasePath(root, taskId);
  const key = heldKey(root, taskId);
  if (held.has(key)) throw new Error(`Task ${taskId} already has a live ${label} in this process: ${describeHolder(readTaskLease(root, taskId))}`);
  migrateLegacySupervisorLease(root, taskId);
  const handle = acquireHolder({
    path, kind: "lease", scope: `task:${taskId}`, activity, purpose, onWarning,
    busyMessage: (entry) => `Task ${taskId} already has a live ${label} (pid ${entry.holder.pid}): ${describeHolder(entry)}`,
  });
  const release = handle.release;
  handle.release = () => { if (held.get(key) === handle) held.delete(key); release(); };
  held.set(key, handle);
  return handle;
}

/** The task lease handle this process already holds, or null. */
export function heldTaskLease(root, taskId) {
  return held.get(heldKey(root, taskId)) ?? null;
}

/** Compatibility wrapper: acquire the task lease for a loop run (activity
 * "turn") and return its release function. */
export function acquireLoopLease(root, taskId, runId) {
  const handle = acquireTaskLease(root, taskId, { activity: "turn", label: "loop runner", purpose: `loop run ${runId}` });
  return () => handle.release();
}
