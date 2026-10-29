import type { Diagnostic, Gate, Phase, TaskState, WorkflowState } from "../model.js";
import { phases, phaseGate, terminal } from "./shared.js";

export const latestApproval = (task: TaskState, gate: Gate) => {
  for (let index = task.evidence.length - 1; index >= 0; index -= 1) {
    const item = task.evidence[index];
    if (item.kind === "approval" && item.gate === gate) return item;
  }
  return undefined;
};

/** Evidence index where the currently effective Approve plan approval starts; undefined when none exists. */
export const buildBoundary = (task: TaskState): number | undefined => {
  let boundary: number | undefined;
  for (let index = 0; index < task.evidence.length; index += 1) {
    const item = task.evidence[index];
    if (item.kind === "approval" && item.gate === "G1_review" && item.result === "pass") boundary = index;
  }
  return boundary;
};

export const hasApproval = (task: TaskState, gate: Gate): boolean => latestApproval(task, gate)?.result === "pass";

const currentBuildEvidence = (task: TaskState): TaskState["evidence"] => {
  const boundary = buildBoundary(task);
  return boundary === undefined ? [] : task.evidence.slice(boundary + 1);
};

const latestInOrder = (items: TaskState["evidence"], predicate: (item: TaskState["evidence"][number]) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index])) return items[index];
  return undefined;
};

export const hasCurrentBuildApproval = (task: TaskState, gate: Gate): boolean => latestInOrder(currentBuildEvidence(task), (item) => item.kind === "approval" && item.gate === gate)?.result === "pass";

export const hasAreaVerification = (task: TaskState, area: string): boolean => {
  const evidence = currentBuildEvidence(task).filter((item) => (item.kind === "test" || item.kind === "lint") && (item.area === area || (!item.area && task.areas.length === 1)));
  const kinds = [...new Set(evidence.map((item) => item.kind))];
  return kinds.length > 0 && kinds.every((kind) => latestInOrder(evidence, (item) => item.kind === kind)?.result === "pass");
};

export const hasVerification = (task: TaskState): boolean => task.areas.every((area) => hasAreaVerification(task, area));
export const hasReview = (task: TaskState): boolean => latestInOrder(currentBuildEvidence(task), (item) => item.kind === "review")?.result === "pass";

export interface RepairBounds {
  verifyFailures: Record<string, number>;
  reviewFailures: number;
  exhaustedAreas: string[];
  verifyExhausted: boolean;
  reviewExhausted: boolean;
}

export const repairBounds = (task: TaskState): RepairBounds => {
  const evidence = currentBuildEvidence(task);
  const verifyFailures: Record<string, number> = {};
  for (const item of evidence) if (["test", "lint"].includes(item.kind) && item.result === "fail") {
    const area = item.area ?? (task.areas.length === 1 ? task.areas[0] : "unscoped");
    verifyFailures[area] = (verifyFailures[area] ?? 0) + 1;
  }
  const reviewFailures = evidence.filter((item) => item.kind === "review" && item.result === "fail").length;
  const exhaustedAreas = Object.keys(verifyFailures).filter((area) => verifyFailures[area] >= 3).sort();
  return { verifyFailures, reviewFailures, exhaustedAreas, verifyExhausted: exhaustedAreas.length > 0, reviewExhausted: reviewFailures >= 2 };
};

/** True only for a migration-stamped legacy G2 wait that is still fully ready; the stamp is written exclusively by schema migration. */
export const isLegacyG2Wait = (task: TaskState): boolean => task.legacyG2Wait !== undefined && task.phase === "build" && task.gate === "G2_codereview" && task.status === "blocked_on_user" && task.tasks.every((item) => item.status === "done" || item.status === "deferred") && hasVerification(task) && hasReview(task);

export const transitionDiagnostics = (task: TaskState, target: Phase): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (target === task.phase || phases.indexOf(target) !== phases.indexOf(task.phase) + 1) diagnostics.push({ level: "ERROR", code: "STATE_TRANSITION", message: `Cannot transition ${task.phase} → ${target}` });
  if (target === "plan" && !hasApproval(task, "G0_confirm")) diagnostics.push({ level: "ERROR", code: "G0_APPROVAL", message: "G0 approval evidence is required" });
  if (target === "build") {
    if (!hasApproval(task, "G1_review")) diagnostics.push({ level: "ERROR", code: "G1_APPROVAL", message: "G1 approval evidence is required" });
    for (const decision of task.decisions) if (decision.status === "unresolved") diagnostics.push({ level: "ERROR", code: "UNRESOLVED_DECISION", message: `Decision ${decision.id} is unresolved` });
  }
  if (target === "wrap") {
    if (!hasVerification(task)) diagnostics.push({ level: "ERROR", code: "VERIFY_EVIDENCE", message: "Latest current-build verification evidence must pass for every affected area" });
    if (!hasReview(task)) diagnostics.push({ level: "ERROR", code: "REVIEW_EVIDENCE", message: "Latest current-build code-review evidence must pass" });
    if (!hasCurrentBuildApproval(task, "G2_codereview")) diagnostics.push({ level: "ERROR", code: "G2_APPROVAL", message: "Current-build G2 approval evidence is required" });
  }
  if (target === "done" && !task.lessonDisposition) diagnostics.push({ level: "ERROR", code: "LESSON_DISPOSITION", message: "Wrap must record lessons or an explicit no-lesson disposition" });
  return diagnostics;
};

export const transitionTask = (state: WorkflowState, id: string, target: Phase): TaskState => {
  const task = state.tasks[id];
  if (!task) throw new Error(`Unknown active task: ${id}`);
  if (terminal(task)) throw new Error(`Terminal task cannot transition: ${id}`);
  const errors = transitionDiagnostics(task, target).filter((item) => item.level === "ERROR");
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  task.phase = target;
  task.gate = phaseGate(target);
  task.status = target === "done" ? "done" : "active";
  delete task.legacyG2Wait;
  task.updatedAt = new Date().toISOString();
  return task;
};
