/* Domain enumerations for the task lifecycle. */
export type AgentId = string;
export type StateMutationMode = "native" | "scripted";
export type Phase = "clarify" | "plan" | "build" | "wrap" | "done";
export type Gate = "none" | "G0_confirm" | "G1_review" | "G2_codereview";
export type TaskStatus = "active" | "blocked_on_user" | "paused" | "done" | "closed" | "superseded";
export type RiskLevel = "low" | "normal" | "high" | "regulated";
export type DecisionStatus = "unresolved" | "approved" | "changed" | "dropped";
export type HandoffKind = "repair_exhausted" | "review_exhausted" | "g2_failed" | "release_failed" | "structural_change" | "other";

/* Shared diagnostic vocabulary emitted by gate and transition checks. */
export interface Diagnostic {
  level: "ERROR" | "WARN" | "INFO";
  code: string;
  message: string;
}
