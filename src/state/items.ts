import { isAbsolute, join, resolve } from "node:path";
import type { Gate, Phase, TaskState } from "../model.js";
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
  actions?: Array<{ id: "reopen_g1" | "create_successor" | "supersede" | "close" | "record_handoff" | "resume"; command: string }>;
  reason: string;
}

const rootSuffix = (root: string | undefined): string => root === undefined ? "" : ` --root ${JSON.stringify(resolve(root))}`;
const script = (root: string | undefined, name: string): string => root === undefined ? `node .agents/aidlc/scripts/${name}` : `node ${JSON.stringify(join(resolve(root), ".agents/aidlc/scripts", name))}`;

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
    if (item.ownedPaths !== undefined && (!Array.isArray(item.ownedPaths) || new Set(item.ownedPaths).size !== item.ownedPaths.length || item.ownedPaths.some((path) => typeof path !== "string" || !path || isAbsolute(path) || path === ".." || path.startsWith("../") || path.includes("\\") || path.split("/").includes("..")))) throw new Error(`Invalid owned paths: ${task.id}/${item.id}`);
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

const handoffActions = (task: TaskState, suffix: string, stateCommand: string): NextAction["actions"] => [
  ...(task.phase === "build" ? [{ id: "reopen_g1" as const, command: `${stateCommand} task reopen ${task.id} --to plan --reason <reason> --source <explicit-user-request>${suffix}` }] : []),
  { id: "create_successor", command: `${stateCommand} task create <new-task-id> --title <title>${suffix}` },
  { id: "supersede", command: `${stateCommand} task supersede ${task.id} --successor <new-task-id> --reason <reason> --source <explicit-user-request>${suffix}` },
  { id: "close", command: `${stateCommand} task close ${task.id} --reason <reason> --source <explicit-user-request>${suffix}` }
];

const pausedActions = (task: TaskState, suffix: string, stateCommand: string): NextAction["actions"] => [
  { id: "resume", command: `${stateCommand} task status ${task.id} --status active${suffix}` },
  { id: "record_handoff", command: `${stateCommand} task handoff ${task.id} --kind <kind> --reason <reason> --source <source>${suffix}` }
];

const repairExhausted = (task: TaskState, suffix: string, stateCommand: string): NextAction | undefined => {
  if (task.phase !== "build" || isLegacyG2Wait(task)) return undefined;
  const bounds = repairBounds(task);
  if (!bounds.verifyExhausted && !bounds.reviewExhausted) return undefined;
  const kind = bounds.reviewExhausted ? "review_exhausted" : "repair_exhausted";
  const detail = bounds.verifyExhausted ? `3+ failed verify cycles in: ${bounds.exhaustedAreas.join(", ")}` : `${bounds.reviewFailures} failed review passes`;
  return {
    classification: "blocked",
    phase: task.phase,
    gate: task.gate,
    reason: `Repair bound exhausted (${detail}); record a durable handoff`,
    actions: [{ id: "record_handoff", command: `${stateCommand} task handoff ${task.id} --kind ${kind} --reason <summary-of-exhausted-repairs> --source <agent>${suffix}` }]
  };
};

const continueItem = (item: TaskState["tasks"][number], openCount: number, task: TaskState, suffix: string, contextCommand: string, premature: boolean): NextAction => ({
  classification: "run_phase",
  phase: task.phase,
  gate: task.gate,
  itemId: item.id,
  remainingItems: openCount,
  command: `${contextCommand} ${task.id} --phase build --item ${item.id}${suffix}`,
  reason: premature ? `Invalid premature G2 wait; continue build item ${item.id}` : `Continue build item ${item.id}; ${openCount} actionable item(s) remain before verification, review, and G2`
});

const continueVerification = (task: TaskState, suffix: string, contextCommand: string, premature: boolean): NextAction => ({
  classification: "run_phase",
  phase: task.phase,
  gate: task.gate,
  remainingItems: 0,
  command: `${contextCommand} ${task.id} --phase build${suffix}`,
  reason: premature ? "Invalid premature G2 wait; continue verification and adversarial review before presenting G2" : "All build items are terminal; continue verification, adversarial review, and G2 preparation"
});

const prematureG2Wait = (task: TaskState, suffix: string, contextCommand: string): NextAction | undefined => {
  if (task.status !== "blocked_on_user" || task.gate !== "G2_codereview") return undefined;
  if (!(task.tasks.some((item) => !["done", "deferred"].includes(item.status)) || !hasVerification(task) || !hasReview(task))) return undefined;
  const open = pendingItems(task);
  const item = dispatchableItem(open, task);
  if (item) return continueItem(item, open.length, task, suffix, contextCommand, true);
  if (open.length) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: noReadyItemReason(task) };
  return continueVerification(task, suffix, contextCommand, true);
};

export const nextAction = (task: TaskState, root?: string): NextAction => {
  const suffix = rootSuffix(root);
  const stateCommand = script(root, "state.mjs");
  const contextCommand = script(root, "context.mjs");
  if (task.phase === "done") return { classification: "complete", phase: task.phase, gate: task.gate, reason: "Task is complete" };
  if (task.status === "closed" || task.status === "superseded") return { classification: "terminal", phase: task.phase, gate: task.gate, outcome: task.status, successorTaskId: task.successorTaskId, reason: task.closure?.reason ?? "Task ended without successful completion" };
  if (task.handoff) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: task.handoff.reason, actions: handoffActions(task, suffix, stateCommand) };
  if (task.status === "paused") return { classification: "blocked", phase: task.phase, gate: task.gate, reason: "Task is paused", actions: pausedActions(task, suffix, stateCommand) };
  const repair = repairExhausted(task, suffix, stateCommand);
  if (repair) return repair;
  const prematureG2 = prematureG2Wait(task, suffix, contextCommand);
  if (prematureG2) return prematureG2;
  if (task.status === "blocked_on_user" && task.gate === "G1_review" && task.decisions.some((decision) => decision.status === "unresolved")) {
    return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${contextCommand} ${task.id} --phase plan${suffix}`, reason: "Invalid premature G1 wait; resolve every decision before presenting G1" };
  }
  if (task.status === "blocked_on_user" && task.gate === "none") return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${stateCommand} task status ${task.id} --status active${suffix}`, reason: "Recover invalid wait at a gateless wrap phase before continuing wrap" };
  if (task.status === "blocked_on_user") return { classification: "await_user", phase: task.phase, gate: task.gate, command: `${stateCommand} gate approve ${task.id} --gate ${task.gate} --source <explicit-user-approval>${suffix}`, reason: `Explicit human approval is required at ${task.gate}` };
  if (task.phase === "build") {
    const open = pendingItems(task);
    const item = dispatchableItem(open, task);
    if (item) return continueItem(item, open.length, task, suffix, contextCommand, false);
    if (open.length) return { classification: "blocked", phase: task.phase, gate: task.gate, reason: noReadyItemReason(task) };
    return continueVerification(task, suffix, contextCommand, false);
  }
  return { classification: "run_phase", phase: task.phase, gate: task.gate, command: `${contextCommand} ${task.id} --phase ${task.phase}${suffix}`, reason: `Continue ${task.phase} until the next human gate, real blocker, or completion` };
};
