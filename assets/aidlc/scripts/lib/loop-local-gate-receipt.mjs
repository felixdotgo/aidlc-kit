import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertLoopPath } from "./loop-lease.mjs";
const digest = (x) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const read = (path) => {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16384) throw new Error("Unsafe local gate receipt or checkpoint");
  return JSON.parse(readFileSync(path, "utf8"));
};
export function readLocalGateCheckpoint(root, task) {
  const checkpoint = read(assertLoopPath(root, task.id, ".supervisor.json"));
  if (checkpoint?.version !== 1 || checkpoint.taskId !== task.id || checkpoint.authority !== "local" || checkpoint.gate !== task.gate || checkpoint.phase !== task.phase || checkpoint.taskHash !== digest(task)) throw new Error("Supervisor gate checkpoint does not match current review");
  return checkpoint;
}
/** Host gate process writes only after canonical approval is persisted. A crash
 * in between is intentionally fail-closed and requires manual reconciliation. */
export function writeLocalGateReceipt(root, checkpoint, task, reviewHash) {
  const path = assertLoopPath(root, task.id, ".gate-receipt.json"), temp = `${path}.${randomUUID()}.tmp`;
  if (existsSync(path)) read(path);
  const receipt = { version: 1, taskId: task.id, gate: checkpoint.gate, checkpointHash: digest(checkpoint), taskHash: digest(task), reviewHash };
  let fd;
  try { fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path); const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
export async function verifyLocalGateReceipt({ root, checkpoint, snapshot }) {
  let receipt;
  try { receipt = read(assertLoopPath(root, checkpoint.taskId, ".gate-receipt.json")); } catch { return false; }
  const approved = snapshot?.task;
  const evidence = approved?.evidence?.slice(checkpoint.evidenceCount) ?? [];
  return receipt?.version === 1 && receipt.taskId === checkpoint.taskId && receipt.gate === checkpoint.gate && receipt.checkpointHash === digest(checkpoint) && receipt.taskHash === digest(approved) && typeof receipt.reviewHash === "string" && /^[a-f0-9]{64}$/.test(receipt.reviewHash) && evidence.some((item) => item.kind === "approval" && item.gate === checkpoint.gate && item.result === "pass" && item.source === `Trusted host terminal: approve (${receipt.reviewHash})`);
}
