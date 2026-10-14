export type AgentId = string;
export type StateMutationMode = "native" | "scripted";
export type Phase = "clarify" | "plan" | "build" | "wrap" | "done";
export type Gate = "none" | "G0_confirm" | "G1_review" | "G2_codereview";
export type TaskStatus = "active" | "blocked_on_user" | "paused" | "done" | "closed" | "superseded";
export type RiskLevel = "low" | "normal" | "high" | "regulated";
export type DecisionStatus = "unresolved" | "approved" | "changed" | "dropped";
export type HandoffKind = "repair_exhausted" | "review_exhausted" | "g2_failed" | "release_failed" | "structural_change" | "other";

export interface FileSpec {
  path: string;
  content: string;
  owner: string;
  strategy?: "replace" | "managed-block";
  ownershipClass?: "managed" | "project" | "state";
}

export interface Adapter {
  id: AgentId;
  displayName: string;
  detect(root: string): boolean;
  files(): FileSpec[];
}

export interface PlannedWrite extends FileSpec {
  action: "create" | "update" | "delete" | "skip" | "conflict" | "migrate" | "preserve";
  reason: string;
  contentEncoding?: "base64";
}

export interface InitOptions {
  root: string;
  agents: AgentId[];
  all: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface Profile {
  schemaVersion: 1;
  id: string;
  extends?: string[];
  topology: string;
  discovery?: { roots?: string[]; workspaceMarkers?: string[] };
  specs?: { roots?: string[] };
  commands?: Record<string, CommandSpec>;
  rules?: { include?: string[] };
}

export interface ProjectConfig {
  schemaVersion: 1 | 2 | 3;
  extends: string[];
  specs: { roots: string[] };
  commands: Record<string, CommandSpec>;
  rules: { include: string[] };
  risk: { default: RiskLevel };
  context: { maxChars: number };
  agentState: Partial<Record<AgentId, StateMutationMode>>;
  tracker?: TrackerConfig;
  personalWork?: import('./work/model.js').PersonalWorkConfig;
  mcp: McpConfig;
}

export interface McpConfig {
  enabled: boolean;
  endpoint?: string;
  workspace?: string;
  tokenEnv?: string;
  pollMs?: number;
  providers?: Array<"jira" | "trello" | "github-issues">;
}

export interface TrackerConfig {
  enabled: boolean;
  provider: "backlog";
  spaceUrl: string;
  project: string;
  tokenEnv: string;
  workflow: "waterfall" | "scrum";
  mapping: { statuses?: Partial<Record<"clarify" | "plan" | "build" | "wrap" | "done", number>>; gateFieldId?: number };
}

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
  tasks: Array<{ id: string; label: string; status: "todo" | "in_progress" | "done" | "deferred" }>;
  evidence: Evidence[];
  lessons?: LessonRecord[];
  lessonDisposition?: LessonDisposition;
  handoff?: { kind: HandoffKind; reason: string; source: string; recordedAt: string };
  closure?: { reason: string; source: string; recordedAt: string };
  legacyG2Wait?: { migratedAt: string; source: string };
  predecessorTaskId?: string;
  successorTaskId?: string;
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

export interface ManifestInventoryItem {
  hash: string;
  owner: string;
  strategy: "replace" | "managed-block";
}

export interface WorkflowManifest {
  schemaVersion: 2;
  packageVersion: string;
  workflow: "AI-DLC";
  source: "local-package-assets";
  remoteUpdates: false;
  managedBy: "aidlc-workflow";
  adapters: AgentId[];
  files: Record<string, ManifestInventoryItem>;
}

export interface Diagnostic {
  level: "ERROR" | "WARN" | "INFO";
  code: string;
  message: string;
}
