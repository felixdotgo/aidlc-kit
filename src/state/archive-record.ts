import type { ArchivedTaskSummary, TaskState } from "../model.js";
import { digest } from "./domain.js";
import { archiveRecordPath } from "./paths.js";

export const taskRecordContent = (task: TaskState): string => `${JSON.stringify(task, null, 2)}\n`;

/** Builds the immutable archive-catalog summary for a terminal task from its record content. */
export const archivedSummary = (task: TaskState, content = taskRecordContent(task)): ArchivedTaskSummary => ({
  id: task.id,
  title: task.title,
  type: task.type,
  phase: task.phase,
  gate: task.gate,
  status: task.status as ArchivedTaskSummary["status"],
  risk: task.risk,
  areas: task.areas,
  record: archiveRecordPath(task.id),
  digest: digest(content),
  lessonCount: task.lessons?.length ?? 0,
  predecessorTaskId: task.predecessorTaskId,
  successorTaskId: task.successorTaskId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt
});

/** Single terminal-to-archive policy shared by auto-archive on save and schema migration. */
export const buildArchiveRecord = (task: TaskState): { content: string; summary: ArchivedTaskSummary } => {
  const content = taskRecordContent(task);
  return { content, summary: archivedSummary(task, content) };
};
