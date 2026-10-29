import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findAdapterForUpgrade, resolvedAdaptersForUpgrade } from "./adapters.js";
import { managedContentHash, planLoopSelection, readManifest } from "./installer.js";
import { legacyV021AdapterContents, legacyV021Hashes } from "./legacy.js";
import type { AgentId, FileSpec, LoopConfig, PlannedWrite, TaskState, WorkflowState } from "./model.js";
import { planProjectLayoutMigration } from "./project-migration.js";
import { mergeManagedBlock } from "./managed-content.js";
import { resolveProjectPath, resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { emptyState, prepareV4Migration, renderWorkplan, validateState } from "./state.js";
import { contentHash, coreWorkflowFiles, initialProjectFiles, manifestSpec } from "./workflow.js";

const safePath = (root: string, relative: string): string => resolveProjectPath(root, relative, "Unsafe upgrade path");
const assertNoSymlinkPath = (root: string, relative: string): void => { resolveProjectPathWithoutSymlinks(root, relative, "Unsafe upgrade path", "Refusing to upgrade symlink path"); };

const legacyManifest = (root: string): boolean => {
  const path = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { managedBy?: string; schemaVersion?: number };
    return parsed.managedBy === "aidlc-workflow" && (parsed.schemaVersion === 0 || parsed.schemaVersion === 1);
  } catch { return false; }
};

const parseFrontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split("\n").flatMap((line) => {
    const separator = line.indexOf(":");
    return separator < 0 ? [] : [[line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")]];
  }));
};

const cells = (line: string): string[] => line.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, ""));

export const migrateLegacyBoard = (root: string): { state: WorkflowState; files: FileSpec[] } => {
  const boardPath = join(resolve(root), ".agents/data/state/BOARD.md");
  if (!existsSync(boardPath)) return { state: emptyState(), files: [] };
  const state = emptyState();
  const files: FileSpec[] = [];
  const boardContent = readFileSync(boardPath, "utf8");
  let migratedRows = 0;
  for (const line of boardContent.split("\n")) {
    if (!line.startsWith("|") || /^\|[- ]+\|/.test(line) || line.includes("| id |")) continue;
    const row = cells(line);
    if (row.length < 8) throw new Error("Legacy BOARD contains a malformed task row; refusing lossy migration");
    const [id, title, phaseRaw, gateRaw, statusRaw, branch, areasRaw, doc] = row;
    migratedRows += 1;
    const oldDoc = safePath(root, doc);
    const source = existsSync(oldDoc) ? readFileSync(oldDoc, "utf8") : "";
    const frontmatter = parseFrontmatter(source);
    const stableDir = `.agents/data/tasks/${id}`;
    const prosePath = `${stableDir}/intent-design.md`;
    const workplanPath = `${stableDir}/workplan.md`;
    if (source) files.push({ path: prosePath, owner: "aidlc-state", ownershipClass: "state", content: source });
    const oldWorkplan = doc.replace(/\.md$/, ".workplan.md");
    if (existsSync(safePath(root, oldWorkplan))) files.push({ path: `${stableDir}/legacy-workplan.md`, owner: "aidlc-state", ownershipClass: "state", content: readFileSync(safePath(root, oldWorkplan), "utf8") });
    const phase = ["clarify", "plan", "build", "wrap", "done"].includes(phaseRaw) ? phaseRaw as TaskState["phase"] : "clarify";
    const gate = ["none", "G0_confirm", "G1_review", "G2_codereview"].includes(gateRaw) ? gateRaw as TaskState["gate"] : "G0_confirm";
    const evidence: TaskState["evidence"] = [];
    const now = new Date().toISOString();
    if (["plan", "build", "wrap", "done"].includes(phase)) evidence.push({ kind: "approval", gate: "G0_confirm", source: "legacy state migration", result: "pass", recordedAt: now });
    if (["build", "wrap", "done"].includes(phase)) evidence.push({ kind: "approval", gate: "G1_review", source: "legacy state migration", result: "pass", recordedAt: now });
    state.tasks[id] = {
      id,
      title,
      type: (["feature", "bug", "refactor", "infra"].includes(frontmatter.type) ? frontmatter.type : "infra") as TaskState["type"],
      phase,
      gate,
      status: (["active", "blocked_on_user", "paused", "done"].includes(statusRaw) ? statusRaw : "paused") as TaskState["status"],
      language: frontmatter.language === "en" ? "en" : "vi",
      risk: "normal",
      areas: areasRaw.split(",").map((area) => area.trim()).filter(Boolean),
      branch: branch || "—",
      artifacts: { intent: source ? prosePath : undefined, design: source ? prosePath : undefined, workplan: workplanPath },
      decisions: [],
      tasks: [],
      evidence: [...evidence, { kind: "diagnostic", source: "legacy state migration", result: "pass", detail: `Original artifacts preserved at ${doc}`, recordedAt: now }],
      createdAt: now,
      updatedAt: now
    };
  }
  if (!migratedRows && !boardContent.includes("_No tasks in flight._")) throw new Error("Legacy BOARD contains no recognizable task rows; refusing lossy migration");
  for (const task of Object.values(state.tasks)) files.push({ path: task.artifacts.workplan!, owner: "aidlc-state", ownershipClass: "state", content: renderWorkplan(task) });
  validateState(state);
  return { state, files };
};

const planManaged = (root: string, spec: FileSpec, installedHash: string | undefined, legacy: boolean): PlannedWrite => {
  const target = safePath(root, spec.path);
  if (!existsSync(target)) return { ...spec, action: "create", reason: "new managed file" };
  const current = readFileSync(target, "utf8");
  const next = spec.strategy === "managed-block" ? mergeManagedBlock(spec, current) : spec.content;
  const currentHash = managedContentHash(spec, current);
  const nextHash = contentHash(spec.strategy === "managed-block" ? spec.content.trimEnd() : spec.content);
  if (currentHash === nextHash) return { ...spec, content: next, action: next === current ? "skip" : "update", reason: "managed content already current" };
  if (installedHash && currentHash === installedHash) return { ...spec, content: next, action: "update", reason: "unchanged managed file" };
  const legacyAdapter = legacyV021AdapterContents[spec.path];
  const legacyAdapterHash = legacyAdapter ? contentHash(spec.strategy === "managed-block" ? legacyAdapter.trimEnd() : legacyAdapter) : undefined;
  if (legacy && (legacyV021Hashes[spec.path] === currentHash || legacyAdapterHash === currentHash)) return { ...spec, content: next, action: "update", reason: "recognized v0.2.1 baseline" };
  if (spec.strategy === "managed-block" && current.includes(`<!-- aidlc-installer:${spec.owner} -->`)) return { ...spec, content: next, action: "conflict", reason: "managed prompt block was modified" };
  return { ...spec, content: next, action: "conflict", reason: legacy ? "legacy core differs from known baseline" : "managed file differs from installed hash" };
};

export const planUpgrade = (root: string, loop?: LoopConfig): PlannedWrite[] => {
  const project = resolve(root);
  const installed = readManifest(project);
  const legacy = !installed && legacyManifest(project);
  if (!installed && !legacy) throw new Error("No owned AI-DLC installation found. Use init instead of upgrade.");
  const upgradeAdapters = resolvedAdaptersForUpgrade();
  const requested: AgentId[] = installed?.adapters?.length ? installed.adapters : upgradeAdapters.filter((adapter) => adapter.detect(project)).map((adapter) => adapter.id);
  const selected = requested.filter((id) => findAdapterForUpgrade(id));
  const agentFiles = selected.flatMap((id) => findAdapterForUpgrade(id)?.files() ?? []).map((file) => ({ ...file, ownershipClass: "managed" as const }));
  const managed = [...coreWorkflowFiles(), ...agentFiles];
  const plan = managed.map((spec) => planManaged(project, spec, installed?.files[spec.path]?.hash, legacy));
  if (installed) {
    for (const [path, item] of Object.entries(installed.files)) {
      if (managed.some((spec) => spec.path === path)) continue;
      const target = safePath(project, path);
      if (!existsSync(target)) continue;
      const current = readFileSync(target, "utf8");
      const hash = managedContentHash({ owner: item.owner, strategy: item.strategy }, current);
      plan.push({ path, owner: item.owner, strategy: item.strategy, ownershipClass: "managed", content: "", action: hash === item.hash ? "delete" : "conflict", reason: hash === item.hash ? "obsolete unchanged managed file" : "obsolete managed file was modified" });
    }
  }
  for (const spec of initialProjectFiles()) {
    if (legacy && spec.path === ".agents/data/state/aidlc-state.json" && !existsSync(safePath(project, spec.path))) continue;
    const target = safePath(project, spec.path);
    plan.push(existsSync(target) ? { ...spec, content: readFileSync(target, "utf8"), action: "preserve", reason: `${spec.ownershipClass}-owned file` } : { ...spec, action: "create", reason: `new ${spec.ownershipClass}-owned file` });
  }
  const canonicalState = plan.find((item) => item.path === ".agents/data/state/aidlc-state.json");
  if (canonicalState && canonicalState.action === "preserve") {
    const parsed = JSON.parse(canonicalState.content) as WorkflowState;
    const normalized = validateState(parsed);
    if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
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
    }
  }
  planProjectLayoutMigration(project, plan);
  if (legacy && !existsSync(safePath(project, ".agents/data/state/aidlc-state.json"))) {
    const migration = migrateLegacyBoard(project);
    const compact = prepareV4Migration(migration.state);
    plan.push({ path: ".agents/data/state/aidlc-state.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(compact.state, null, 2)}\n`, action: "migrate", reason: "migrate legacy BOARD to canonical v4 state" });
    for (const record of compact.records) plan.push({ path: record.path, owner: "aidlc-state", ownershipClass: "state", content: record.content, action: "migrate", reason: "preserve legacy terminal task as immutable record" });
    const lessonIndex = plan.find((item) => item.path === ".agents/data/lessons/index.json");
    if (lessonIndex) { lessonIndex.content = `${JSON.stringify(compact.lessonIndex, null, 2)}\n`; lessonIndex.action = "migrate"; lessonIndex.reason = "build derived lesson index during legacy migration"; }
    for (const file of migration.files) plan.push({ ...file, action: "migrate", reason: "preserve legacy task prose in stable task directory" });
  }
  const boardPath = safePath(project, ".agents/data/state/BOARD.md");
  if (existsSync(boardPath)) {
    const stateItem = plan.find((item) => item.path === ".agents/data/state/aidlc-state.json");
    if (!stateItem) throw new Error("Canonical state must be present before removing legacy BOARD");
    validateState(JSON.parse(stateItem.content));
    plan.push({ path: ".agents/data/state/BOARD.md", owner: "aidlc-state", ownershipClass: "state", content: "", action: "delete", reason: "remove duplicate lifecycle-state projection after canonical JSON validation" });
  }
  const manifest = manifestSpec(managed, selected);
  plan.push({ ...manifest, action: "update", reason: legacy ? "migrate manifest to schema v2" : "update manifest inventory" });
  planLoopSelection(plan, loop);
  return plan;
};

export interface UpgradeResult { backup: string; changed: number; }

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
  const journal: Array<{ path: string; existed: boolean; action: string }> = [];
  try {
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
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, "journal.json"), `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    for (const item of writes) {
      const target = safePath(project, item.path);
      if (item.action === "delete") rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        if (existsSync(target)) rmSync(target, { force: true });
        renameSync(join(stage, item.path), target);
      }
    }
    const pruneEmpty = (directory: string): void => {
      if (!existsSync(directory) || !lstatSync(directory).isDirectory()) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) pruneEmpty(join(directory, entry.name));
      if (readdirSync(directory).length === 0) rmdirSync(directory);
    };
    pruneEmpty(safePath(project, ".aidlc"));
    rmSync(stage, { recursive: true, force: true });
    return { backup: backupRelative, changed: writes.length };
  } catch (error) {
    for (const entry of journal.reverse()) {
      const target = safePath(project, entry.path);
      const source = join(backup, entry.path);
      if (entry.existed && existsSync(source)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      } else if (!entry.existed) rmSync(target, { force: true });
    }
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
};
