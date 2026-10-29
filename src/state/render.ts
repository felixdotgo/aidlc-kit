import { join, resolve } from "node:path";
import type { Phase, Gate, TaskState, WorkflowState } from "../model.js";
import { loadState } from "./store.js";
import { assertNoSymlinkPath, tokens, writeAtomic } from "./shared.js";

export interface TaskSummary { id: string; title: string; phase: Phase; gate: Gate; status: TaskState["status"]; risk: TaskState["risk"]; areas: string[]; updatedAt: string; source: "active" | "archive" }

export const listTaskSummaries = (state: WorkflowState, options: { includeArchive?: boolean; statuses?: string[]; query?: string; limit?: number; cursor?: number } = {}) => {
  const active: TaskSummary[] = Object.values(state.tasks).map((task) => ({ id: task.id, title: task.title, phase: task.phase, gate: task.gate, status: task.status, risk: task.risk, areas: task.areas, updatedAt: task.updatedAt, source: "active" }));
  const archived: TaskSummary[] = options.includeArchive ? Object.values(state.archive ?? {}).map((task) => ({ id: task.id, title: task.title, phase: task.phase, gate: task.gate, status: task.status, risk: task.risk, areas: task.areas, updatedAt: task.updatedAt, source: "archive" })) : [];
  const queryTokens = tokens(options.query ?? "");
  const statuses = new Set(options.statuses ?? []);
  const filtered = [...active, ...archived].filter((item) => (!statuses.size || statuses.has(item.status)) && (!queryTokens.length || queryTokens.every((token) => tokens(`${item.id} ${item.title} ${item.areas.join(" ")}`).includes(token)))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const cursor = Math.max(0, options.cursor ?? 0);
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const items = filtered.slice(cursor, cursor + limit);
  return { items, nextCursor: cursor + items.length < filtered.length ? String(cursor + items.length) : null, total: filtered.length };
};

/** Renders the markdown workplan for a task. */
export const renderWorkplan = (task: TaskState): string => {
  const decisions = task.decisions.length ? task.decisions.map((item) => `- [${item.status === "approved" ? "x" : " "}] ${item.id} — ${item.label}${item.resolution ? ` — ${item.resolution}` : ""}`).join("\n") : "- None";
  const tasks = task.tasks.length ? task.tasks.map((item) => `- [${item.status === "done" ? "x" : item.status === "in_progress" ? "~" : " "}] ${item.id} — ${item.label}`).join("\n") : "- None";
  const lifecycle = [`- Status: \`${task.status}\``, task.handoff ? `- Handoff: \`${task.handoff.kind}\` — ${task.handoff.reason}` : "", task.closure ? `- Closure: ${task.closure.reason}` : "", task.predecessorTaskId ? `- Predecessor: \`${task.predecessorTaskId}\`` : "", task.successorTaskId ? `- Successor: \`${task.successorTaskId}\`` : "", task.lessonDisposition ? `- Lessons: \`${task.lessonDisposition.status}\`` : ""].filter(Boolean).join("\n");
  return `# Workplan — ${task.title} (\`${task.id}\`)\n\n> Generated from canonical JSON state.\n\n## Lifecycle\n${lifecycle}\n\n## 🧩 Decisions (Approve plan — before implementation)\n${decisions}\n\n## 🧩 Tasks (Review implementation — work items)\n${tasks}\n`;
};

export const renderViews = (root: string, state = loadState(root), selected: TaskState[] = Object.values(state.tasks)): void => {
  for (const task of selected) {
    if (!task.artifacts.workplan) continue;
    assertNoSymlinkPath(root, task.artifacts.workplan);
    writeAtomic(join(resolve(root), task.artifacts.workplan), renderWorkplan(task));
  }
};
