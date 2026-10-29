import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LessonIndex, WorkflowState } from "../model.js";
import { createLessonIndex, lessonStateDigest, rebuildLessonIndex } from "./lessons.js";
import { hasReview, hasVerification } from "./transitions.js";
import { loadState, saveState } from "./store.js";
import { validateState } from "./validate.js";
import { archiveRecordPath, assertNoSymlinkPath, legacyG2WaitSource, taskRecordContent, terminal, writeAtomic, archivedSummary } from "./shared.js";

/** Marks pre-existing ready G2 waits during migration; the marker is the only exemption from repair-bound enforcement. */
export const stampLegacyG2Waits = (state: WorkflowState): string[] => {
  const stamped: string[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.legacyG2Wait !== undefined) continue;
    if (task.phase !== "build" || task.gate !== "G2_codereview" || task.status !== "blocked_on_user") continue;
    if (!task.tasks.every((item) => item.status === "done" || item.status === "deferred") || !hasVerification(task) || !hasReview(task)) continue;
    task.legacyG2Wait = { migratedAt: task.updatedAt, source: legacyG2WaitSource };
    stamped.push(task.id);
  }
  return stamped;
};

export const prepareV4Migration = (value: WorkflowState): { state: WorkflowState; records: Array<{ path: string; content: string }>; lessonIndex: LessonIndex; stamped: string[] } => {
  const source = validateState(value);
  const next: WorkflowState = { schemaVersion: 4, tasks: {}, archive: {} };
  const records: Array<{ path: string; content: string }> = [];
  for (const task of Object.values(source.tasks)) {
    if (!terminal(task)) next.tasks[task.id] = task;
    else {
      const content = taskRecordContent(task);
      next.archive![task.id] = archivedSummary(task, content);
      records.push({ path: archiveRecordPath(task.id), content });
    }
  }
  for (const item of Object.values(source.archive ?? {})) next.archive![item.id] = item;
  const stamped = Number(source.schemaVersion) < 4 ? stampLegacyG2Waits(next) : [];
  validateState(next);
  const lessons = Object.values(source.tasks).flatMap((task) => task.lessons ?? []);
  return { state: next, records, lessonIndex: createLessonIndex(lessons, lessonStateDigest(next)), stamped };
};

export const migrateState = (root: string, state = loadState(root)): { migrated: boolean; archived: string[]; stamped: string[] } => {
  if (state.schemaVersion === 4) return { migrated: false, archived: [], stamped: [] };
  const migration = prepareV4Migration(state);
  for (const record of migration.records) {
    assertNoSymlinkPath(root, record.path);
    const path = join(resolve(root), record.path);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== record.content) throw new Error(`Archived task record conflicts: ${record.path}`);
    } else writeAtomic(path, record.content);
  }
  saveState(root, migration.state);
  rebuildLessonIndex(root, migration.state);
  return { migrated: true, archived: Object.keys(migration.state.archive ?? {}), stamped: migration.stamped };
};
