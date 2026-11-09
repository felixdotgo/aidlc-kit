/**
 * Facade for the lifecycle-state domain. Behavior-preserving re-export of the
 * canonical shared module plus TypeScript-only helpers; import paths from
 * outside remain unchanged. All lifecycle logic delegates to the canonical
 * `.mjs` module (`assets/aidlc/scripts/lib/store.mjs`).
 */
export {
  acquireStateLock, archivedSummary, assertNoSymlinkPath, buildBoundary, closeTask, concurrentItemPairs,
  createLessonIndex, digest, emptyMemoryRegistry, emptyState, handoffTask, hasApproval, hasAreaVerification,
  hasCurrentBuildApproval, hasReview, hasVerification, isLegacyG2Wait, latestApproval, legacyG2WaitSource,
  lessonStateDigest, listTaskSummaries, loadMemoryRegistry, loadState, loadTask, loopPartitionStrict,
  migrateState, nextAction, partitionDiagnostics, pathOverlaps, pathsOverlap, promoteAgenticMemory,
  readyTaskItems, rebuildLessonIndex, recordLesson, recordNoLessons, renderViews, renderWorkplan, reopenTask,
  repairBounds, retireAgenticMemory, safeResolvedPath, saveMemoryRegistry, saveState, searchLessons,
  selectAgenticMemory, stampLegacyG2Waits, supersedeTask, taskRecordContent, terminal, transitionDiagnostics,
  transitionTask, validateMemoryRegistry, validateState, workplanScope, writeAtomic
} from "./state/shared.js";
export type { NextAction, NextActionActions, RepairBounds, StateLockOptions, TaskSummary } from "./state/shared.js";
export { assertTaskArtifactPath } from "./state/guards.js";
export { prepareV4Migration } from "./state/migrate.js";
export { archiveRecordPath, dbPathRelative, lessonIndexPath, memoryRegistryPath, stateLockGuardPath, stateLockPath, statePath } from "./state/paths.js";
