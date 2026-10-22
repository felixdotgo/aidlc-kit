import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
const guardPath = (root, taskId) => assertLoopPath(root, taskId, ".lease.guard");

function parseLease(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Corrupt loop lease: ${path}: ${error.message}`); }
  if (!value || value.schemaVersion !== 1 || !idPattern.test(value.taskId) || typeof value.runId !== "string" || !value.runId || !Number.isInteger(value.pid) || value.pid < 1 || typeof value.token !== "string" || !value.token || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw new Error(`Corrupt loop lease: ${path}`);
  return value;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; return true; }
}

function withGuard(root, taskId, action) {
  const path = guardPath(root, taskId);
  mkdirSync(dirname(path), { recursive: true });
  const guard = { schemaVersion: 1, taskId, runId: "guard", pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(guard)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = parseLease(path);
      if (current.taskId !== taskId) throw new Error(`Conflicting loop lease guard: ${path}`);
      if (!alive(current.pid)) { try { if (parseLease(path).token === current.token) unlinkSync(path); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; } continue; }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for loop lease guard: ${taskId}`);
      sleep(10);
    }
  }
  try { return action(); }
  finally { if (parseLease(path).token === guard.token) unlinkSync(path); }
}

export function readLiveLease(root, taskId) {
  const path = loopLeasePath(root, taskId);
  try { lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const lease = parseLease(path);
  if (lease.taskId !== taskId) throw new Error(`Conflicting loop lease: ${path}`);
  return alive(lease.pid) ? lease : null;
}

export function acquireLoopLease(root, taskId, runId) {
  const path = loopLeasePath(root, taskId);
  mkdirSync(dirname(path), { recursive: true });
  const lease = { schemaVersion: 1, taskId, runId, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  return withGuard(root, taskId, () => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify(lease)}\n`); fsyncSync(fd); }
      finally { closeSync(fd); }
      return () => withGuard(root, taskId, () => { try { if (parseLease(path).token === lease.token) unlinkSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; } });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = parseLease(path);
      if (existing.taskId !== taskId) throw new Error(`Conflicting loop lease: ${path}`);
      if (alive(existing.pid)) throw new Error(`Task ${taskId} already has a live loop runner (pid ${existing.pid})`);
      // A dead owner may be reclaimed. A competing reclaimer may win; retry with wx.
      try { if (parseLease(path).token === existing.token) unlinkSync(path); }
      catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    }
  }
  throw new Error(`Could not acquire loop lease for ${taskId}`);
  });
}
