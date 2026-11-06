/**
 * Facade for the lifecycle-state domain. Behavior-preserving re-export of the
 * split modules under `src/state/`; import paths from outside remain unchanged.
 */
export { stampLegacyG2Waits, prepareV4Migration, migrateState } from "./state/migrate.js";
export { taskRecordContent, archivedSummary } from "./state/archive-record.js";
export { emptyState, legacyG2WaitSource, phases, gates, handoffKinds, terminal, phaseGate, digest } from "./state/domain.js";
export { iso, text, idPattern, audited, tokens, assertTaskArtifactPath } from "./state/guards.js";
export { assertNoSymlinkPath, writeAtomic, parseJsonText, parseJsonFile } from "./state/io.js";
export { type NextAction, readyTaskItems, nextAction } from "./state/items.js";
export { recordLesson, recordNoLessons, lessonStateDigest, createLessonIndex, rebuildLessonIndex, searchLessons } from "./state/lessons.js";
export { handoffTask, closeTask, supersedeTask, reopenTask } from "./state/lifecycle.js";
export { type StateLockOptions, acquireStateLock } from "./state/lock.js";
export { emptyMemoryRegistry, validateMemoryRegistry, loadMemoryRegistry, saveMemoryRegistry, selectAgenticMemory, promoteAgenticMemory, retireAgenticMemory } from "./state/memory.js";
export { statePath, lessonIndexPath, memoryRegistryPath, stateLockPath, stateLockGuardPath, archiveRecordPath } from "./state/paths.js";
export { type TaskSummary, listTaskSummaries, renderWorkplan, renderViews } from "./state/render.js";
export { pathOverlaps, pathsOverlap, concurrentItemPairs, partitionDiagnostics, loopPartitionStrict, workplanScope } from "./state/partition.js";
export { loadState, loadTask, saveState } from "./state/store.js";
export { latestApproval, buildBoundary, hasApproval, hasCurrentBuildApproval, hasAreaVerification, hasVerification, hasReview, type RepairBounds, repairBounds, isLegacyG2Wait, transitionDiagnostics, transitionTask } from "./state/transitions.js";
export { validateLesson, validateTask, validateState } from "./state/validate.js";
