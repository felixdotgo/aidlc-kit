import type { HandoffKind, TaskState, WorkflowState } from "../model.js";
import { handoffKinds } from "./shared.js";
import { hasApproval } from "./transitions.js";
import { validateState } from "./validate.js";
import { audited, terminal } from "./shared.js";

export const handoffTask = (state: WorkflowState, id: string, kind: HandoffKind, reason: string, source: string, recordedAt = new Date().toISOString()): TaskState => {
  const task = state.tasks[id];
  if (!task || terminal(task) || !handoffKinds.includes(kind)) throw new Error(`Task cannot enter handoff: ${id}`);
  audited(reason, source);
  if (task.handoff) {
    if (task.handoff.kind === kind && task.handoff.reason === reason && task.handoff.source === source) return task;
    throw new Error(`Task already has a different handoff: ${id}`);
  }
  task.status = "paused";
  task.handoff = { kind, reason, source, recordedAt };
  delete task.legacyG2Wait;
  task.updatedAt = recordedAt;
  return task;
};

export const closeTask = (state: WorkflowState, id: string, reason: string, source: string, recordedAt = new Date().toISOString()): TaskState => {
  const task = state.tasks[id];
  if (!task || task.status === "done" || task.status === "superseded") throw new Error(`Task cannot be closed: ${id}`);
  audited(reason, source);
  if (task.status === "closed") {
    if (task.closure?.reason === reason && task.closure.source === source) return task;
    throw new Error(`Task is already closed with different metadata: ${id}`);
  }
  task.status = "closed";
  task.closure = { reason, source, recordedAt };
  delete task.handoff;
  delete task.successorTaskId;
  delete task.legacyG2Wait;
  task.updatedAt = recordedAt;
  return task;
};

export const supersedeTask = (state: WorkflowState, id: string, successorId: string, reason: string, source: string, recordedAt = new Date().toISOString()): TaskState => {
  const task = state.tasks[id];
  const successor = state.tasks[successorId];
  audited(reason, source);
  if (!task || task.status === "done" || task.status === "closed" || !successor || id === successorId) throw new Error(`Task cannot be superseded: ${id}`);
  if (task.status === "superseded") {
    if (task.successorTaskId === successorId && task.closure?.reason === reason && task.closure.source === source) return task;
    throw new Error(`Task is already superseded with different metadata: ${id}`);
  }
  if (successor.phase !== "clarify" || successor.gate !== "G0_confirm" || terminal(successor) || hasApproval(successor, "G0_confirm") || (successor.predecessorTaskId && successor.predecessorTaskId !== id)) throw new Error(`Successor must be a fresh pre-G0 task: ${successorId}`);
  task.status = "superseded";
  task.closure = { reason, source, recordedAt };
  task.successorTaskId = successorId;
  delete task.handoff;
  delete task.legacyG2Wait;
  task.updatedAt = recordedAt;
  successor.predecessorTaskId = id;
  successor.updatedAt = recordedAt;
  validateState(state);
  return task;
};

export const reopenTask = (state: WorkflowState, id: string, target: "plan", reason: string, source: string, recordedAt = new Date().toISOString()): TaskState => {
  const task = state.tasks[id];
  audited(reason, source);
  if (!task || target !== "plan" || task.phase !== "build" || task.status !== "paused" || !task.handoff) throw new Error(`Task cannot reopen G1: ${id}`);
  task.evidence.push({ kind: "approval", gate: "G1_review", result: "fail", source, detail: `Reopened G1: ${reason}`, recordedAt });
  for (const item of task.tasks) if (item.status !== "deferred") item.status = "todo";
  task.phase = "plan";
  task.gate = "G1_review";
  task.status = "active";
  delete task.handoff;
  task.updatedAt = recordedAt;
  return task;
};
