import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Prepare a durable, idempotent intake without treating it as lifecycle state. */
export async function prepareLoopIntake({ root, taskId, requirement, authority, createTask, readTask }) {
  if (!ID.test(taskId ?? "")) throw new Error("Invalid task ID");
  if (!["local", "fleet"].includes(authority)) throw new Error("Invalid loop authority");
  if (typeof requirement !== "string" || !requirement.trim() || Buffer.byteLength(requirement) > 8192) throw new Error("Requirement must contain 1–8192 bytes");
  if (typeof createTask !== "function" || typeof readTask !== "function") throw new Error("Intake requires lifecycle callbacks");
  const project = resolve(root), base = join(project, ".agents", "data", "tasks");
  for (const path of [join(project, ".agents"), join(project, ".agents", "data"), base]) {
    if (!existsSync(path)) mkdirSync(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe intake directory");
  }
  const directory = join(base, taskId);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe task directory");
  const recordPath = join(directory, "loop-intake.json");
  const record = { schemaVersion: 1, taskId, authority, requirementHash: digest(requirement) };
  if (!existsSync(recordPath) && await readTask(taskId)) throw new Error("Existing task has no matching loop intake record");
  try { writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const currentStat = lstatSync(recordPath);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()) throw new Error("Unsafe intake record");
    let current; try { current = JSON.parse(readFileSync(recordPath, "utf8")); } catch { throw new Error("Invalid intake record"); }
    if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Existing intake has different authority or requirement");
  }
  const requirementPath = join(directory, "requirement.md");
  try { writeFileSync(requirementPath, requirement, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = lstatSync(requirementPath);
    if (!existing.isFile() || existing.isSymbolicLink() || digest(readFileSync(requirementPath, "utf8")) !== record.requirementHash) throw new Error("Existing requirement does not match intake");
  }
  const title = `Loop task ${taskId}`;
  let task = await readTask(taskId);
  if (!task) {
    try { await createTask({ taskId, title }); }
    catch (error) { task = await readTask(taskId); if (!task || task.title !== title) throw error; }
    task ??= await readTask(taskId);
  }
  if (!task || task.id !== taskId || task.title !== title) throw new Error("Existing task conflicts with intake");
  return { taskId, authority, requirementPath };
}
