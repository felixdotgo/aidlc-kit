/**
 * Facade for the shared type hub. Behavior-preserving re-export of the split
 * modules under `src/model/`; import paths from outside remain unchanged.
 */
export type { AgentId, StateMutationMode, Phase, Gate, TaskStatus, RiskLevel, DecisionStatus, HandoffKind, Diagnostic } from "./model/lifecycle-enums.js";
export type { FileSpec, Adapter, PlannedWrite, InitOptions } from "./model/install-contracts.js";
export type { LoopMode, LoopAgent, LoopConfig } from "./model/loop.js";
export { LOOP_PROVIDERS } from "./model/loop.js";
export type { CommandSpec, Profile, ProjectConfig, McpConfig, TrackerConfig } from "./model/config-contracts.js";
export type { TaskDecision, Evidence, LessonRecord, LessonDisposition, TaskState, WorkflowState, ArchivedTaskSummary, LessonIndexEntry, LessonIndex, AgenticMemoryEntry, AgenticMemoryRegistry } from "./model/records.js";
export type { ManifestInventoryItem, WorkflowManifest } from "./model/manifest.js";
