import { existsSync, readFileSync } from "node:fs";
import type { Diagnostic, Gate, TaskState, WorkflowState } from "./model.js";
import { resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { hasAreaVerification, hasReview, isLegacyG2Wait, nextAction, repairBounds, transitionDiagnostics, transitionTask } from "./state.js";

const safeArtifactTarget = (root: string, path: string): string => resolveProjectPathWithoutSymlinks(root, path, "Unsafe artifact path", "Artifact path crosses a symlink");

const artifactContent = (root: string, path: string | undefined): string | undefined => {
  if (!path) return undefined;
  try {
    const target = safeArtifactTarget(root, path);
    return existsSync(target) ? readFileSync(target, "utf8") : undefined;
  } catch { return undefined; } /* intentional: unreadable/unsafe artifact is treated as absent */
};

const artifactDiagnostics = (root: string, task: TaskState, names: Array<keyof TaskState["artifacts"]>): Diagnostic[] => names.flatMap((name) => {
  const path = task.artifacts[name];
  if (!path) return [{ level: "ERROR", code: "ARTIFACT_REFERENCE", message: `${String(name)} artifact is not referenced` } satisfies Diagnostic];
  try {
    return existsSync(safeArtifactTarget(root, path)) ? [] : [{ level: "ERROR", code: "ARTIFACT_MISSING", message: `${path} does not exist` } satisfies Diagnostic];
  } catch (error) {
    return [{ level: "ERROR", code: "ARTIFACT_UNSAFE", message: error instanceof Error ? error.message : String(error) } satisfies Diagnostic];
  }
});

const missingHeadings = (content: string, headings: string[]): string[] => headings.filter((heading) => !content.includes(heading));

const confirmGateDiagnostics = (root: string, task: TaskState): Diagnostic[] => {
  const diagnostics: Diagnostic[] = artifactDiagnostics(root, task, ["intent"]);
  const content = artifactContent(root, task.artifacts.intent);
  if (content !== undefined) for (const heading of missingHeadings(content, ["## 📋 Problem", "## 🗺️ Affected areas", "## 💭 Assumptions", "## ❓ Open questions", "## 🎯 Scope"])) diagnostics.push({ level: "ERROR", code: "INTENT_HEADING", message: `Intent is missing ${heading}` });
  return diagnostics;
};

const reviewGateDiagnostics = (root: string, task: TaskState): Diagnostic[] => {
  const diagnostics: Diagnostic[] = artifactDiagnostics(root, task, ["intent", "design", "workplan"]);
  diagnostics.push(...transitionDiagnostics(task, "build").filter((item) => item.code === "UNRESOLVED_DECISION"));
  const content = artifactContent(root, task.artifacts.design);
  if (content !== undefined) for (const heading of missingHeadings(content, ["## 🧩 Solution per affected area", "## 📌 Spec traceability", "## 🔗 Cross-service contracts", "## ⚠️ Risks / edge cases"])) diagnostics.push({ level: "ERROR", code: "DESIGN_HEADING", message: `Design is missing ${heading}` });
  return diagnostics;
};

const codeReviewGateDiagnostics = (root: string, task: TaskState): Diagnostic[] => {
  const diagnostics: Diagnostic[] = artifactDiagnostics(root, task, ["intent", "design", "workplan"]);
  if (task.tasks.some((item) => item.status !== "done" && item.status !== "deferred")) diagnostics.push({ level: "ERROR", code: "TASKS_OPEN", message: "Build tasks remain open" });
  for (const area of task.areas) if (!hasAreaVerification(task, area)) diagnostics.push({ level: "ERROR", code: "VERIFY_EVIDENCE", message: `Latest post-G1 verification evidence must pass for affected area: ${area}` });
  if (!hasReview(task)) diagnostics.push({ level: "ERROR", code: "REVIEW_EVIDENCE", message: "Latest post-G1 review evidence must pass" });
  const bounds = repairBounds(task);
  if (!isLegacyG2Wait(task) && (bounds.verifyExhausted || bounds.reviewExhausted)) diagnostics.push({ level: "ERROR", code: "REPAIR_BOUND", message: "Repair bound exhausted; record a durable handoff instead of presenting G2" });
  return diagnostics;
};

const generalGateDiagnostics = (taskId: string, task: TaskState, gate: Gate): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (task.gate !== gate) diagnostics.push({ level: "ERROR", code: "GATE_STATE", message: `Task is at ${task.gate}, not ${gate}` });
  if (task.status === "closed" || task.status === "superseded") diagnostics.push({ level: "ERROR", code: "TASK_TERMINAL", message: `Terminal task cannot approve ${gate}` });
  if (task.handoff) diagnostics.push({ level: "ERROR", code: "TASK_HANDOFF", message: `Task has unresolved handoff: ${task.handoff.reason}` });
  if (task.id !== taskId) diagnostics.push({ level: "ERROR", code: "TASK_ID", message: "Task key and id differ" });
  if (!task.title.trim() || !task.areas.length) diagnostics.push({ level: "ERROR", code: "TASK_FIELDS", message: "Task title and affected areas are required" });
  return diagnostics;
};

/** Runs all diagnostics for a gate and returns them (empty-ish with GATE_OK when clean). */
export const checkGate = (root: string, state: WorkflowState, taskId: string, gate: Gate): Diagnostic[] => {
  const task = state.tasks[taskId];
  if (!task) return [{ level: "ERROR", code: "TASK_UNKNOWN", message: `Unknown task: ${taskId}` }];
  const diagnostics: Diagnostic[] = generalGateDiagnostics(taskId, task, gate);
  if (gate === "G0_confirm") diagnostics.push(...confirmGateDiagnostics(root, task));
  if (gate === "G1_review") diagnostics.push(...reviewGateDiagnostics(root, task));
  if (gate === "G2_codereview") diagnostics.push(...codeReviewGateDiagnostics(root, task));
  if (!diagnostics.length) diagnostics.push({ level: "INFO", code: "GATE_OK", message: `${gate} checks passed for ${taskId}` });
  return diagnostics;
};

const gateTarget: Partial<Record<Gate, "plan" | "build" | "wrap">> = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" };

export const approveAndAdvance = (root: string, state: WorkflowState, taskId: string, gate: Gate, source: string, recordedAt = new Date().toISOString()) => {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  if (task.status === "closed" || task.status === "superseded" || task.handoff) throw new Error(`Terminal or handed-off task cannot approve ${gate}`);
  const target = gateTarget[gate];
  if (!target) throw new Error(`Gate ${gate} cannot be approved`);
  if (task.phase === target) return { task, nextAction: nextAction(task, root), idempotent: true };
  if (task.gate !== gate || task.status !== "blocked_on_user") throw new Error(`Task must be blocked_on_user at ${gate}`);
  const errors = checkGate(root, state, taskId, gate).filter((item) => item.level === "ERROR");
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  task.evidence.push({ kind: "approval", gate, result: "pass", source, recordedAt });
  transitionTask(state, taskId, target);
  return { task, nextAction: nextAction(task, root), idempotent: false };
};

export const formatDiagnostics = (diagnostics: Diagnostic[]): string => diagnostics.map((item) => `${item.level} ${item.code}: ${item.message}`).join("\n");

export type GateViewFormat = "markdown" | "plain" | "json";

const oneLine = (value: string): string => value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").replace(/ACTION\s+REQUIRED/gi, "ACTION-REQUIRED").trim();
const markdownText = (value: string): string => oneLine(value).replace(/([\\`*_{}\[\]()<>#+.!|>~])/g, "\\$1");
const gateMeta: Record<Exclude<Gate, "none">, { icon: string; title: string; action: string }> = {
  G0_confirm: { icon: "🟢", title: "Review step · Confirm requirements", action: "Reply `ok` to confirm requirements, or state changes." },
  G1_review: { icon: "🔵", title: "Review step · Approve plan", action: "Reply `approve` to approve the plan and start implementation, or state decision changes." },
  G2_codereview: { icon: "🟣", title: "Review step · Review implementation", action: "Approve the implementation to complete the task, or point out what to fix." }
};

const artifactRows = (task: TaskState): Array<{ name: string; path: string }> => Object.entries(task.artifacts).flatMap(([name, path]) => path ? [{ name: oneLine(name), path: oneLine(path) }] : []);
const markdownLinkTarget = (value: string): string => encodeURI(value).replace(/[()#?]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

export const gateView = (task: TaskState, diagnostics: Diagnostic[]) => {
  if (task.gate === "none") throw new Error(`Task has no human gate: ${task.id}`);
  if (task.status !== "blocked_on_user") throw new Error(`Task must be blocked_on_user before presenting ${task.gate}`);
  const errors = diagnostics.filter((item) => item.level === "ERROR");
  if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
  const meta = gateMeta[task.gate];
  const decisions = task.decisions.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {});
  const latestEvidence = task.evidence.filter((item) => item.kind === "test" || item.kind === "lint" || item.kind === "review").slice(-5).map((item) => ({ kind: item.kind, result: item.result, source: oneLine(item.source) }));
  return {
    schemaVersion: 1,
    gate: task.gate,
    icon: meta.icon,
    title: meta.title,
    action: meta.action,
    task: { id: task.id, title: oneLine(task.title), status: task.status, risk: task.risk, areas: task.areas },
    artifacts: artifactRows(task),
    decisions,
    execution: task.tasks.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {}),
    evidence: latestEvidence,
    diagnostics: diagnostics.filter((item) => item.level !== "INFO").map((item) => ({ level: item.level, code: item.code, message: oneLine(item.message) }))
  };
};

export const formatGateView = (task: TaskState, diagnostics: Diagnostic[], format: GateViewFormat = "markdown"): string => {
  const view = gateView(task, diagnostics);
  if (format === "json") return `${JSON.stringify(view, null, 2)}\n`;
  const artifactText = view.artifacts.length ? view.artifacts.map((item) => format === "markdown" ? `- **${markdownText(item.name)}:** [${markdownText(item.path)}](${markdownLinkTarget(item.path)})` : `- ${item.name}: ${item.path}`).join("\n") : "- none";
  const decisionText = Object.entries(view.decisions).map(([status, count]) => `${count} ${status}`).join(" · ") || "none";
  const executionText = Object.entries(view.execution).map(([status, count]) => `${count} ${status}`).join(" · ") || "none";
  const evidenceText = view.evidence.length ? view.evidence.map((item) => `- ${item.kind}: ${item.result} — ${format === "markdown" ? markdownText(item.source) : item.source}`).join("\n") : "- none yet";
  const warningText = view.diagnostics.length ? `\n\n${view.diagnostics.map((item) => `- ${item.level} ${item.code}: ${format === "markdown" ? markdownText(item.message) : item.message}`).join("\n")}` : "";
  if (format === "plain") return [
    `[IMPORTANT] ${view.icon} ${view.title}`,
    `Task: ${view.task.id} — ${view.task.title}`,
    `Status: ${view.task.status} · Risk: ${view.task.risk} · Areas: ${view.task.areas.join(", ")}`,
    "",
    "Review artifacts",
    artifactText,
    "",
    `Decisions: ${decisionText}`,
    `Execution: ${executionText}`,
    "Evidence",
    evidenceText,
    warningText,
    "",
    `ACTION REQUIRED -> ${oneLine(view.action)}`
  ].filter((line) => line !== undefined).join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  return [
    "> [!IMPORTANT]",
    `> ${view.icon} **${view.title}**`,
    `> **Task:** \`${view.task.id}\` — ${markdownText(view.task.title)}`,
    `> **Status:** \`${view.task.status}\` · **Risk:** \`${view.task.risk}\` · **Areas:** ${view.task.areas.map((area) => `\`${markdownText(area)}\``).join(", ")}`,
    "",
    "### Review artifacts",
    artifactText,
    "",
    `**Decisions:** ${decisionText}  `,
    `**Execution:** ${executionText}`,
    "",
    "### Verification evidence",
    evidenceText,
    warningText,
    "",
    `> **ACTION REQUIRED →** ${view.action}`
  ].join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
};
