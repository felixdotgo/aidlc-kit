import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const digest = (path) => {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe lead artifact file");
  return hash(readFileSync(path));
};
const syncDir = (dir) => { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const hexOrNull = (x) => x === null || (typeof x === "string" && /^[a-f0-9]{64}$/.test(x));
const safeFile = (path) => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe lead artifact journal"); };
function directory(root, id) {
  let cursor = root;
  for (const part of [".agents", "data", "tasks", id]) { cursor = join(cursor, part); const stat = lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe lead artifact directory"); }
  return cursor;
}
/** Read the expected digest for a phase packet while holding the same lock. */
export function leadArtifactDigest({ root, taskId, task, name }) {
  if (!["intent", "design", "workplan"].includes(name) || task.artifacts?.[name] !== `.agents/data/tasks/${taskId}/${name}.md`) throw new Error("Invalid canonical artifact path");
  return digest(join(directory(root, taskId), `${name}.md`));
}
/** Must be called while holding the canonical state lock and supervisor fence. */
export async function recoverLeadArtifact({ root, taskId, task, assertOwned }) {
  let dir;
  try { dir = directory(root, taskId); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const journal = join(dir, ".lead-artifact-journal.json");
  try { safeFile(journal); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  let entry; try { entry = JSON.parse(readFileSync(journal, "utf8")); } catch { throw new Error("Invalid lead artifact journal"); }
  if (!entry || entry.version !== 1 || !["intent", "design", "workplan"].includes(entry.name) || !hexOrNull(entry.before) || typeof entry.after !== "string" || !/^[a-f0-9]{64}$/.test(entry.after) || typeof entry.temp !== "string" || !/^\.lead-artifact-[0-9a-f-]{36}\.tmp$/.test(entry.temp) || task.artifacts?.[entry.name] !== `.agents/data/tasks/${taskId}/${entry.name}.md`) throw new Error("Invalid lead artifact journal");
  const target = join(dir, `${entry.name}.md`), temp = join(dir, entry.temp), current = digest(target);
  if (current !== entry.before && current !== entry.after) throw new Error("Lead artifact journal conflicts with current file; reconcile manually");
  await assertOwned();
  // Once the target contains the after digest the write committed. Otherwise the
  // intent was not committed; discard the temp so the original can be retried.
  try { safeFile(temp); unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  unlinkSync(journal); syncDir(dir);
}
/** Compare the reviewed artifact digest, stage a durable intent, then rename.
 * Recovery never guesses when the target was changed by another writer. */
export async function writeLeadArtifact({ root, taskId, task, operation: op, assertOwned }) {
  const dir = directory(root, taskId);
  if (task.artifacts?.[op.name] !== `.agents/data/tasks/${taskId}/${op.name}.md`) throw new Error("Canonical artifact path is not the expected task path");
  await recoverLeadArtifact({ root, taskId, task, assertOwned });
  const target = join(dir, `${op.name}.md`), before = digest(target);
  if (before !== op.expectedDigest) throw new Error("Stale lead artifact digest");
  const after = hash(Buffer.from(op.content)), name = `.lead-artifact-${randomUUID()}.tmp`, temp = join(dir, name), journal = join(dir, ".lead-artifact-journal.json");
  let fd, journaled = false;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, op.content, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
    await assertOwned();
    fd = openSync(journal, "wx", 0o600); writeFileSync(fd, JSON.stringify({ version: 1, name: op.name, before, after, temp: name }), "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined; journaled = true; syncDir(dir);
    await assertOwned();
    if (digest(target) !== before) throw new Error("Lead artifact changed during commit");
    renameSync(temp, target); syncDir(dir);
    await assertOwned(); unlinkSync(journal); syncDir(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!journaled && existsSync(temp)) unlinkSync(temp);
  }
}
