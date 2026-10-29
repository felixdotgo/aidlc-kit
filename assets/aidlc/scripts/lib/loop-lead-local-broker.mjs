import { resolve } from "node:path";
import { acquireStateLock, loadState, nextAction, readyTaskItems, saveState } from "./store.mjs";
import { requireLocalAuthority } from "./authority.mjs";
import { recoverLeadArtifact, writeLeadArtifact } from "./loop-lead-artifacts.mjs";

/** Create a trusted host-only adapter. assertOwned comes directly from the live
 * supervisor lease and must remain valid throughout the transaction. */
export function createLocalLeadBrokerAdapter({ root: inputRoot, taskId, assertOwned }) {
  const root = resolve(inputRoot);
  if (typeof assertOwned !== "function" || typeof taskId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Local broker requires a live supervisor fence and task ID");
  return { async withTaskLock(id, run) {
    requireLocalAuthority();
    if (id !== taskId || typeof run !== "function") throw new Error("Broker task mismatch");
    await assertOwned();
    const release = acquireStateLock(root);
    try {
      await assertOwned();
      const state = loadState(root), task = state.tasks[taskId];
      if (!task) throw new Error("Unknown active broker task");
      await recoverLeadArtifact({ root, taskId, task, assertOwned });
      let applied = false;
      return await run({
        assertOwned,
        readTask: async () => task,
        nextAction: async (value) => nextAction(value, root),
        applyOne: async (op) => {
          if (applied) throw new Error("Broker permits only one mutation per transaction");
          applied = true; await assertOwned();
          if (op.kind === "artifact") {
            await writeLeadArtifact({ root, taskId, task, operation: op, assertOwned });
          } else if (op.kind === "decision") {
            if (task.decisions.some((entry) => entry.id === op.id)) throw new Error("Decision already exists; broker cannot overwrite human decisions");
            task.decisions.push({ id: op.id, label: op.label, status: "unresolved", resolution: op.resolution });
            task.updatedAt = new Date().toISOString(); await assertOwned(); saveState(root, state);
          } else if (op.kind === "item") {
            if (task.tasks.some((entry) => entry.id === op.id)) throw new Error("Item already exists");
            task.tasks.push({ id: op.id, label: op.label, status: "todo", dependsOn: op.dependsOn, ownedPaths: op.ownedPaths });
            readyTaskItems(task); task.updatedAt = new Date().toISOString(); await assertOwned(); saveState(root, state);
          } else throw new Error("Broker operation not allowed");
        }
      });
    } finally { release(); }
  } };
}
