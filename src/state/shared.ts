/**
 * Thin typed facade over the canonical AI-DLC store module
 * (`assets/aidlc/scripts/lib/store.mjs`). The canonical module is the single
 * source of lifecycle logic shared by the installed scripts, the coordination
 * service, and this TypeScript side; every export here delegates to it.
 */
// @ts-expect-error canonical ESM module ships without type declarations
import * as canonical from "../../assets/aidlc/scripts/lib/store.mjs";
import type { AgenticMemoryEntry, AgenticMemoryRegistry, ArchivedTaskSummary, Diagnostic, Evidence, Gate, HandoffKind, LessonIndex, LessonIndexEntry, LessonRecord, Phase, TaskState, WorkflowState } from "../model.js";

export interface StateLockOptions { timeoutMs?: number; retryMs?: number; staleMs?: number; }
export interface TaskSummary { id: string; title: string; phase: Phase; gate: Gate; status: TaskState["status"]; risk: TaskState["risk"]; areas: string[]; updatedAt: string; source: "active" | "archive" }
export interface RepairBounds { verifyFailures: Record<string, number>; reviewFailures: number; exhaustedAreas: string[]; verifyExhausted: boolean; reviewExhausted: boolean; }
export type NextActionActions = Array<{ id: "reopen_g1" | "create_successor" | "supersede" | "close" | "record_handoff" | "resume"; command: string }>;
export interface NextAction {
  classification: "await_user" | "run_phase" | "blocked" | "terminal" | "complete";
  phase: Phase;
  gate: Gate;
  command?: string;
  outcome?: "closed" | "superseded";
  successorTaskId?: string;
  itemId?: string;
  remainingItems?: number;
  actions?: NextActionActions;
  reason: string;
}
type Item = TaskState["tasks"][number];

/* Storage helpers */
export const digest = (content: string): string => canonical.digest(content);
export const terminal = (task: TaskState): boolean => canonical.terminal(task);
export const taskRecordContent = (task: TaskState): string => canonical.taskRecordContent(task);
export const archivedSummary = (task: TaskState, content?: string): ArchivedTaskSummary => canonical.archivedSummary(task, content) as ArchivedTaskSummary;
export const assertNoSymlinkPath = (root: string, relative: string): void => canonical.assertNoSymlinkPath(root, relative);
export const safeResolvedPath = (root: string, relative: string): string => canonical.safeResolvedPath(root, relative);
export const writeAtomic = (path: string, content: string): void => canonical.writeAtomic(path, content);

/* Canonical state persistence */
export const emptyState = (): WorkflowState => canonical.emptyState();
export const legacyG2WaitSource: string = canonical.legacyG2WaitSource;
export const loadState = (root: string): WorkflowState => canonical.loadState(root);
export const loadTask = (root: string, id: string, state?: WorkflowState): TaskState | undefined => canonical.loadTask(root, id, state);
export const saveState = (root: string, state: WorkflowState): string[] => canonical.saveState(root, state);
export const validateState = (value: unknown): WorkflowState => canonical.validateState(value);
export const acquireStateLock = (root: string, options: StateLockOptions = {}): (() => void) => canonical.acquireStateLock(root, options);

/* Migration */
export const stampLegacyG2Waits = (state: WorkflowState): string[] => canonical.stampLegacyG2Waits(state);
export const migrateState = (root: string, state?: WorkflowState): { migrated: boolean; archived: string[]; stamped: string[] } => canonical.migrateState(root, state);

/* Transitions */
export const latestApproval = (task: TaskState, gate: Gate): Evidence | undefined => canonical.latestApproval(task, gate);
export const buildBoundary = (task: TaskState): number | undefined => canonical.buildBoundary(task);
export const hasApproval = (task: TaskState, gate: Gate): boolean => canonical.hasApproval(task, gate);
export const hasCurrentBuildApproval = (task: TaskState, gate: Gate): boolean => canonical.hasCurrentBuildApproval(task, gate);
export const hasAreaVerification = (task: TaskState, area: string): boolean => canonical.hasAreaVerification(task, area);
export const hasVerification = (task: TaskState): boolean => canonical.hasVerification(task);
export const hasReview = (task: TaskState): boolean => canonical.hasReview(task);
export const repairBounds = (task: TaskState): RepairBounds => canonical.repairBounds(task);
export const isLegacyG2Wait = (task: TaskState): boolean => canonical.isLegacyG2Wait(task);
export const transitionDiagnostics = (task: TaskState, target: Phase): Diagnostic[] => canonical.transitionDiagnostics(task, target);
export const transitionTask = (state: WorkflowState, id: string, target: Phase): TaskState => canonical.transitionTask(state, id, target);

/* Lifecycle mutations */
export const handoffTask = (state: WorkflowState, id: string, kind: HandoffKind, reason: string, source: string, recordedAt?: string): TaskState => canonical.handoffTask(state, id, kind, reason, source, recordedAt);
export const closeTask = (state: WorkflowState, id: string, reason: string, source: string, recordedAt?: string): TaskState => canonical.closeTask(state, id, reason, source, recordedAt);
export const supersedeTask = (state: WorkflowState, id: string, successorId: string, reason: string, source: string, recordedAt?: string): TaskState => canonical.supersedeTask(state, id, successorId, reason, source, recordedAt);
export const reopenTask = (state: WorkflowState, id: string, target: "plan", reason: string, source: string, recordedAt?: string): TaskState => canonical.reopenTask(state, id, target, reason, source, recordedAt);

/* Items and next action */
export const readyTaskItems = (task: TaskState): { ready: string[]; blocked: Array<{ id: string; waitingOn: string[] }> } => canonical.readyTaskItems(task);
export const nextAction = (task: TaskState, root?: string): NextAction => canonical.nextAction(task, root);

/* Partition */
export const pathOverlaps = (left: string, right: string): boolean => canonical.pathOverlaps(left, right);
export const pathsOverlap = (left: readonly string[] = [], right: readonly string[] = []): boolean => canonical.pathsOverlap(left, right);
export const concurrentItemPairs = (task: TaskState): Array<[Item, Item]> => canonical.concurrentItemPairs(task);
export const partitionDiagnostics = (task: TaskState, options: { strict?: boolean } = {}): Diagnostic[] => canonical.partitionDiagnostics(task, options);
export const loopPartitionStrict = (root: string | undefined): boolean => canonical.loopPartitionStrict(root);
export const workplanScope = (item: Item): string => canonical.workplanScope(item);

/* Lessons */
export const recordLesson = (task: TaskState, lesson: Omit<LessonRecord, "taskId" | "recordedAt">, recordedAt?: string): LessonRecord => canonical.recordLesson(task, lesson, recordedAt);
export const recordNoLessons = (task: TaskState, reason: string, source: string, recordedAt?: string): void => canonical.recordNoLessons(task, reason, source, recordedAt);
export const lessonStateDigest = (state: WorkflowState): string => canonical.lessonStateDigest(state);
export const createLessonIndex = (lessons: LessonRecord[], sourceDigest?: string): LessonIndex => canonical.createLessonIndex(lessons, sourceDigest);
export const rebuildLessonIndex = (root: string, state?: WorkflowState): LessonIndex => canonical.rebuildLessonIndex(root, state);
export const searchLessons = (root: string, state: WorkflowState, query: string, areas?: string[], limit?: number): LessonIndexEntry[] => canonical.searchLessons(root, state, query, areas, limit);

/* Agentic memory */
export const emptyMemoryRegistry = (): AgenticMemoryRegistry => canonical.emptyMemoryRegistry();
export const validateMemoryRegistry = (value: unknown): AgenticMemoryRegistry => canonical.validateMemoryRegistry(value);
export const loadMemoryRegistry = (root: string): AgenticMemoryRegistry => canonical.loadMemoryRegistry(root);
export const saveMemoryRegistry = (root: string, registry: AgenticMemoryRegistry): void => canonical.saveMemoryRegistry(root, registry);
export const selectAgenticMemory = (registry: AgenticMemoryRegistry, areas: string[], phase: Exclude<Phase, "done"> | "*", maxChars: number): AgenticMemoryEntry[] => canonical.selectAgenticMemory(registry, areas, phase, maxChars);
export const promoteAgenticMemory = (root: string, entry: AgenticMemoryEntry): AgenticMemoryEntry => canonical.promoteAgenticMemory(root, entry);
export const retireAgenticMemory = (root: string, id: string, reason: string, retiredBy: string, retiredAt?: string): AgenticMemoryEntry => canonical.retireAgenticMemory(root, id, reason, retiredBy, retiredAt);

/* Rendering */
export const listTaskSummaries = (state: WorkflowState, options: { includeArchive?: boolean; statuses?: string[]; query?: string; limit?: number; cursor?: number } = {}): { items: TaskSummary[]; nextCursor: string | null; total: number } => canonical.listTaskSummaries(state, options);
export const renderWorkplan = (task: TaskState): string => canonical.renderWorkplan(task);
export const renderViews = (root: string, state?: WorkflowState, selected?: TaskState[]): void => canonical.renderViews(root, state, selected);
