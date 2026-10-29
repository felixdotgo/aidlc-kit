import { existsSync } from "node:fs";
import type { LessonIndex, LessonIndexEntry, LessonRecord, TaskState, WorkflowState } from "../model.js";
import { validateLesson } from "./validate.js";
import { loadState, loadTask } from "./store.js";
import { assertNoSymlinkPath, audited, digest, lessonIndexPath, parseJsonFile, text, tokens, writeAtomic } from "./shared.js";

const lessonEntry = (lesson: LessonRecord): LessonIndexEntry => ({ id: lesson.id, taskId: lesson.taskId, areas: lesson.areas, summary: lesson.summary, prevention: lesson.prevention, source: lesson.source, recordedAt: lesson.recordedAt });

export const recordLesson = (task: TaskState, lesson: Omit<LessonRecord, "taskId" | "recordedAt">, recordedAt = new Date().toISOString()): LessonRecord => {
  if (task.phase !== "wrap" || task.status !== "active") throw new Error(`Lessons can only be recorded during active wrap: ${task.id}`);
  const current = task.lessons?.find((item) => item.id === lesson.id);
  const next: LessonRecord = { ...lesson, taskId: task.id, recordedAt };
  validateLesson(task.id, next);
  if (current) {
    if (JSON.stringify({ ...current, recordedAt: undefined }) === JSON.stringify({ ...next, recordedAt: undefined })) return current;
    throw new Error(`Lesson already exists with different content: ${task.id}/${lesson.id}`);
  }
  task.lessons ??= [];
  task.lessons.push(next);
  task.lessonDisposition = { status: "captured", source: lesson.source, recordedAt };
  task.updatedAt = recordedAt;
  return next;
};

export const recordNoLessons = (task: TaskState, reason: string, source: string, recordedAt = new Date().toISOString()): void => {
  if (task.phase !== "wrap" || task.status !== "active") throw new Error(`Lesson disposition can only be recorded during active wrap: ${task.id}`);
  audited(reason, source);
  if (task.lessons?.length) throw new Error(`Task already has captured lessons: ${task.id}`);
  task.lessonDisposition = { status: "none", reason, source, recordedAt };
  task.updatedAt = recordedAt;
};

export const lessonStateDigest = (state: WorkflowState): string => digest(JSON.stringify({
  active: Object.values(state.tasks).flatMap((task) => task.lessons ?? []).sort((a, b) => `${a.taskId}:${a.id}`.localeCompare(`${b.taskId}:${b.id}`)),
  archive: Object.values(state.archive ?? {}).map((item) => ({ id: item.id, digest: item.digest, lessonCount: item.lessonCount })).sort((a, b) => a.id.localeCompare(b.id))
}));

export const createLessonIndex = (lessons: LessonRecord[], sourceDigest?: string): LessonIndex => ({ schemaVersion: 1, sourceDigest: sourceDigest ?? digest(JSON.stringify(lessons)), lessons: lessons.map(lessonEntry).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.taskId.localeCompare(b.taskId) || a.id.localeCompare(b.id)) });

const allLessons = (root: string, state: WorkflowState): LessonRecord[] => [
  ...Object.values(state.tasks).flatMap((task) => task.lessons ?? []),
  ...Object.keys(state.archive ?? {}).flatMap((id) => loadTask(root, id, state)?.lessons ?? [])
];

export const rebuildLessonIndex = (root: string, state = loadState(root)): LessonIndex => {
  const index = createLessonIndex(allLessons(root, state), lessonStateDigest(state));
  assertNoSymlinkPath(root, ".agents/data/lessons/index.json");
  writeAtomic(lessonIndexPath(root), `${JSON.stringify(index, null, 2)}\n`);
  return index;
};

export const searchLessons = (root: string, state: WorkflowState, query: string, areas: string[] = [], limit = 5): LessonIndexEntry[] => {
  const path = lessonIndexPath(root);
  assertNoSymlinkPath(root, ".agents/data/lessons/index.json");
  if (!existsSync(path)) {
    const hasLessons = Object.values(state.tasks).some((task) => Boolean(task.lessons?.length)) || Object.values(state.archive ?? {}).some((task) => task.lessonCount > 0);
    if (!hasLessons) return [];
    throw new Error("Lesson index is missing; run state.mjs lesson rebuild");
  }
  const index = parseJsonFile(path, "Lesson index", "run state.mjs lesson rebuild") as LessonIndex;
  if (index.schemaVersion !== 1 || !Array.isArray(index.lessons) || index.sourceDigest !== lessonStateDigest(state)) throw new Error("Lesson index is stale; run state.mjs lesson rebuild");
  const queryTokens = tokens(query);
  const areaSet = new Set(areas.map((area) => area.toLocaleLowerCase()));
  return index.lessons.map((item) => {
    const haystack = new Set(tokens(`${item.summary} ${item.prevention} ${item.taskId} ${item.areas.join(" ")}`));
    const areaScore = item.areas.some((area) => areaSet.has(area.toLocaleLowerCase())) ? 100 : 0;
    const tokenScore = queryTokens.filter((token) => haystack.has(token)).length;
    return { item, score: areaScore + tokenScore };
  }).filter(({ score }) => score > 0 || (!queryTokens.length && !areaSet.size)).sort((a, b) => b.score - a.score || b.item.recordedAt.localeCompare(a.item.recordedAt)).slice(0, Math.max(1, Math.min(limit, 20))).map(({ item }) => item);
};
