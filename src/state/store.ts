import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskState, WorkflowState } from "../model.js";
import { validateState, validateTask } from "./validate.js";
import { assertNoSymlinkPath, digest, emptyState, parseJsonFile, parseJsonText, statePath, taskRecordContent, terminal, writeAtomic, archivedSummary } from "./shared.js";

export const loadState = (root: string): WorkflowState => {
  const path = statePath(root);
  assertNoSymlinkPath(root, ".agents/data/state/aidlc-state.json");
  return existsSync(path) ? validateState(parseJsonFile(path, "AI-DLC state file", "restore it from git history or the archive records")) : emptyState();
};

export const loadTask = (root: string, id: string, state = loadState(root)): TaskState | undefined => {
  if (state.tasks[id]) return state.tasks[id];
  const summary = state.archive?.[id];
  if (!summary) return undefined;
  const path = join(resolve(root), summary.record);
  assertNoSymlinkPath(root, summary.record);
  if (!existsSync(path)) throw new Error(`Archived task record is missing: ${summary.record}`);
  const content = readFileSync(path, "utf8");
  if (digest(content) !== summary.digest) throw new Error(`Archived task digest mismatch: ${id}`);
  const task = parseJsonText(content, `Archived task record ${id}`) as TaskState;
  validateTask(id, task);
  if (!terminal(task) || task.status !== summary.status || task.updatedAt !== summary.updatedAt || (task.lessons?.length ?? 0) !== summary.lessonCount) throw new Error(`Archived task summary mismatch: ${id}`);
  return task;
};

const archiveTerminalTasks = (normalized: WorkflowState, persisted: WorkflowState | undefined, root: string): string[] => {
  const archived: string[] = [];
  normalized.archive ??= {};
  for (const task of Object.values(normalized.tasks)) {
    if (!terminal(task)) continue;
    const content = taskRecordContent(task);
    const summary = archivedSummary(task, content);
    const path = join(resolve(root), summary.record);
    assertNoSymlinkPath(root, summary.record);
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8");
      if (digest(current) !== summary.digest) commitRecoveryRecordOrThrow(task, content, path, current, persisted);
    } else writeAtomic(path, content);
    normalized.archive[task.id] = summary;
    delete normalized.tasks[task.id];
    archived.push(task.id);
  }
  return archived;
};

/** Replaces an interrupted-write orphan only when the persisted catalog still proves the same active task identity. */
const commitRecoveryRecordOrThrow = (task: TaskState, content: string, path: string, current: string, persisted: WorkflowState | undefined): void => {
  let orphan: TaskState;
  try { orphan = JSON.parse(current) as TaskState; validateTask(task.id, orphan); }
  catch { throw new Error(`Archived task record conflicts: ${task.id}`); }
  const authority = persisted?.tasks[task.id];
  const identityHolds = authority && authority.createdAt === task.createdAt;
  const orphanMatches = terminal(orphan) && orphan.id === task.id && orphan.createdAt === task.createdAt;
  if (persisted?.archive?.[task.id] || !identityHolds || !orphanMatches) throw new Error(`Archived task record conflicts: ${task.id}`);
  writeAtomic(path, content);
};

export const saveState = (root: string, state: WorkflowState): string[] => {
  const normalized = validateState(structuredClone(state));
  const persisted = existsSync(statePath(root)) ? loadState(root) : undefined;
  const archived = normalized.schemaVersion >= 3 ? archiveTerminalTasks(normalized, persisted, root) : [];
  if (normalized.schemaVersion >= 3) validateState(normalized);
  assertNoSymlinkPath(root, ".agents/data/state/aidlc-state.json");
  writeAtomic(statePath(root), `${JSON.stringify(normalized, null, 2)}\n`);
  state.tasks = normalized.tasks;
  state.archive = normalized.archive;
  state.schemaVersion = normalized.schemaVersion;
  return archived;
};
