import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ArchivedTaskSummary, Gate, HandoffKind, Phase, TaskState, WorkflowState } from "../model.js";
import { resolveProjectPathWithoutSymlinks } from "../project-path.js";

export const statePath = (root: string): string => join(resolve(root), ".agents/data/state/aidlc-state.json");
export const lessonIndexPath = (root: string): string => join(resolve(root), ".agents/data/lessons/index.json");
export const memoryRegistryPath = (root: string): string => join(resolve(root), ".agents/data/memory/agentic-memory.json");
export const stateLockPath = (root: string): string => join(resolve(root), ".agents/data/state/.aidlc-state.lock");
export const stateLockGuardPath = (root: string): string => join(resolve(root), ".agents/data/state/.aidlc-state.lock.guard");
export const emptyState = (): WorkflowState => ({ schemaVersion: 4, tasks: {}, archive: {} });
export const legacyG2WaitSource = "schema-v4-migration";

export const phases: Phase[] = ["clarify", "plan", "build", "wrap", "done"];
export const gates: Gate[] = ["none", "G0_confirm", "G1_review", "G2_codereview"];
export const handoffKinds: HandoffKind[] = ["repair_exhausted", "review_exhausted", "g2_failed", "release_failed", "structural_change", "other"];

export const terminal = (task: TaskState): boolean => task.status === "done" || task.status === "closed" || task.status === "superseded";
export const phaseGate = (phase: Phase): Gate => phase === "clarify" ? "G0_confirm" : phase === "plan" ? "G1_review" : phase === "build" ? "G2_codereview" : "none";
export const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
export const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
export const archiveRecordPath = (id: string): string => `.agents/data/state/archive/${id}.json`;
export const taskRecordContent = (task: TaskState): string => `${JSON.stringify(task, null, 2)}\n`;

export const assertNoSymlinkPath = (root: string, relative: string): void => {
  resolveProjectPathWithoutSymlinks(root, relative, "Unsafe state path", "State path crosses a symlink");
};

export const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
};

export const parseJsonText = (content: string, label: string, recovery = ""): unknown => {
  try { return JSON.parse(content); }
  catch (error) { throw new Error(`${label} is corrupted or unreadable: ${error instanceof Error ? error.message : String(error)}${recovery ? `; ${recovery}` : ""}`); }
};

export const parseJsonFile = (path: string, label: string, recovery = ""): unknown => parseJsonText(readFileSync(path, "utf8"), label, recovery);

export const audited = (reason: string, source: string): void => {
  if (!text(reason) || !text(source)) throw new Error("Lifecycle mutation requires non-empty --reason and --source");
};

export const tokens = (value: string): string[] => [...new Set(value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1))];

/** Rejects artifact paths that escape the project-owned tasks directory. */
export const assertTaskArtifactPath = (id: string, path: string): void => {
  const separator = process.platform === "win32" ? "\\" : "/";
  const cleaned = normalize(path);
  if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${separator}`) || !cleaned.startsWith(`.agents${separator}data${separator}tasks${separator}`)) {
    throw new Error(`Invalid artifact path for ${id}: ${path}`);
  }
};

/** Builds the immutable archive-catalog summary for a terminal task from its record content. */
export const archivedSummary = (task: TaskState, content = taskRecordContent(task)): ArchivedTaskSummary => ({
  id: task.id,
  title: task.title,
  type: task.type,
  phase: task.phase,
  gate: task.gate,
  status: task.status as ArchivedTaskSummary["status"],
  risk: task.risk,
  areas: task.areas,
  record: archiveRecordPath(task.id),
  digest: digest(content),
  lessonCount: task.lessons?.length ?? 0,
  predecessorTaskId: task.predecessorTaskId,
  successorTaskId: task.successorTaskId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt
});
