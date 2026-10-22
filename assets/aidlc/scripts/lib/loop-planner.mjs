import { nextAction, readyTaskItems } from "./store.mjs";

// Scheduling is derived from canonical lifecycle state. Assignments are operational hints only.
export const planLoop = ({ task, assignments = [], root }) => {
  const action = nextAction(task, root);
  const itemGraph = readyTaskItems(task);
  if (action.classification !== "run_phase" || task.phase !== "build") return { ...action, readyItems: [], blockedItems: itemGraph.blocked };
  const busy = new Set(assignments.filter((entry) => ["leased", "reported", "uncertain"].includes(entry.state) && entry.taskId === task.id).map((entry) => entry.itemId));
  const readyItems = itemGraph.ready.filter((id) => !busy.has(id));
  if (readyItems.length) return { classification: "dispatch", phase: task.phase, gate: task.gate, readyItems, blockedItems: itemGraph.blocked, nextAction: action };
  if (busy.size) return { classification: "reconcile", phase: task.phase, gate: task.gate, readyItems: [], blockedItems: itemGraph.blocked, nextAction: action, reason: "Recover or integrate outstanding assignments" };
  return { ...action, readyItems: [], blockedItems: itemGraph.blocked };
};
