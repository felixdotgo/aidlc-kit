import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const states = new Set(["leased", "reported", "uncertain", "integrated", "released"]);
const safeId = (value, label) => { if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`Invalid ${label}`); return value; };
const iso = () => new Date().toISOString();
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function assignmentPath(root, taskId, suffix = ".json") {
  safeId(taskId, "task id");
  let path = resolve(root);
  for (const part of [".agents", "data", "loop", "assignments", `${taskId}${suffix}`]) {
    path = join(path, part);
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Assignment path crosses symlink: ${path}`); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return path;
}

function read(root, taskId) {
  const path = assignmentPath(root, taskId);
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

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function locked(root, taskId, action) {
  const path = assignmentPath(root, taskId, ".lock");
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
      finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error(`Corrupt assignment lock for ${taskId}; inspect before retry`); }
      if (!Number.isSafeInteger(owner.pid) || typeof owner.token !== "string") throw new Error(`Corrupt assignment lock for ${taskId}`);
      if (!alive(owner.pid)) {
        const current = JSON.parse(readFileSync(path, "utf8"));
        if (current.token === owner.token) unlinkSync(path);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for assignment lock: ${taskId}`);
      wait(10);
    }
  }
  try { return action(); }
  finally {
    const current = JSON.parse(readFileSync(path, "utf8"));
    if (current.token === token) unlinkSync(path);
  }
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

export function showLocalAssignments(root, taskId) {
  return read(root, safeId(taskId, "task id"));
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
    if (active.some((entry) => entry.itemId === itemId && entry.state === "leased")) throw new Error(`Item already leased: ${itemId}`);
    if (value.assignments.some((entry) => entry.itemId === itemId && ["reported", "uncertain"].includes(entry.state))) throw new Error(`Item has unresolved assignment; reconcile before retry: ${itemId}`);
    for (const other of active) for (const path of ownedPaths) for (const prior of other.ownedPaths) if (path === prior || path.startsWith(`${prior}/`) || prior.startsWith(`${path}/`)) throw new Error(`Owned path overlaps active assignment: ${path}`);
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
    if (!item || item.state !== "leased") throw new Error("Assignment is not leased");
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
    if (!item || item.state !== "leased") throw new Error("Assignment is not leased; reconcile before reporting");
    for (const path of changedPaths) if (!item.ownedPaths.some((owned) => path === owned || path.startsWith(`${owned}/`))) throw new Error(`Changed path is outside assignment scope: ${path}`);
    item.state = "reported"; item.checkpoint = checkpoint; item.commit = commit; item.changedPaths = changedPaths; item.updatedAt = iso(); write(root, taskId, value); return item;
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
