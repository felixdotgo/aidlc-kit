import { createHash } from "node:crypto";
import type { Gate, HandoffKind, Phase, TaskState, WorkflowState } from "../model.js";

export const emptyState = (): WorkflowState => ({ schemaVersion: 4, tasks: {}, archive: {} });
export const legacyG2WaitSource = "schema-v4-migration";

export const phases: Phase[] = ["clarify", "plan", "build", "wrap", "done"];
export const gates: Gate[] = ["none", "G0_confirm", "G1_review", "G2_codereview"];
export const handoffKinds: HandoffKind[] = ["repair_exhausted", "review_exhausted", "g2_failed", "release_failed", "structural_change", "other"];

export const terminal = (task: TaskState): boolean => task.status === "done" || task.status === "closed" || task.status === "superseded";
export const phaseGate = (phase: Phase): Gate => phase === "clarify" ? "G0_confirm" : phase === "plan" ? "G1_review" : phase === "build" ? "G2_codereview" : "none";
export const digest = (content: string): string => createHash("sha256").update(content).digest("hex");
