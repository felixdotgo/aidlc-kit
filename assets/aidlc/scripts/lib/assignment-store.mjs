import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireHolder, describeHolder } from "./loop-holder.mjs";
import { resolveTaskRuntimeRead, taskRuntimePath } from "./task-runtime.mjs";
import { migrateTaskRuntime } from "./task-runtime-migrate.mjs";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const states = new Set(["leased", "reported", "uncertain", "integrated", "released"]);
const safeId = (value, label) => { if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`Invalid ${label}`); return value; };
const iso = () => new Date().toISOString();

/** Write location of the task's assignment records
 * (`.agents/data/tasks/<task>/runtime/assignments.json`; `.lock` for the mutex),
 * refusing symlinked path components. */
export function assignmentPath(root, taskId, suffix = ".json") {
  safeId(taskId, "task id");
  if (![".json", ".lock"].includes(suffix)) throw new Error(`Unknown assignment file suffix: ${suffix}`);
  return taskRuntimePath(root, taskId, suffix === ".lock" ? "assignments.lock" : "assignments.json");
}

/** Read location: the runtime file, else the pre-runtime
 * `.agents/data/loop/assignments/<task>.json` until it has been migrated. */
export const assignmentReadPath = (root, taskId) => resolveTaskRuntimeRead(root, safeId(taskId, "task id"), "assignments.json");

function read(root, taskId) {
  const path = assignmentReadPath(root, taskId);
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, taskId, assignments: [] };
    throw new Error(`Corrupt local assignments for ${taskId}: ${error.message}`);
  }
  if (value?.schemaVersion !== 1 || value.taskId !== taskId || !Array.isArray(value.assignments)) throw new Error(`Corrupt local assignments for ${taskId}`);
  for (const item of value.assignments) {
    if (!item || typeof item.id !== "string" || !item.id || !idPattern.test(item.itemId) || !idPattern.test(item.workerId) || !states.has(item.state) || !Number.isSafeInteger(item.attempt) || item.attempt < 1 || !Array.isArray(item.ownedPaths) || item.ownedPaths.length > 64 || !item.ownedPaths.every(safeOwnedPath) || typeof item.leaseExpiresAt !== "string" || Number.isNaN(Date.parse(item.leaseExpiresAt))) throw new Error(`Corrupt local assignments for ${taskId}`);
  }
  return value;
}

function safeOwnedPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 300 && path !== "." && !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\") && !path.includes("\0");
}

function write(root, taskId, value) {
  const path = assignmentPath(root, taskId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

/** Short mutex around one read-modify-write of `assignments/<task>.json`
 * (kind lock, 30s TTL, no heartbeat). Waits up to 5s for another holder. */
function locked(root, taskId, action) {
  // A legacy record moves under runtime/ before the first write, so the
  // writer never has to choose between two locations.
  migrateTaskRuntime(root, taskId, { names: ["assignments.json"] });
  const path = assignmentPath(root, taskId, ".lock");
  const handle = acquireHolder({
    path, kind: "lock", scope: `assignments:${taskId}`, purpose: "assignment read-modify-write", waitMs: 5000,
    busyMessage: (entry) => `Timed out waiting for assignment lock: ${taskId}: ${describeHolder(entry)}`,
  });
  try { return action(); }
  finally {
    // A release failure must not mask the committed write; the lock then
    // expires on its own after its 30s TTL.
    try { handle.release(); } catch { /* expires via TTL */ }
  }
}

/** User-facing labels for the persisted assignment (claim) states. */
export const ASSIGNMENT_STATE_LABELS = Object.freeze({
  leased: "claim held",
  expired: "claim expired; needs reconcile",
  uncertain: "expired or outcome unknown; needs reconcile",
  reported: "worker reported; awaiting integration",
  integrated: "integrated",
  released: "released",
});

/** Display state computed at read time: a `leased` claim past its
 * leaseExpiresAt shows as `expired` (mutations persist it as `uncertain`). */
export function effectiveAssignmentState(assignment, now = Date.now()) {
  return assignment.state === "leased" && Date.parse(assignment.leaseExpiresAt) <= now ? "expired" : assignment.state;
}

const reconcileCommand = (taskId) => `node .agents/aidlc/scripts/assignment.mjs reconcile ${taskId}`;
const releaseCommand = (taskId, id) => `node .agents/aidlc/scripts/assignment.mjs release ${taskId} ${id}`;

/** One-line description of a claim: id, item, worker, paths, state, expiry. */
export function describeAssignment(assignment, now = Date.now()) {
  const state = effectiveAssignmentState(assignment, now);
  return `assignment ${assignment.id} (item ${assignment.itemId}, worker ${assignment.workerId}, paths ${(assignment.ownedPaths ?? []).join(", ")}, state ${state}: ${ASSIGNMENT_STATE_LABELS[state] ?? state}, claim expires ${assignment.leaseExpiresAt})`;
}

/** Remedy commands for a blocking claim. */
export function assignmentRemedy(taskId, assignment, now = Date.now()) {
  const release = `${releaseCommand(taskId, assignment.id)} to drop the claim (discards the worker's unintegrated result)`;
  const state = effectiveAssignmentState(assignment, now);
  if (state === "leased") return `wait for the worker to report or for the claim to expire; if the worker is gone, run ${release}`;
  if (state === "expired" || state === "uncertain") return `the claim expired or its outcome is unknown: run ${reconcileCommand(taskId)} (marks it integrated if the item is done); if the item is not done and the worker is gone, run ${release}`;
  return `run ${reconcileCommand(taskId)} once the item is done in canonical state; or run ${release}`;
}

const blockedBy = (taskId, assignment) => `${describeAssignment(assignment)}; ${assignmentRemedy(taskId, assignment)}`;

function notLeased(taskId, assignmentId, item, suffix = "") {
  if (!item) return new Error(`Assignment is not leased${suffix}: assignment ${assignmentId} does not exist for ${taskId}; inspect: node .agents/aidlc/scripts/assignment.mjs show ${taskId}`);
  return new Error(`Assignment is not leased${suffix}: ${describeAssignment(item)}; run ${reconcileCommand(taskId)}`);
}

function canonical(root, taskId) {
  const raw = execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "show", taskId, "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(raw);
  if (result?.ok !== true || result.result?.id !== taskId) throw new Error(`Unknown canonical task: ${taskId}`);
  return result.result;
}

function expire(value, now) {
  for (const assignment of value.assignments) if (assignment.state === "leased" && Date.parse(assignment.leaseExpiresAt) <= now) {
    assignment.state = "uncertain";
    assignment.updatedAt = iso();
  }
}

/** Read-only view: each assignment gains `effectiveState` and `stateLabel`
 * (an overdue `leased` claim shows as `expired`); nothing is written. */
export function showLocalAssignments(root, taskId) {
  const value = read(root, safeId(taskId, "task id"));
  const now = Date.now();
  return { ...value, assignments: value.assignments.map((assignment) => { const effectiveState = effectiveAssignmentState(assignment, now); return { ...assignment, effectiveState, stateLabel: ASSIGNMENT_STATE_LABELS[effectiveState] ?? effectiveState }; }) };
}

export function claimLocalAssignment(root, { taskId, itemId, workerId, ownedPaths, leaseMs = 300000, baseCommit = null, branch = null, sessionId = null }) {
  safeId(taskId, "task id"); safeId(itemId, "item id"); safeId(workerId, "worker id");
  if (!Array.isArray(ownedPaths) || ownedPaths.length < 1 || ownedPaths.length > 64 || !ownedPaths.every(safeOwnedPath)) throw new Error("ownedPaths must contain safe relative paths");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error("leaseMs must be 1000..3600000");
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId || sessionId.length > 300)) throw new Error("Invalid sessionId");
  const task = canonical(root, taskId);
  const item = task.tasks?.find((entry) => entry.id === itemId);
  if (!item || !["todo", "in_progress"].includes(item.status) || task.phase !== "build" || task.status !== "active") throw new Error(`Canonical item is not dispatchable: ${taskId}/${itemId}`);
  for (const prerequisite of item.dependsOn ?? []) if (task.tasks.find((entry) => entry.id === prerequisite)?.status !== "done") throw new Error(`Item prerequisite is not done: ${prerequisite}`);
  return locked(root, taskId, () => {
    const value = read(root, taskId); expire(value, Date.now());
    const active = value.assignments.filter((entry) => ["leased", "reported", "uncertain"].includes(entry.state));
    const leased = active.find((entry) => entry.itemId === itemId && entry.state === "leased");
    if (leased) throw new Error(`Item already leased: ${itemId}: claimed by ${blockedBy(taskId, leased)}`);
    const unresolved = value.assignments.find((entry) => entry.itemId === itemId && ["reported", "uncertain"].includes(entry.state));
    if (unresolved) throw new Error(`Item has unresolved assignment; reconcile before retry: ${itemId}: ${blockedBy(taskId, unresolved)}`);
    for (const other of active) for (const path of ownedPaths) for (const prior of other.ownedPaths) if (path === prior || path.startsWith(`${prior}/`) || prior.startsWith(`${path}/`)) throw new Error(`Owned path overlaps active assignment: ${path}: held by ${blockedBy(taskId, other)}`);
    const attempt = 1 + Math.max(0, ...value.assignments.filter((entry) => entry.itemId === itemId).map((entry) => entry.attempt));
    const assignment = { id: randomUUID(), taskId, itemId, workerId, ownedPaths, attempt, baseCommit, branch, sessionId, checkpoint: null, state: "leased", leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(), idempotencyKey: randomUUID(), createdAt: iso(), updatedAt: iso() };
    value.assignments.push(assignment); write(root, taskId, value);
    return assignment;
  });
}

export function heartbeatLocalAssignment(root, taskId, assignmentId, leaseMs = 300000, sessionId) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw new Error("leaseMs must be 1000..3600000");
  return locked(root, taskId, () => {
    const value = read(root, taskId); expire(value, Date.now());
    const item = value.assignments.find((entry) => entry.id === assignmentId);
    if (!item || item.state !== "leased") throw notLeased(taskId, assignmentId, item);
    if (sessionId !== undefined) { if (typeof sessionId !== "string" || !sessionId || sessionId.length > 300) throw new Error("Invalid sessionId"); item.sessionId = sessionId; }
    item.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString(); item.updatedAt = iso(); write(root, taskId, value); return item;
  });
}

export function reportLocalAssignment(root, taskId, assignmentId, { checkpoint = null, commit = null, changedPaths = [] } = {}) {
  if (checkpoint !== null && (typeof checkpoint !== "string" || checkpoint.length > 2000)) throw new Error("Invalid checkpoint");
  if (commit !== null && (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit))) throw new Error("Invalid commit");
  if (!Array.isArray(changedPaths) || changedPaths.length > 128 || !changedPaths.every(safeOwnedPath)) throw new Error("Invalid changedPaths");
  return locked(root, taskId, () => {
    const value = read(root, taskId); expire(value, Date.now());
    const item = value.assignments.find((entry) => entry.id === assignmentId);
    if (!item || item.state !== "leased") throw notLeased(taskId, assignmentId, item, "; reconcile before reporting");
    for (const path of changedPaths) if (!item.ownedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`))) throw new Error(`Changed path is outside assignment scope: ${path}`);
    item.state = "reported"; item.checkpoint = checkpoint; item.commit = commit; item.changedPaths = changedPaths; item.updatedAt = iso(); write(root, taskId, value); return item;
  });
}

/** Record the integration-branch commit created for a reported assignment, so
 * the dashboard can show exactly what the item changed. It never changes the
 * assignment state; `reconcile` still marks the item integrated. */
export function recordLocalIntegration(root, taskId, assignmentId, integrationCommit) {
  safeId(taskId, "task id");
  if (typeof integrationCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(integrationCommit)) throw new Error("Invalid integration commit");
  return locked(root, taskId, () => {
    const value = read(root, taskId);
    const item = value.assignments.find((entry) => entry.id === assignmentId);
    if (!item || !["reported", "integrated"].includes(item.state)) throw new Error("Only a reported or integrated assignment can record its integration commit");
    item.integrationCommit = integrationCommit; item.updatedAt = iso(); write(root, taskId, value); return item;
  });
}

export function reconcileLocalAssignments(root, taskId) {
  const task = canonical(root, taskId);
  return locked(root, taskId, () => {
    const value = read(root, taskId); expire(value, Date.now());
    for (const item of value.assignments) {
      const canonicalItem = task.tasks?.find((entry) => entry.id === item.itemId);
      if (canonicalItem?.status === "done" && item.state !== "integrated") { item.state = "integrated"; item.updatedAt = iso(); }
      else if (!canonicalItem && item.state === "leased") { item.state = "uncertain"; item.updatedAt = iso(); }
    }
    write(root, taskId, value);
    return value;
  });
}

export function releaseLocalAssignment(root, taskId, assignmentId) {
  return locked(root, taskId, () => {
    const value = read(root, taskId); const item = value.assignments.find((entry) => entry.id === assignmentId);
    if (!item || !["leased", "reported", "uncertain"].includes(item.state)) throw new Error("Assignment cannot be released");
    item.state = "released"; item.updatedAt = iso(); write(root, taskId, value); return item;
  });
}
