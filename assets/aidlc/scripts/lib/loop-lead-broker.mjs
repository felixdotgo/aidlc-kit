import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

const LIMIT = 65536;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const validId = (x) => typeof x === "string" && ID.test(x);
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
const text = (x, max) => typeof x === "string" && x.trim().length > 0 && Buffer.byteLength(x) <= max && !x.includes("\0");
const scope = (x) => text(x, 512) && !isAbsolute(x) && !x.includes("\\") && !/[\x00-\x1f]/.test(x) && x.split("/").every((part) => part && part !== "." && part !== ".." && part !== ".git" && part !== ".agents");
export const leadTaskDigest = (task) => createHash("sha256").update(JSON.stringify(task)).digest("hex");

/** Parse an untrusted, bounded model proposal. This schema never admits approval,
 * evidence, execution commands, phase transitions, or arbitrary artifact paths. */
export function parseLeadProposal(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMIT) throw new Error("Invalid or oversized lead proposal");
  let p; try { p = JSON.parse(raw); } catch { throw new Error("Invalid lead proposal JSON"); }
  if (!exact(p, ["version", "taskId", "phase", "taskDigest", "operation"]) || p.version !== 1 || !validId(p.taskId) || !["clarify", "plan"].includes(p.phase) || !/^[a-f0-9]{64}$/.test(p.taskDigest)) throw new Error("Invalid lead proposal envelope");
  const op = p.operation;
  if (op?.kind === "artifact") {
    if (!exact(op, ["kind", "name", "content", "expectedDigest"]) || !({ clarify: ["intent"], plan: ["design", "workplan"] }[p.phase]).includes(op.name) || !text(op.content, 60000) || !(op.expectedDigest === null || (typeof op.expectedDigest === "string" && /^[a-f0-9]{64}$/.test(op.expectedDigest)))) throw new Error("Invalid artifact proposal");
  } else if (op?.kind === "decision") {
    if (p.phase !== "plan" || !exact(op, ["kind", "id", "label", "resolution"]) || !validId(op.id) || !text(op.label, 512) || !text(op.resolution, 4096)) throw new Error("Invalid decision proposal");
  } else if (op?.kind === "item") {
    if (p.phase !== "plan" || !exact(op, ["kind", "id", "label", "dependsOn", "ownedPaths"]) || !validId(op.id) || !text(op.label, 512) || !Array.isArray(op.dependsOn) || op.dependsOn.length > 64 || new Set(op.dependsOn).size !== op.dependsOn.length || !op.dependsOn.every((id) => validId(id) && id !== op.id) || !Array.isArray(op.ownedPaths) || !op.ownedPaths.length || op.ownedPaths.length > 64 || new Set(op.ownedPaths).size !== op.ownedPaths.length || !op.ownedPaths.every(scope)) throw new Error("Invalid item proposal");
  } else throw new Error("Lead operation not allowed");
  return p;
}

/** adapter.withTaskLock MUST hold the canonical lock and supervisor fence through
 * read, validation, one apply, and reading nextAction. The adapter is trusted
 * host code; this module does not expose it to the model or container. */
export async function applyLeadProposal(raw, adapter) {
  const proposal = parseLeadProposal(raw);
  if (typeof adapter?.withTaskLock !== "function") throw new Error("Atomic fenced broker adapter required");
  return adapter.withTaskLock(proposal.taskId, async (tx) => {
    if (typeof tx?.assertOwned !== "function" || typeof tx?.readTask !== "function" || typeof tx?.nextAction !== "function" || typeof tx?.applyOne !== "function") throw new Error("Incomplete fenced broker transaction");
    await tx.assertOwned();
    const task = await tx.readTask();
    if (!task || task.id !== proposal.taskId || task.status !== "active" || task.phase !== proposal.phase || leadTaskDigest(task) !== proposal.taskDigest) throw new Error("Stale lead proposal");
    const action = await tx.nextAction(task);
    if (action?.classification !== "run_phase" || action.phase !== proposal.phase) throw new Error("Task is not actionable in proposed phase");
    if (proposal.operation.kind === "item") {
      const known = new Set(task.tasks.map((item) => item.id));
      if (proposal.operation.dependsOn.some((id) => !known.has(id))) throw new Error("Unknown item dependency");
      if (known.has(proposal.operation.id)) throw new Error("Item already exists");
    }
    await tx.assertOwned();
    await tx.applyOne(proposal.operation);
    await tx.assertOwned();
    return tx.nextAction(await tx.readTask());
  });
}
