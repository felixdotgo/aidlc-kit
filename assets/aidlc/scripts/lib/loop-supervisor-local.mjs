import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireTaskLease, assertLoopPath } from "./loop-lease.mjs";
import { validateRoot } from "./loop-runtime.mjs";
import { acquireStateLock, loadTask, nextAction } from "./store.mjs";
import { recoverLeadArtifact } from "./loop-lead-artifacts.mjs";

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const checkAuthority = (authority) => { if (authority !== "local") throw new Error("local supervisor adapter requires local authority"); };
/** Local durable checkpoint + the task lease (`loop/<task>.lease`).
 * The supervisor holds the lease with activity "waiting" between runs, so a
 * human can approve gates; the runLoop it drives shares the same handle and
 * flips activity to "turn" while a run executes (see loop-lease.mjs).
 * This adapter intentionally does not implement runTurn or perform approvals.
 */
export function createLocalSupervisorAdapter({ root: rootInput, taskId, onWarning }) {
  const root = validateRoot(rootInput);
  const checkpointPath = assertLoopPath(root, taskId, ".supervisor.json");
  let lease;
  const checkScope = (input) => { checkAuthority(input?.authority); if (input?.taskId !== taskId) throw new Error("supervisor task mismatch"); };
  const assertOwned = async () => {
    if (!lease) throw new Error("local supervisor ownership lost: the task lease is not held");
    try { lease.assertOwned(); }
    catch (error) { throw new Error(`local supervisor ownership lost: ${error.message}`); }
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
      if (lease) throw new Error("local supervisor adapter is already acquired");
      if (input.signal?.aborted) throw new Error("supervisor already aborted");
      const handle = acquireTaskLease(root, taskId, { activity: "waiting", label: "supervisor", purpose: "local loop supervisor", onWarning });
      lease = handle;
      return { assertOwned, release: async () => { if (lease !== handle) return; try { handle.release(); } finally { lease = undefined; } } };
    },
    async readTask(input) {
      checkScope({ ...input, authority: "local" });
      const release = acquireStateLock(root);
      try {
        if (lease) await assertOwned();
        const task = loadTask(root, taskId);
        if (!task || task.id !== taskId) throw new Error("invalid local canonical task snapshot");
        if (lease) {
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
