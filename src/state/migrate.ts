import { existsSync, readFileSync } from "node:fs";
import type { LessonIndex, WorkflowState } from "../model.js";
import { buildArchiveRecord } from "./archive-record.js";
import { legacyG2WaitSource, terminal } from "./domain.js";
import { safeResolvedPath, writeAtomic } from "./io.js";
import { createLessonIndex, lessonStateDigest, rebuildLessonIndex } from "./lessons.js";
import { hasReview, hasVerification } from "./transitions.js";
import { loadState, saveState } from "./store.js";
import { validateState } from "./validate.js";

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
      const { content, summary } = buildArchiveRecord(task);
      next.archive![task.id] = summary;
      records.push({ path: summary.record, content });
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
    const path = safeResolvedPath(root, record.path);
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== record.content) throw new Error(`Archived task record conflicts: ${record.path}`);
    } else writeAtomic(path, record.content);
  }
  saveState(root, migration.state);
  rebuildLessonIndex(root, migration.state);
  return { migrated: true, archived: Object.keys(migration.state.archive ?? {}), stamped: migration.stamped };
};
