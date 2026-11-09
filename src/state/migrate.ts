import type { LessonIndex, WorkflowState } from "../model.js";
import { archivedSummary, createLessonIndex, lessonStateDigest, stampLegacyG2Waits, taskRecordContent, terminal, validateState } from "./shared.js";

/** TS-only upgrade helper: computes the schema-v4 migration the human-run upgrade flow applies. */
export const prepareV4Migration = (value: WorkflowState): { state: WorkflowState; records: Array<{ path: string; content: string }>; lessonIndex: LessonIndex; stamped: string[] } => {
  const source = validateState(value);
  const next: WorkflowState = { schemaVersion: 4, tasks: {}, archive: {} };
  const records: Array<{ path: string; content: string }> = [];
  for (const task of Object.values(source.tasks)) {
    if (!terminal(task)) next.tasks[task.id] = task;
    else {
      const content = taskRecordContent(task);
      const summary = archivedSummary(task, content);
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
