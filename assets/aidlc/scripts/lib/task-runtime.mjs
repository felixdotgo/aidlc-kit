/**
 * Per-task operational data lives under the task's own directory:
 *
 *   .agents/data/tasks/<taskId>/runtime/
 *     assignments.json      local worker claims (`assignment-store.mjs`)
 *     assignments.lock      short mutex around one assignments read-modify-write
 *     events.jsonl (+ .1)   the task's event history (`loop-stream.mjs`)
 *     run.json              the loop run record (`loop-runtime.mjs`)
 *     intake.json           the loop intake record (`loop-intake.mjs`)
 *     requirement.md        the intake requirement text
 *     workers/              container index and raw output (`loop-worker-log.mjs`)
 *
 * The task directory root keeps review artifacts only; `.agents/data/loop/`
 * keeps daemon/process state (daemon lock and log, the global event sidecar,
 * task leases). The same layout serves the no-loop workflow, the local loop,
 * and fleet, so every reader finds task data without knowing which mode wrote
 * it. `runtime/` is operational: never committed, handed off, or clean-checked
 * (`isLoopOperationalPath` in loop-git.mjs).
 *
 * Older versions kept these files under `.agents/data/loop/` (assignments,
 * events, `<task>.json` run record) and at the task directory root
 * (`loop-intake.json`, `requirement.md`). `legacyTaskRuntimePath` names those
 * locations so readers fall back to them and `task-runtime-migrate.mjs` moves
 * them once.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Runtime file names and where an older aidlc-kit kept each one (relative to `.agents/data`). */
export const TASK_RUNTIME_FILES = Object.freeze({
  "assignments.json": (taskId) => ["loop", "assignments", `${taskId}.json`],
  "assignments.lock": (taskId) => ["loop", "assignments", `${taskId}.lock`],
  "events.jsonl": (taskId) => ["loop", "events", `${taskId}.jsonl`],
  "events.jsonl.1": (taskId) => ["loop", "events", `${taskId}.jsonl.1`],
  "run.json": (taskId) => ["loop", `${taskId}.json`],
  "intake.json": (taskId) => ["tasks", taskId, "loop-intake.json"],
  "requirement.md": (taskId) => ["tasks", taskId, "requirement.md"],
});

/** Runtime files that `task-runtime-migrate.mjs` moves (locks are short-lived and expire on their own). */
export const MIGRATED_TASK_RUNTIME_FILES = Object.freeze(["assignments.json", "events.jsonl", "events.jsonl.1", "run.json", "intake.json", "requirement.md"]);

export const isTaskId = (value) => typeof value === "string" && ID_PATTERN.test(value);
const safeTaskId = (taskId) => { if (!isTaskId(taskId)) throw new Error(`Invalid task id: ${taskId}`); return taskId; };
const safeName = (name) => { if (!Object.hasOwn(TASK_RUNTIME_FILES, name)) throw new Error(`Unknown task runtime file: ${name}`); return name; };

/** Throw when `path` exists and is a symlink (a planted link must not redirect reads or writes). */
const refuseSymlink = (path) => {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Task runtime path crosses symlink: ${path}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
};

/** Join `parts` under `root`, refusing any symlinked component. */
const safeJoin = (root, parts) => {
  let path = resolve(root);
  for (const part of parts) { path = join(path, part); refuseSymlink(path); }
  return path;
};

/** `.agents/data/tasks/<taskId>/runtime`, every component checked for symlinks. */
export function taskRuntimeDir(root, taskId) {
  return safeJoin(root, [".agents", "data", "tasks", safeTaskId(taskId), "runtime"]);
}

/** The current location of one runtime file (`name` from TASK_RUNTIME_FILES). */
export function taskRuntimePath(root, taskId, name) {
  return safeJoin(root, [".agents", "data", "tasks", safeTaskId(taskId), "runtime", safeName(name)]);
}

/** Where an older aidlc-kit kept the same runtime file. */
export function legacyTaskRuntimePath(root, taskId, name) {
  return safeJoin(root, [".agents", "data", ...TASK_RUNTIME_FILES[safeName(name)](safeTaskId(taskId))]);
}

/** True when `path` is a regular (non-symlink) file. */
export const isRegularFile = (path) => {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
};

/** Read location of a runtime file: the current path when it exists, else the
 * legacy path when that exists, else the current path (for a clean ENOENT). */
export function resolveTaskRuntimeRead(root, taskId, name) {
  const current = taskRuntimePath(root, taskId, name);
  if (isRegularFile(current)) return current;
  const legacy = legacyTaskRuntimePath(root, taskId, name);
  return isRegularFile(legacy) ? legacy : current;
}

/** Create the runtime directory (0700, like the task directory an intake creates) and return it. */
export function ensureTaskRuntimeDir(root, taskId) {
  const directory = taskRuntimeDir(root, taskId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  refuseSymlink(directory);
  return directory;
}
