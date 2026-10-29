/**
 * Legacy v0.2.x BOARD.md migration. Parses the markdown task table into
 * canonical lifecycle state and preserves each legacy task's prose files in
 * the stable artifact layout so no legacy content is lost.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FileSpec, TaskState, WorkflowState } from "./model.js";
import { resolveProjectPath } from "./project-path.js";
import { emptyState, renderWorkplan, validateState } from "./state.js";

const safePath = (root: string, relative: string): string => resolveProjectPath(root, relative, "Unsafe upgrade path");

const parseFrontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? [] : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")]];
  }));
};

const cells = (line: string): string[] => line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ""));

/* Approval evidence is rebuilt from the row's phase: everything beyond plan implies G0 passed, etc. */
const legacyEvidence = (phase: TaskState["phase"], recordedAt: string): TaskState["evidence"] => {
  const evidence: TaskState["evidence"] = [];
  if (["plan", "build", "wrap", "done"].includes(phase)) evidence.push({ kind: "approval", gate: "G0_confirm", source: "legacy state migration", result: "pass", recordedAt });
  if (["build", "wrap", "done"].includes(phase)) evidence.push({ kind: "approval", gate: "G1_review", source: "legacy state migration", result: "pass", recordedAt });
  return evidence;
};

/** Maps one legacy BOARD row to a canonical task, copying its prose files into the stable artifact layout. */
const taskFromLegacyRow = (root: string, files: FileSpec[], row: string[], recordedAt: string): TaskState => {
  const [id, title, phaseRaw, gateRaw, statusRaw, branch, areasRaw, doc] = row;
  const oldDoc = safePath(root, doc);
  const source = existsSync(oldDoc) ? readFileSync(oldDoc, "utf8") : "";
  const frontmatter = parseFrontmatter(source);
  const stableDir = `.agents/data/tasks/${id}`;
  const prosePath = `${stableDir}/intent-design.md`;
  const workplanPath = `${stableDir}/workplan.md`;
  if (source) files.push({ path: prosePath, owner: "aidlc-state", ownershipClass: "state", content: source });
  const oldWorkplan = doc.replace(/\.md$/, ".workplan.md");
  if (existsSync(safePath(root, oldWorkplan))) files.push({ path: `${stableDir}/legacy-workplan.md`, owner: "aidlc-state", ownershipClass: "state", content: readFileSync(safePath(root, oldWorkplan), "utf8") });
  const phase = ["clarify", "plan", "build", "wrap", "done"].includes(phaseRaw) ? phaseRaw as TaskState["phase"] : "clarify";
  const gate = ["none", "G0_confirm", "G1_review", "G2_codereview"].includes(gateRaw) ? gateRaw as TaskState["gate"] : "G0_confirm";
  return {
    id,
    title,
    type: (["feature", "bug", "refactor", "infra"].includes(frontmatter.type) ? frontmatter.type : "infra") as TaskState["type"],
    phase,
    gate,
    status: (["active", "blocked_on_user", "paused", "done"].includes(statusRaw) ? statusRaw : "paused") as TaskState["status"],
    language: frontmatter.language === "en" ? "en" : "vi",
    risk: "normal",
    areas: areasRaw.split(",").map((area) => area.trim()).filter(Boolean),
    branch: branch || "—",
    artifacts: { intent: source ? prosePath : undefined, design: source ? prosePath : undefined, workplan: workplanPath },
    decisions: [],
    tasks: [],
    evidence: [...legacyEvidence(phase, recordedAt), { kind: "diagnostic", source: "legacy state migration", result: "pass", detail: `Original artifacts preserved at ${doc}`, recordedAt }],
    createdAt: recordedAt,
    updatedAt: recordedAt
  };
};

export const migrateLegacyBoard = (root: string): { state: WorkflowState; files: FileSpec[] } => {
  const boardPath = join(resolve(root), ".agents/data/state/BOARD.md");
  if (!existsSync(boardPath)) return { state: emptyState(), files: [] };
  const content = readFileSync(boardPath, "utf8");
  const state = emptyState();
  const files: FileSpec[] = [];
  let migratedRows = 0;
  for (const line of content.split("\n")) {
    if (!line.startsWith("|") || /^\|[- ]+\|/.test(line) || line.includes("| id |")) continue;
    const row = cells(line);
    if (row.length < 8) throw new Error("Legacy BOARD contains a malformed task row; refusing lossy migration");
    migratedRows += 1;
    const task = taskFromLegacyRow(root, files, row, new Date().toISOString());
    state.tasks[task.id] = task;
  }
  if (!migratedRows && !content.includes("_No tasks in flight._")) throw new Error("Legacy BOARD contains no recognizable task rows; refusing lossy migration");
  for (const task of Object.values(state.tasks)) files.push({ path: task.artifacts.workplan!, owner: "aidlc-state", ownershipClass: "state", content: renderWorkplan(task) });
  validateState(state);
  return { state, files };
};
