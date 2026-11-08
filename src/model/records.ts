/* Canonical task and state record contracts (schema v1–v4). */
import type { DecisionStatus, Gate, HandoffKind, Phase, RiskLevel, TaskStatus } from "./lifecycle-enums.js";

export interface TaskDecision {
  id: string;
  label: string;
  status: DecisionStatus;
  resolution?: string;
}

export interface Evidence {
  kind: "approval" | "spec" | "test" | "lint" | "review" | "diagnostic";
  gate?: Gate;
  area?: string;
  source: string;
  result: "pass" | "fail" | "skip";
  detail?: string;
  recordedAt: string;
}

export interface LessonRecord {
  id: string;
  taskId: string;
  areas: string[];
  summary: string;
  prevention: string;
  example: string;
  promotion: string;
  source: string;
  recordedAt: string;
}

export interface LessonDisposition {
  status: "captured" | "none";
  reason?: string;
  source: string;
  recordedAt: string;
}

export interface TaskState {
  id: string;
  featureId?: string;
  title: string;
  type: "feature" | "bug" | "refactor" | "infra";
  phase: Phase;
  gate: Gate;
  status: TaskStatus;
  language: "vi" | "en";
  risk: RiskLevel;
  areas: string[];
  branch: string;
  artifacts: { intent?: string; design?: string; workplan?: string };
  decisions: TaskDecision[];
  tasks: Array<{ id: string; label: string; status: "todo" | "in_progress" | "done" | "deferred"; dependsOn?: string[]; ownedPaths?: string[] }>;
  evidence: Evidence[];
  lessons?: LessonRecord[];
  lessonDisposition?: LessonDisposition;
  handoff?: { kind: HandoffKind; reason: string; source: string; recordedAt: string };
  closure?: { reason: string; source: string; recordedAt: string };
  legacyG2Wait?: { migratedAt: string; source: string };
  predecessorTaskId?: string;
  successorTaskId?: string;
  /** Repository HEAD when the task was created (lowercase hex SHA, 7-64 chars). */
  baseCommit?: string;
  /** Repository HEAD when the task reached done (lowercase hex SHA, 7-64 chars). */
  finalCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  schemaVersion: 1 | 2 | 3 | 4;
  tasks: Record<string, TaskState>;
  archive?: Record<string, ArchivedTaskSummary>;
}

export interface ArchivedTaskSummary {
  id: string;
  title: string;
  type: TaskState["type"];
  phase: Phase;
  gate: Gate;
  status: "done" | "closed" | "superseded";
  risk: RiskLevel;
  areas: string[];
  record: string;
  digest: string;
  lessonCount: number;
  predecessorTaskId?: string;
  successorTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LessonIndexEntry {
  id: string;
  taskId: string;
  areas: string[];
  summary: string;
  prevention: string;
  source: string;
  recordedAt: string;
}

export interface LessonIndex {
  schemaVersion: 1;
  sourceDigest: string;
  lessons: LessonIndexEntry[];
}

export interface AgenticMemoryEntry {
  id: string;
  summary: string;
  guidance: string;
  areas: string[];
  phases: Array<Exclude<Phase, "done"> | "*">;
  priority: number;
  sourceTaskId: string;
  sourceLessonId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface AgenticMemoryRegistry {
  schemaVersion: 1;
  entries: AgenticMemoryEntry[];
  retired: Array<AgenticMemoryEntry & { retiredBy: string; retiredAt: string; reason: string }>;
}
