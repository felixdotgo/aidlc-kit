import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertLoopPath } from "./loop-lease.mjs";
import { validateRoot } from "./loop-runtime.mjs";
import { acquireStateLock, loadTask, nextAction } from "./store.mjs";
import { recoverLeadArtifact } from "./loop-lead-artifacts.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const checkAuthority = (authority) => { if (authority !== "local") throw new Error("local supervisor adapter requires local authority"); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== "ESRCH"; } };
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readLease(path, taskId) {
  try {
    const lease = JSON.parse(readFileSync(path, "utf8"));
    if (lease?.taskId !== taskId || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.token !== "string" || !lease.token) throw new Error("invalid fields");
    return lease;
  } catch (error) { if (error?.code === "ENOENT") return null; throw new Error(`Corrupt supervisor lease for ${taskId}: ${error.message}`); }
}

function writeExclusive(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Local durable checkpoint + separate PID-fenced supervisor lock.
 * The lock uses a distinct task key from the runner's lease so humans can approve.
 * This adapter intentionally does not implement runTurn or perform approvals.
 */
export function createLocalSupervisorAdapter({ root: rootInput, taskId }) {
  const root = validateRoot(rootInput);
  const checkpointPath = assertLoopPath(root, taskId, ".supervisor.json");
  const leasePath = assertLoopPath(root, taskId, ".supervisor.lease");
  const guardPath = assertLoopPath(root, taskId, ".supervisor.guard");
  let token;
  const withGuard = (action) => {
    assertLoopPath(root, taskId, ".supervisor.guard");
    mkdirSync(dirname(guardPath), { recursive: true });
    const guard = { taskId, pid: process.pid, token: randomUUID() }, deadline = Date.now() + 5000;
    for (;;) {
      try { writeExclusive(guardPath, guard); break; }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = readLease(guardPath, taskId);
        if (!existing) continue;
        if (!alive(existing.pid)) { if (readLease(guardPath, taskId)?.token === existing.token) { try { unlinkSync(guardPath); } catch (e) { if (e?.code !== "ENOENT") throw e; } } continue; }
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for supervisor guard: ${taskId}`);
        wait(10);
      }
    }
    try { return action(); } finally { if (readLease(guardPath, taskId)?.token === guard.token) unlinkSync(guardPath); }
  };
  const checkScope = (input) => { checkAuthority(input?.authority); if (input?.taskId !== taskId) throw new Error("supervisor task mismatch"); };
  const assertOwned = async () => {
    assertLoopPath(root, taskId, ".supervisor.lease");
    const current = readLease(leasePath, taskId);
    if (!token || !current || current.token !== token || current.pid !== process.pid) throw new Error("local supervisor ownership lost");
  };
  const readCheckpoint = () => {
    assertLoopPath(root, taskId, ".supervisor.json");
    try {
      const value = JSON.parse(readFileSync(checkpointPath, "utf8"));
      if (!value || value.version !== 1 || value.taskId !== taskId || value.authority !== "local") throw new Error("wrong task or authority");
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Corrupt supervisor checkpoint for ${taskId}: ${error.message}`);
    }
  };
  const syncDir = () => { const dir = openSync(dirname(checkpointPath), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } };
  return {
    async acquireSupervisor(input) {
      checkScope(input);
      if (token) throw new Error("local supervisor adapter is already acquired");
      if (input.signal?.aborted) throw new Error("supervisor already aborted");
      const newToken = randomUUID();
      withGuard(() => {
        assertLoopPath(root, taskId, ".supervisor.lease");
        const existing = readLease(leasePath, taskId);
        if (existing && alive(existing.pid)) throw new Error(`Task ${taskId} already has a live supervisor (pid ${existing.pid})`);
        if (existing && readLease(leasePath, taskId)?.token === existing.token) unlinkSync(leasePath);
        writeExclusive(leasePath, { taskId, pid: process.pid, token: newToken });
      });
      token = newToken;
      return { assertOwned, release: async () => { if (token !== newToken) return; withGuard(() => { if (readLease(leasePath, taskId)?.token === newToken) unlinkSync(leasePath); }); token = undefined; } };
    },
    async readTask(input) {
      checkScope({ ...input, authority: "local" });
      const release = acquireStateLock(root);
      try {
        if (token) await assertOwned();
        const task = loadTask(root, taskId);
        if (!task || task.id !== taskId) throw new Error("invalid local canonical task snapshot");
        if (token) {
          await recoverLeadArtifact({ root, taskId, task, assertOwned });
          await assertOwned();
        } else {
          const journal = join(root, ".agents", "data", "tasks", taskId, ".lead-artifact-journal.json");
          try { lstatSync(journal); throw new Error("Pending lead artifact journal requires supervised recovery"); }
          catch (error) { if (error?.code !== "ENOENT") throw error; }
        }
        return { task, nextAction: nextAction(task, root) };
      } finally { release(); }
    },
    async loadCheckpoint(input) { checkScope(input); await assertOwned(); return readCheckpoint(); },
    async saveCheckpoint(input) {
      checkScope(input); await assertOwned();
      if (!input.checkpoint || input.checkpoint.taskId !== taskId || input.checkpoint.authority !== "local") throw new Error("invalid local checkpoint");
      if (!same(readCheckpoint(), input.previous ?? null)) throw new Error("supervisor checkpoint conflict");
      mkdirSync(dirname(checkpointPath), { recursive: true });
      const temporary = `${checkpointPath}.tmp-${process.pid}-${randomUUID()}`;
      let fd;
      try {
        fd = openSync(temporary, "wx", 0o600); writeFileSync(fd, `${JSON.stringify(input.checkpoint)}\n`); fsyncSync(fd); closeSync(fd); fd = undefined;
        await assertOwned();
        if (!same(readCheckpoint(), input.previous ?? null)) throw new Error("supervisor checkpoint conflict");
        renameSync(temporary, checkpointPath); syncDir();
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    },
    async clearCheckpoint(input) {
      checkScope(input); await assertOwned();
      const current = readCheckpoint();
      if (!same(current, input.checkpoint)) throw new Error("supervisor checkpoint conflict");
      if (current) { unlinkSync(checkpointPath); syncDir(); }
    }
  };
}
