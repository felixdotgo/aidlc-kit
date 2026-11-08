/**
 * One-time, idempotent move of per-task runtime files from the layout of older
 * aidlc-kit versions (`.agents/data/loop/assignments/<task>.json`,
 * `.agents/data/loop/events/<task>.jsonl`, `.agents/data/loop/<task>.json`,
 * `.agents/data/tasks/<task>/loop-intake.json`, `.../requirement.md`) to
 * `.agents/data/tasks/<task>/runtime/` (see task-runtime.mjs).
 *
 * Rules: a file is renamed only when its destination does not exist (a
 * destination that already exists is reported `skipped` and the source is left
 * for inspection); nothing is ever deleted or overwritten; only regular files
 * move (symlinks are reported `skipped`); a rename across filesystems falls
 * back to copy + unlink. Leases, locks and guards stay where they are: locks
 * are short mutexes that expire on their own, leases belong to
 * `.agents/data/loop/`. Every writer calls `migrateTaskRuntime` for its own
 * file before its first write, the local daemon calls `migrateAllTaskRuntime`
 * once at start, and `loop-entry.mjs migrate-data` runs it on demand.
 */
import { copyFileSync, lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ensureTaskRuntimeDir, isRegularFile, isTaskId, legacyTaskRuntimePath, MIGRATED_TASK_RUNTIME_FILES, taskRuntimePath } from "./task-runtime.mjs";

const exists = (path) => { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } };

const move = (from, to) => {
  try { renameSync(from, to); }
  catch (error) {
    if (error?.code !== "EXDEV") throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
};

/** Move the legacy runtime files of one task. `names` limits the files
 * considered (default: every migrated file). Returns one entry per legacy file
 * found: `{ taskId, name, from, to, action: "moved" | "skipped" | "would-move", reason? }`. */
export function migrateTaskRuntime(root, taskId, { dryRun = false, names = MIGRATED_TASK_RUNTIME_FILES } = {}) {
  const entries = [];
  for (const name of names) {
    let from, to;
    try { from = legacyTaskRuntimePath(root, taskId, name); if (!exists(from)) continue; to = taskRuntimePath(root, taskId, name); }
    catch (error) { entries.push({ taskId, name, from: from ?? null, to: to ?? null, action: "skipped", reason: error.message }); continue; }
    const entry = { taskId, name, from, to };
    if (!isRegularFile(from)) { entries.push({ ...entry, action: "skipped", reason: "source is not a regular file" }); continue; }
    if (exists(to)) { entries.push({ ...entry, action: "skipped", reason: "destination already exists" }); continue; }
    if (dryRun) { entries.push({ ...entry, action: "would-move" }); continue; }
    try {
      ensureTaskRuntimeDir(root, taskId);
      move(from, to);
      entries.push({ ...entry, action: "moved" });
    } catch (error) { entries.push({ ...entry, action: "skipped", reason: error.message }); }
  }
  return entries;
}

const listDir = (dir) => { try { return readdirSync(dir).sort(); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } };

/** Task ids that still have a legacy runtime file somewhere under `.agents/data`. */
export function legacyTaskRuntimeIds(root) {
  const data = join(root, ".agents", "data");
  const ids = new Set();
  const add = (value) => { if (isTaskId(value)) ids.add(value); };
  for (const name of listDir(join(data, "loop", "assignments"))) { const match = /^(.+)\.json$/.exec(name); if (match) add(match[1]); }
  for (const name of listDir(join(data, "loop", "events"))) { const match = /^(.+)\.jsonl(?:\.1)?$/.exec(name); if (match) add(match[1]); }
  // `<task>.json` run records only: `<task>.supervisor.json` (lead checkpoint), `<task>.gate-receipt.json`, `ui.json` and `cli.json` stay in the loop directory.
  for (const name of listDir(join(data, "loop"))) { const match = /^(.+)\.json$/.exec(name); if (match && !["ui", "cli"].includes(match[1]) && !/\.(supervisor|gate-receipt)$/.test(match[1])) add(match[1]); }
  for (const name of listDir(join(data, "tasks"))) { if (exists(join(data, "tasks", name, "loop-intake.json")) || exists(join(data, "tasks", name, "requirement.md"))) add(name); }
  return [...ids].sort();
}

/** Migrate every task with legacy runtime files. Returns `{ dryRun, entries, moved, skipped }`. */
export function migrateAllTaskRuntime(root, { dryRun = false } = {}) {
  const entries = [];
  for (const taskId of legacyTaskRuntimeIds(root)) entries.push(...migrateTaskRuntime(root, taskId, { dryRun }));
  return { dryRun, entries, moved: entries.filter((entry) => entry.action === "moved").length, skipped: entries.filter((entry) => entry.action === "skipped").length };
}
