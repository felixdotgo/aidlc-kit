import type { ArchivedTaskSummary, LessonRecord, TaskState, WorkflowState } from "../model.js";
import { readyTaskItems } from "./items.js";
import { assertTaskArtifactPath, gates, handoffKinds, idPattern, iso, phases, phaseGate, text } from "./shared.js";

const taskStatuses = ["active", "blocked_on_user", "paused", "done", "closed", "superseded"] as const;

export const validateLesson = (taskId: string, lesson: LessonRecord): void => {
  if (!lesson || !idPattern.test(lesson.id) || lesson.taskId !== taskId || !Array.isArray(lesson.areas) || !lesson.areas.length || lesson.areas.some((area) => !text(area)) || !text(lesson.summary) || !text(lesson.prevention) || !text(lesson.example) || !text(lesson.promotion) || !text(lesson.source) || !iso(lesson.recordedAt)) throw new Error(`Invalid lesson: ${taskId}`);
};

export const validateTask = (id: string, task: TaskState): void => {
  if (!idPattern.test(id)) throw new Error(`Invalid task id: ${id}`);
  if (!task || task.id !== id || !phases.includes(task.phase) || !gates.includes(task.gate) || task.gate !== phaseGate(task.phase)) throw new Error(`Invalid task state: ${id}`);
  if (!Array.isArray(task.decisions) || !Array.isArray(task.tasks) || !Array.isArray(task.evidence) || (task.lessons !== undefined && !Array.isArray(task.lessons))) throw new Error(`Invalid task collections: ${id}`);
  if (!task.title || !["feature", "bug", "refactor", "infra"].includes(task.type) || !taskStatuses.includes(task.status) || (task.phase === "done") !== (task.status === "done")) throw new Error(`Invalid task fields: ${id}`);
  if (!["vi", "en"].includes(task.language) || !["low", "normal", "high", "regulated"].includes(task.risk) || !Array.isArray(task.areas) || !task.areas.length || task.areas.some((area) => !text(area))) throw new Error(`Invalid task language, risk, or areas: ${id}`);
  if (task.decisions.some((item) => !item.id || !item.label || !["unresolved", "approved", "changed", "dropped"].includes(item.status) || (item.status === "changed" && !item.resolution))) throw new Error(`Invalid decisions: ${id}`);
  if (task.featureId !== undefined && !idPattern.test(task.featureId)) throw new Error(`Invalid feature id: ${id}`);
  if (task.tasks.some((item) => !item.id || !item.label || !["todo", "in_progress", "done", "deferred"].includes(item.status))) throw new Error(`Invalid execution tasks: ${id}`);
  readyTaskItems(task);
  if (task.evidence.some((item) => !["approval", "spec", "test", "lint", "review", "diagnostic"].includes(item.kind) || !["pass", "fail", "skip"].includes(item.result) || !item.source || !iso(item.recordedAt) || (item.area !== undefined && !text(item.area)) || (item.gate !== undefined && !gates.includes(item.gate)) || (item.kind === "approval" && (!item.gate || item.gate === "none")))) throw new Error(`Invalid evidence: ${id}`);
  const lessonIds = new Set<string>();
  for (const lesson of task.lessons ?? []) {
    validateLesson(id, lesson);
    if (lessonIds.has(lesson.id)) throw new Error(`Duplicate lesson id: ${id}/${lesson.id}`);
    lessonIds.add(lesson.id);
  }
  if (task.lessonDisposition && (!["captured", "none"].includes(task.lessonDisposition.status) || !text(task.lessonDisposition.source) || !iso(task.lessonDisposition.recordedAt) || (task.lessonDisposition.status === "captured" && !(task.lessons?.length)) || (task.lessonDisposition.status === "none" && (Boolean(task.lessons?.length) || !text(task.lessonDisposition.reason))))) throw new Error(`Invalid lesson disposition: ${id}`);
  if (task.handoff && (!handoffKinds.includes(task.handoff.kind) || !text(task.handoff.reason) || !text(task.handoff.source) || !iso(task.handoff.recordedAt) || task.status !== "paused")) throw new Error(`Invalid task handoff: ${id}`);
  if (task.legacyG2Wait !== undefined && (typeof task.legacyG2Wait !== "object" || Array.isArray(task.legacyG2Wait) || !iso(task.legacyG2Wait.migratedAt) || !text(task.legacyG2Wait.source) || task.phase !== "build" || task.gate !== "G2_codereview" || task.status !== "blocked_on_user")) throw new Error(`Invalid legacy G2 wait marker: ${id}`);
  if ((task.status === "closed" || task.status === "superseded") !== Boolean(task.closure)) throw new Error(`Invalid task closure: ${id}`);
  if (task.closure && (!text(task.closure.reason) || !text(task.closure.source) || !iso(task.closure.recordedAt))) throw new Error(`Invalid task closure: ${id}`);
  if ((task.status === "superseded") !== Boolean(task.successorTaskId) || (task.status === "closed" && task.successorTaskId)) throw new Error(`Invalid task successor: ${id}`);
  if (task.predecessorTaskId !== undefined && !text(task.predecessorTaskId)) throw new Error(`Invalid task predecessor: ${id}`);
  for (const path of Object.values(task.artifacts)) if (path) assertTaskArtifactPath(id, path);
};

const validateArchiveSummary = (id: string, item: ArchivedTaskSummary): void => {
  if (!idPattern.test(id) || !item || item.id !== id || !text(item.title) || !["feature", "bug", "refactor", "infra"].includes(item.type) || !phases.includes(item.phase) || !gates.includes(item.gate) || item.gate !== phaseGate(item.phase) || !["done", "closed", "superseded"].includes(item.status) || !["low", "normal", "high", "regulated"].includes(item.risk) || !Array.isArray(item.areas) || !item.areas.length || item.areas.some((area) => !text(area)) || item.record !== `.agents/data/state/archive/${id}.json` || !/^[a-f0-9]{64}$/.test(item.digest) || !Number.isInteger(item.lessonCount) || item.lessonCount < 0 || !iso(item.createdAt) || !iso(item.updatedAt)) throw new Error(`Invalid archived task summary: ${id}`);
  if ((item.status === "superseded") !== Boolean(item.successorTaskId) || (item.status === "closed" && item.successorTaskId) || (item.predecessorTaskId !== undefined && !text(item.predecessorTaskId))) throw new Error(`Invalid archived task links: ${id}`);
};

export const validateState = (value: unknown): WorkflowState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workflow state must be an object");
  const state = value as Partial<WorkflowState>;
  if (![1, 2, 3, 4].includes(Number(state.schemaVersion)) || !state.tasks || typeof state.tasks !== "object" || Array.isArray(state.tasks)) throw new Error("Unsupported workflow state schema");
  if (Number(state.schemaVersion) >= 3 && (!state.archive || typeof state.archive !== "object" || Array.isArray(state.archive))) throw new Error("Schema v3+ requires an archive catalog");
  if (Number(state.schemaVersion) < 3 && state.archive !== undefined) throw new Error("Legacy workflow state cannot contain an archive catalog");
  if (Number(state.schemaVersion) < 4 && Object.values(state.tasks).some((task) => task?.legacyG2Wait !== undefined)) throw new Error("Legacy G2 wait markers require schema v4");
  for (const [id, task] of Object.entries(state.tasks)) validateTask(id, task);
  for (const [id, item] of Object.entries(state.archive ?? {})) {
    if (state.tasks[id]) throw new Error(`Task exists in active and archive state: ${id}`);
    validateArchiveSummary(id, item);
  }
  const references = { ...(state.archive ?? {}), ...state.tasks };
  for (const [id, item] of Object.entries(references)) {
    if (item.successorTaskId) {
      const successor = references[item.successorTaskId];
      if (!successor || successor.id === id || successor.predecessorTaskId !== id) throw new Error(`Invalid successor link: ${id}`);
    }
    if (item.predecessorTaskId) {
      const predecessor = references[item.predecessorTaskId];
      if (!predecessor || predecessor.id === id || predecessor.status !== "superseded" || predecessor.successorTaskId !== id) throw new Error(`Invalid predecessor link: ${id}`);
    }
    const seen = new Set([id]);
    let cursor: TaskState | ArchivedTaskSummary = item;
    while (cursor.successorTaskId) {
      if (seen.has(cursor.successorTaskId)) throw new Error(`Cyclic successor link: ${id}`);
      seen.add(cursor.successorTaskId);
      const next = references[cursor.successorTaskId];
      if (!next) throw new Error(`Invalid successor link: ${id}`);
      cursor = next;
    }
  }
  return state as WorkflowState;
};
