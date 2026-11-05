import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findAdapter, resolvedAdapters } from "./adapters.js";
import { legacyV021AdapterContents, legacyV021Hashes } from "./legacy.js";
import type { AgentId, FileSpec, LoopConfig, PlannedWrite, WorkflowManifest, WorkflowState } from "./model.js";
import { planProjectLayoutMigration } from "./project-migration.js";
import { legacyManifest, managedContentHash, planLoopSelection, planManagedWrites, preserveOwnedFile, readManifest, splitInventoryKey } from "./managed-planning.js";
import type { UpgradePlanPolicy } from "./managed-planning.js";
import { resolveProjectPath, resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { prepareV4Migration, validateState } from "./state.js";
import { contentHash, coreWorkflowFiles, initialProjectFiles, manifestSpec } from "./workflow.js";
import { migrateLegacyBoard } from "./upgrade-board.js";

const safePath = (root: string, relative: string): string => resolveProjectPath(root, relative, "Unsafe upgrade path");
const assertNoSymlinkPath = (root: string, relative: string): void => { resolveProjectPathWithoutSymlinks(root, relative, "Unsafe upgrade path", "Refusing to upgrade symlink path"); };

/* --- Managed file planning -------------------------------------------------- */

/** Upgrade's planning policy: ownership is proven against installed hashes and the frozen v0.2.1 baselines. */
const upgradePlanPolicy = (installed: WorkflowManifest | undefined, legacy: boolean): UpgradePlanPolicy => ({
  flow: "upgrade",
  installed,
  legacy,
  resolvePath: safePath,
  legacyBaseline: (spec, currentHash) => {
    const legacyAdapter = legacyV021AdapterContents[spec.path];
    const legacyAdapterHash = legacyAdapter ? contentHash(spec.strategy === "managed-block" ? legacyAdapter.trimEnd() : legacyAdapter) : undefined;
    return legacyV021Hashes[spec.path] === currentHash || legacyAdapterHash === currentHash;
  }
});

/** Deletes obsolete managed files tracked by the installed manifest that no longer ship in this release. */
const planObsoleteRemovals = (project: string, plan: PlannedWrite[], installed: WorkflowManifest, managed: FileSpec[]): void => {
  for (const [key, item] of Object.entries(installed.files)) {
    const path = splitInventoryKey(key).path;
    // Shared prompt blocks are upgraded through the merged plan above; never delete their whole path here.
    if (item.strategy === "managed-block") continue;
    if (managed.some((spec) => spec.path === path)) continue;
    const target = safePath(project, path);
    if (!existsSync(target)) continue;
    const current = readFileSync(target, "utf8");
    const hash = managedContentHash({ owner: item.owner, strategy: item.strategy }, current);
    plan.push({ path, owner: item.owner, strategy: item.strategy, ownershipClass: "managed", content: "", action: hash === item.hash ? "delete" : "conflict", reason: hash === item.hash ? "obsolete unchanged managed file" : "obsolete managed file was modified" });
  }
};

const preserveProjectFiles = (project: string, plan: PlannedWrite[], legacy: boolean): void => {
  for (const spec of initialProjectFiles()) {
    if (legacy && spec.path === ".agents/data/state/aidlc-state.json" && !existsSync(safePath(project, spec.path))) continue;
    plan.push(preserveOwnedFile(safePath(project, spec.path), spec));
  }
};

/* --- Canonical state and legacy BOARD migration -------------------------------- */

/** Migrates a preserved canonical state file (schema v1–v3) to v4 with immutable archived-task records. */
const migrateCanonicalState = (project: string, plan: PlannedWrite[], canonicalState: PlannedWrite): void => {
  if (canonicalState.action !== "preserve") return;
  const parsed = JSON.parse(canonicalState.content) as WorkflowState;
  const normalized = validateState(parsed);
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) return;
  const migration = prepareV4Migration(normalized);
  canonicalState.content = `${JSON.stringify(migration.state, null, 2)}\n`;
  canonicalState.action = "migrate";
  canonicalState.reason = `migrate canonical state schema v${parsed.schemaVersion} to v4 compact catalog${migration.stamped.length ? ` and stamp pre-existing ready G2 waits: ${migration.stamped.join(", ")}` : " without changing task content"}`;
  for (const record of migration.records) {
    assertNoSymlinkPath(project, record.path);
    const target = safePath(project, record.path);
    if (!existsSync(target)) plan.push({ path: record.path, owner: "aidlc-state", ownershipClass: "state", content: record.content, action: "migrate", reason: "write immutable terminal task record" });
    else if (readFileSync(target, "utf8") !== record.content) plan.push({ path: record.path, owner: "aidlc-state", ownershipClass: "state", content: record.content, action: "conflict", reason: "terminal task record conflicts with prior canonical content" });
  }
  const lessonIndex = plan.find((item) => item.path === ".agents/data/lessons/index.json");
  if (!lessonIndex) throw new Error("Lesson index plan is missing");
  lessonIndex.content = `${JSON.stringify(migration.lessonIndex, null, 2)}\n`;
  lessonIndex.action = "migrate";
  lessonIndex.reason = "build derived lesson index from canonical task records";
};

/** Seeds the plan from a legacy BOARD.md when no canonical state file exists yet. */
const migrateLegacyState = (project: string, plan: PlannedWrite[], legacy: boolean): void => {
  if (!legacy || existsSync(safePath(project, ".agents/data/state/aidlc-state.json"))) return;
  const migration = migrateLegacyBoard(project);
  const compact = prepareV4Migration(migration.state);
  plan.push({ path: ".agents/data/state/aidlc-state.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(compact.state, null, 2)}\n`, action: "migrate", reason: "migrate legacy BOARD to canonical v4 state" });
  for (const record of compact.records) plan.push({ path: record.path, owner: "aidlc-state", ownershipClass: "state", content: record.content, action: "migrate", reason: "preserve legacy terminal task as immutable record" });
  const lessonIndex = plan.find((item) => item.path === ".agents/data/lessons/index.json");
  if (lessonIndex) { lessonIndex.content = `${JSON.stringify(compact.lessonIndex, null, 2)}\n`; lessonIndex.action = "migrate"; lessonIndex.reason = "build derived lesson index during legacy migration"; }
  for (const file of migration.files) plan.push({ ...file, action: "migrate", reason: "preserve legacy task prose in stable task directory" });
};

/** Removes the duplicate BOARD.md projection only when the planned canonical state validates. */
const removeLegacyBoard = (project: string, plan: PlannedWrite[]): void => {
  const boardPath = safePath(project, ".agents/data/state/BOARD.md");
  if (!existsSync(boardPath)) return;
  const stateItem = plan.find((item) => item.path === ".agents/data/state/aidlc-state.json");
  if (!stateItem) throw new Error("Canonical state must be present before removing legacy BOARD");
  validateState(JSON.parse(stateItem.content));
  plan.push({ path: ".agents/data/state/BOARD.md", owner: "aidlc-state", ownershipClass: "state", content: "", action: "delete", reason: "remove duplicate lifecycle-state projection after canonical JSON validation" });
};

/* --- planUpgrade orchestration ------------------------------------------------ */

/** Selects which adapters to upgrade: manifest-registered ones, else auto-detected installable ones. */
const selectedUpgradeAgents = (project: string, installed: WorkflowManifest | undefined): AgentId[] => {
  const upgradeAdapters = resolvedAdapters();
  const requested: AgentId[] = installed?.adapters?.length ? installed.adapters : upgradeAdapters.filter((adapter) => adapter.detect(project)).map((adapter) => adapter.id);
  return requested.filter((id) => findAdapter(id));
};

const agentUpgradeFiles = (selected: AgentId[]): FileSpec[] => selected.flatMap((id) => findAdapter(id)?.files() ?? []).map((file) => ({ ...file, ownershipClass: "managed" as const }));

/** Plans an upgrade transaction from the installed manifest to the current package. */
export const planUpgrade = (root: string, loop?: LoopConfig): PlannedWrite[] => {
  const project = resolve(root);
  const installed = readManifest(project);
  const legacy = !installed && legacyManifest(project);
  if (!installed && !legacy) throw new Error("No owned AI-DLC installation found. Use init instead of upgrade.");
  const selected = selectedUpgradeAgents(project, installed);
  const managed = [...coreWorkflowFiles(), ...agentUpgradeFiles(selected)];
  const plan = planManagedWrites(project, managed, upgradePlanPolicy(installed, legacy));
  if (installed) planObsoleteRemovals(project, plan, installed, managed);
  preserveProjectFiles(project, plan, legacy);
  const canonicalState = plan.find((item) => item.path === ".agents/data/state/aidlc-state.json");
  if (canonicalState) migrateCanonicalState(project, plan, canonicalState);
  planProjectLayoutMigration(project, plan);
  migrateLegacyState(project, plan, legacy);
  removeLegacyBoard(project, plan);
  plan.push({ ...manifestSpec(managed, selected), action: "update", reason: legacy ? "migrate manifest to schema v2" : "update manifest inventory" });
  planLoopSelection(plan, loop);
  return plan;
};

/* --- Staged apply with backup and rollback ------------------------------------ */

export interface UpgradeResult { backup: string; changed: number; }

interface UpgradeJournalEntry { path: string; existed: boolean; action: string }

/** Copies each affected original into the backup and stages the new content outside the live tree. */
const stageUpgradedWrites = (project: string, writes: PlannedWrite[], backup: string, stage: string, journal: UpgradeJournalEntry[]): void => {
  for (const item of writes) {
    const target = safePath(project, item.path);
    assertNoSymlinkPath(project, item.path);
    const existed = existsSync(target);
    journal.push({ path: item.path, existed, action: item.action });
    if (existed) {
      const destination = join(backup, item.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(target, destination);
    }
    if (item.action !== "delete") {
      const staged = join(stage, item.path);
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, item.contentEncoding === "base64" ? Buffer.from(item.content, "base64") : item.content);
      if (item.path.endsWith(".json") && item.contentEncoding !== "base64") JSON.parse(item.content);
    }
  }
};

const writeUpgradeJournal = (backup: string, journal: UpgradeJournalEntry[]): void => {
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
};

const commitStagedWrites = (project: string, writes: PlannedWrite[], stage: string): void => {
  for (const item of writes) {
    const target = safePath(project, item.path);
    if (item.action === "delete") rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(join(stage, item.path), target);
    }
  }
};

const pruneEmptyDirectories = (directory: string): void => {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) pruneEmptyDirectories(join(directory, entry.name));
  if (readdirSync(directory).length === 0) rmdirSync(directory);
};

/** Restores the journaled originals so a failed upgrade leaves no partial state. */
const restoreFromJournal = (project: string, journal: UpgradeJournalEntry[], backup: string): void => {
  for (const entry of journal.reverse()) {
    const target = safePath(project, entry.path);
    const source = join(backup, entry.path);
    if (entry.existed && existsSync(source)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    } else if (!entry.existed) rmSync(target, { force: true });
  }
};

/** Applies a planned upgrade transaction with backup and rollback on failure. */
export const applyUpgrade = (root: string, plan: PlannedWrite[]): UpgradeResult => {
  const conflicts = plan.filter((item) => item.action === "conflict");
  if (conflicts.length) throw new Error(`Upgrade has ${conflicts.length} conflict(s); no files were written`);
  const project = resolve(root);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRelative = `.agents/data/state/backups/upgrade-${id}`;
  const backup = safePath(project, backupRelative);
  const stage = safePath(project, `.agents/data/state/.upgrade-stage-${id}`);
  const writes = plan.filter((item) => ["create", "update", "delete", "migrate"].includes(item.action));
  mkdirSync(stage, { recursive: true });
  const journal: UpgradeJournalEntry[] = [];
  try {
    stageUpgradedWrites(project, writes, backup, stage, journal);
    writeUpgradeJournal(backup, journal);
    commitStagedWrites(project, writes, stage);
    pruneEmptyDirectories(safePath(project, ".aidlc"));
    rmSync(stage, { recursive: true, force: true });
    return { backup: backupRelative, changed: writes.length };
  } catch (error) {
    restoreFromJournal(project, journal, backup);
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
};
