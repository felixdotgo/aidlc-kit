import { isAbsolute } from "node:path";
import type { Gate, Phase, TaskState } from "../model.js";
import { commandKit, type CommandKit, type NextActionActions } from "./commands.js";
import { hasReview, hasVerification, isLegacyG2Wait, repairBounds } from "./transitions.js";

export interface NextAction {
  classification: "await_user" | "run_phase" | "blocked" | "terminal" | "complete";
  phase: Phase;
  gate: Gate;
  command?: string;
  outcome?: "closed" | "superseded";
  successorTaskId?: string;
  itemId?: string;
  remainingItems?: number;
  actions?: NextActionActions;
  reason: string;
}

/** Pure state-machine decision for a task; every field of `NextAction` except the synthesized command strings. */
type Decision =
  | { kind: "complete"; reason: string }
  | { kind: "terminal"; outcome: "closed" | "superseded"; successorTaskId: string | undefined; reason: string }
  | { kind: "handoff"; reason: string }
  | { kind: "paused"; reason: string }
  | { kind: "repair_exhausted"; handoffKind: "review_exhausted" | "repair_exhausted"; reason: string }
  | { kind: "continue_item"; itemId: string; remainingItems: number; reason: string }
  | { kind: "continue_verification"; reason: string }
  | { kind: "no_ready_item"; reason: string }
  | { kind: "recover_g1_wait"; reason: string }
  | { kind: "recover_gateless_wrap"; reason: string }
  | { kind: "await_user"; reason: string }
  | { kind: "continue_phase"; reason: string };

const isPending = (item: TaskState["tasks"][number]): boolean => item.status === "in_progress" || item.status === "todo";
const pendingItems = (task: TaskState): TaskState["tasks"] => task.tasks.filter(isPending);

/** Validates execution dependencies and reports which pending items are ready to dispatch. */
export const readyTaskItems = (task: TaskState): { ready: string[]; blocked: Array<{ id: string; waitingOn: string[] }> } => {
  const byId = new Map(task.tasks.map((item) => [item.id, item]));
  if (byId.size !== task.tasks.length) throw new Error(`Duplicate execution item: ${task.id}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Cyclic execution dependency: ${task.id}/${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (dep === id || !byId.has(dep)) throw new Error(`Unknown execution dependency: ${task.id}/${id}/${dep}`);
      visit(dep);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of task.tasks) {
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length || item.dependsOn.some((dep) => typeof dep !== "string" || !dep))) throw new Error(`Invalid execution dependencies: ${task.id}/${item.id}`);
    if (item.ownedPaths !== undefined && (
      !Array.isArray(item.ownedPaths) ||
      new Set(item.ownedPaths).size !== item.ownedPaths.length ||
      item.ownedPaths.some((path) =>
        typeof path !== "string" ||
        !path ||
        isAbsolute(path) ||
        path === ".." ||
        path.startsWith("../") ||
        path.includes("\\") ||
        path.split("/").includes("..")
      )
    )) throw new Error(`Invalid owned paths: ${task.id}/${item.id}`);
    visit(item.id);
  }
  const ready: string[] = [];
  const blocked: Array<{ id: string; waitingOn: string[] }> = [];
  for (const item of task.tasks) {
    const waitingOn = (item.dependsOn ?? []).filter((dep) => byId.get(dep)?.status !== "done");
    if (item.status === "done" && waitingOn.length) throw new Error(`Completed item has incomplete prerequisites: ${task.id}/${item.id}`);
    if (!isPending(item)) continue;
    if (waitingOn.length) blocked.push({ id: item.id, waitingOn });
    else ready.push(item.id);
  }
  return { ready, blocked };
};

const dispatchableItem = (open: TaskState["tasks"], task: TaskState): TaskState["tasks"][number] | undefined => {
  const ready = new Set(readyTaskItems(task).ready);
  return open.find((entry) => entry.status === "in_progress" && ready.has(entry.id)) ?? open.find((entry) => ready.has(entry.id));
};

const noReadyItemReason = (task: TaskState): string => `No dependency-ready build item: ${readyTaskItems(task).blocked.map((entry) => `${entry.id} waits for ${entry.waitingOn.join(",")}`).join("; ")}`;

const repairExhausted = (task: TaskState): Decision | undefined => {
  if (task.phase !== "build" || isLegacyG2Wait(task)) return undefined;
  const bounds = repairBounds(task);
  if (!bounds.verifyExhausted && !bounds.reviewExhausted) return undefined;
  const handoffKind = bounds.reviewExhausted ? "review_exhausted" : "repair_exhausted";
  const detail = bounds.verifyExhausted ? `3+ failed verify cycles in: ${bounds.exhaustedAreas.join(", ")}` : `${bounds.reviewFailures} failed review passes`;
  return { kind: "repair_exhausted", handoffKind, reason: `Repair bound exhausted (${detail}); record a durable handoff` };
};

const continueItem = (item: TaskState["tasks"][number], openCount: number, premature: boolean): Decision => ({
  kind: "continue_item",
  itemId: item.id,
  remainingItems: openCount,
  reason: premature ? `Invalid premature G2 wait; continue build item ${item.id}` : `Continue build item ${item.id}; ${openCount} actionable item(s) remain before verification, review, and G2`
});

const continueVerification = (premature: boolean): Decision => ({
  kind: "continue_verification",
  reason: premature ? "Invalid premature G2 wait; continue verification and adversarial review before presenting G2" : "All build items are terminal; continue verification, adversarial review, and G2 preparation"
});

const prematureG2Wait = (task: TaskState): Decision | undefined => {
  if (task.status !== "blocked_on_user" || task.gate !== "G2_codereview") return undefined;
  if (!(task.tasks.some((item) => !["done", "deferred"].includes(item.status)) || !hasVerification(task) || !hasReview(task))) return undefined;
  const open = pendingItems(task);
  const item = dispatchableItem(open, task);
  if (item) return continueItem(item, open.length, true);
  if (open.length) return { kind: "no_ready_item", reason: noReadyItemReason(task) };
  return continueVerification(true);
};

/** Pure classification: maps a task onto its next-action decision without touching any command string. */
const classify = (task: TaskState): Decision => {
  if (task.phase === "done") return { kind: "complete", reason: "Task is complete" };
  if (task.status === "closed" || task.status === "superseded") return { kind: "terminal", outcome: task.status, successorTaskId: task.successorTaskId, reason: task.closure?.reason ?? "Task ended without successful completion" };
  if (task.handoff) return { kind: "handoff", reason: task.handoff.reason };
  if (task.status === "paused") return { kind: "paused", reason: "Task is paused" };
  const repair = repairExhausted(task);
  if (repair) return repair;
  const prematureG2 = prematureG2Wait(task);
  if (prematureG2) return prematureG2;
  if (task.status === "blocked_on_user" && task.gate === "G1_review" && task.decisions.some((decision) => decision.status === "unresolved")) return { kind: "recover_g1_wait", reason: "Invalid premature G1 wait; resolve every decision before presenting G1" };
  if (task.status === "blocked_on_user" && task.gate === "none") return { kind: "recover_gateless_wrap", reason: "Recover invalid wait at a gateless wrap phase before continuing wrap" };
  if (task.status === "blocked_on_user") return { kind: "await_user", reason: `Explicit human approval is required at ${task.gate}` };
  if (task.phase === "build") {
    const open = pendingItems(task);
    const item = dispatchableItem(open, task);
    if (item) return continueItem(item, open.length, false);
    if (open.length) return { kind: "no_ready_item", reason: noReadyItemReason(task) };
    return continueVerification(false);
  }
  return { kind: "continue_phase", reason: `Continue ${task.phase} until the next human gate, real blocker, or completion` };
};

/** Attaches the command strings a decision implies; the single call site of the command kit. */
const realize = (task: TaskState, decision: Decision, commands: CommandKit): NextAction => {
  const base = { phase: task.phase, gate: task.gate };
  switch (decision.kind) {
    case "complete": return { classification: "complete", ...base, reason: decision.reason };
    case "terminal": return { classification: "terminal", ...base, outcome: decision.outcome, successorTaskId: decision.successorTaskId, reason: decision.reason };
    case "handoff": return { classification: "blocked", ...base, reason: decision.reason, actions: commands.handoffActions(task) };
    case "paused": return { classification: "blocked", ...base, reason: decision.reason, actions: commands.pausedActions(task.id) };
    case "repair_exhausted": return { classification: "blocked", ...base, reason: decision.reason, actions: commands.repairHandoffAction(task.id, decision.handoffKind) };
    case "continue_item": return { classification: "run_phase", ...base, itemId: decision.itemId, remainingItems: decision.remainingItems, command: commands.continueItem(task.id, decision.itemId), reason: decision.reason };
    case "continue_verification": return { classification: "run_phase", ...base, remainingItems: 0, command: commands.continueVerification(task.id), reason: decision.reason };
    case "no_ready_item": return { classification: "blocked", ...base, reason: decision.reason };
    case "recover_g1_wait": return { classification: "run_phase", ...base, command: commands.recoverG1Wait(task.id), reason: decision.reason };
    case "recover_gateless_wrap": return { classification: "run_phase", ...base, command: commands.recoverGatelessWrap(task.id), reason: decision.reason };
    case "await_user": return { classification: "await_user", ...base, command: commands.approveGate(task.id, task.gate), reason: decision.reason };
    case "continue_phase": return { classification: "run_phase", ...base, command: commands.continuePhase(task.id, task.phase), reason: decision.reason };
  }
};

/** Classifies the next lifecycle action for a task and attaches root-qualified command strings. */
export const nextAction = (task: TaskState, root?: string): NextAction => realize(task, classify(task), commandKit(root));
