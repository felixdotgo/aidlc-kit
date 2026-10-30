import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { adapters, findAdapter, installableAdapters, resolvedAdapters } from "./adapters.js";
import type { AgentId, FileSpec, InitOptions, LoopConfig, ManifestInventoryItem, PlannedWrite, WorkflowManifest } from "./model.js";
import { loadProjectConfig, validateLoopConfig } from "./profiles.js";
import { loadState } from "./state.js";
import { planProjectLayoutMigration } from "./project-migration.js";
import { managedBlock, mergeManagedBlock } from "./managed-content.js";
import { resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { contentHash, coreWorkflowFiles, initialProjectFiles, manifestSpec, packageVersion } from "./workflow.js";

const shortHash = (content: string | Uint8Array): string => contentHash(content).slice(0, 12);
const safeTarget = (root: string, path: string): string => resolveProjectPathWithoutSymlinks(root, path, "Managed path escapes the project", "Managed path crosses a symlink");

/** Managed prompt blocks share a path across owners, so inventory keys carry the owner. */
export const installedHashFor = (files: Record<string, ManifestInventoryItem> | undefined, spec: Pick<FileSpec, "path" | "owner" | "strategy">): string | undefined => {
  if (!files) return undefined;
  const keyed = files[`${spec.path}#${spec.owner}`];
  if (keyed) return keyed.hash;
  const legacy = files[spec.path];
  return legacy && (spec.strategy !== "managed-block" || legacy.owner === spec.owner) ? legacy.hash : undefined;
};

export const managedContentHash = (spec: Pick<FileSpec, "owner" | "strategy">, content: string): string | undefined => {
  const managed = managedBlock(spec, content);
  return managed === undefined ? undefined : contentHash(managed);
};

export const readManifest = (root: string): WorkflowManifest | undefined => {
  const path = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkflowManifest>;
    const validFiles = value.files && typeof value.files === "object" && !Array.isArray(value.files) && Object.values(value.files).every((item) => item && typeof item.hash === "string" && typeof item.owner === "string" && ["replace", "managed-block"].includes(item.strategy));
    return value.schemaVersion === 2 && typeof value.packageVersion === "string" && value.workflow === "AI-DLC" && value.source === "local-package-assets" && value.remoteUpdates === false && (value.managedBy === "aidlc-kit" || value.managedBy === "aidlc-workflow") && Array.isArray(value.adapters) && validFiles ? value as WorkflowManifest : undefined;
  } catch {
    return undefined;
  } /* intentional: a malformed manifest is treated as "not installed" */
};

export const detectedAgents = (root: string): AgentId[] => installableAdapters().filter((adapter) => adapter.detect(root)).map((adapter) => adapter.id);

export const selectAgents = (options: Pick<InitOptions, "root" | "agents" | "all">): AgentId[] => {
  if (options.all) return adapters.map((adapter) => adapter.id);
  return [...new Set(options.agents)];
};

const planFile = (root: string, spec: FileSpec, force: boolean, installed?: WorkflowManifest): PlannedWrite => {
  const target = safeTarget(root, spec.path);
  if (spec.ownershipClass === "project" || spec.ownershipClass === "state") {
    return existsSync(target)
      ? { ...spec, content: readFileSync(target, "utf8"), action: "preserve", reason: `${spec.ownershipClass}-owned file` }
      : { ...spec, action: "create", reason: `new ${spec.ownershipClass}-owned file` };
  }
  if (spec.strategy === "managed-block") {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    const next = mergeManagedBlock(spec, current);
    return { ...spec, content: next, action: existsSync(target) ? (next === current ? "skip" : "update") : "create", reason: existsSync(target) ? "managed prompt block" : "new managed prompt" };
  }
  if (!existsSync(target)) return { ...spec, action: "create", reason: "new managed file" };
  const current = readFileSync(target, "utf8");
  if (current === spec.content) return { ...spec, action: "skip", reason: "already current" };
  if (spec.path === ".agents/aidlc/manifest.json" && installed) return { ...spec, action: "update", reason: "refresh manifest inventory" };
  const installedHash = installedHashFor(installed?.files, spec);
  if (installedHash && contentHash(current) === installedHash) return { ...spec, action: "update", reason: "unchanged managed file" };
  if (force) return { ...spec, action: "update", reason: "--force permits replacement of an unmanaged file" };
  return { ...spec, action: "conflict", reason: "managed ownership cannot be proven; use upgrade or review --force" };
};

/** Include an explicitly selected loop config in the same preview/transaction as setup. */
export const planLoopSelection = (plan: PlannedWrite[], selection?: LoopConfig): void => {
  if (selection === undefined) return;
  const loop = validateLoopConfig(selection);
  const config = plan.find((item) => item.path === ".agents/config.json");
  if (!config || !["create", "preserve", "skip", "migrate"].includes(config.action)) throw new Error("Cannot change loop configuration while the project config has another planned change");
  const parsed: unknown = JSON.parse(config.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid project config");
  const current = parsed as Record<string, unknown>;
  if (JSON.stringify(current.loop) === JSON.stringify(loop)) return;
  const previousAction = config.action;
  current.loop = loop;
  config.content = `${JSON.stringify(current, null, 2)}\n`;
  config.action = previousAction === "create" || previousAction === "migrate" ? previousAction : "update";
  config.reason = "explicit loop mode selection";
};

/** Merges a later owner of an already-planned shared managed-block path into the emitted entry. */
const mergeIntoPlannedBlock = (root: string, previous: PlannedWrite, spec: FileSpec): void => {
  const target = safeTarget(root, spec.path);
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  previous.content = mergeManagedBlock(spec, previous.content);
  previous.action = existsSync(target) ? (previous.content === current ? "skip" : "update") : "create";
  previous.reason = existsSync(target) ? "managed prompt block" : "new managed prompt";
};

/** Plans managed workflow files, the manifest, and project-owned files; later block owners merge in line. */
const planManagedWrites = (root: string, files: FileSpec[], force: boolean, installed: WorkflowManifest | undefined): PlannedWrite[] => {
  const plan: PlannedWrite[] = [];
  for (const spec of files) {
    const previous = spec.strategy === "managed-block" ? plan.find((item) => item.path === spec.path && ["create", "update", "skip"].includes(item.action)) : undefined;
    if (!previous) plan.push(planFile(root, spec, force, installed));
    else mergeIntoPlannedBlock(root, previous, spec);
  }
  return plan;
};

/** Plans an init transaction: managed workflow files, manifest, and project-owned files. */
export const planInit = (options: InitOptions): PlannedWrite[] => {
  const root = resolve(options.root);
  const installed = readManifest(root);
  if (installed && installed.packageVersion !== packageVersion()) throw new Error(`AI-DLC ${installed.packageVersion} is already installed. Only a human may upgrade it through the documented npm/npx upgrade command.`);
  const selected = [...new Set([...(installed?.adapters ?? []), ...selectAgents(options)])];
  const unknown = selected.filter((id) => !findAdapter(id));
  if (unknown.length) throw new Error(`Unsupported adapter: ${unknown.join(", ")}`);
  const agentFiles = selected.flatMap((id) => findAdapter(id)?.files() ?? []).map((file) => ({ ...file, ownershipClass: "managed" as const }));
  const managedFiles = [...coreWorkflowFiles(), ...agentFiles];
  const files = [...managedFiles, manifestSpec(managedFiles, selected), ...initialProjectFiles()];
  const plan = planManagedWrites(root, files, options.force, installed);
  planProjectLayoutMigration(root, plan);
  planLoopSelection(plan, options.loop);
  return plan;
};

/** Applies a planned init/uninstall transaction to disk. */
export const applyPlan = (root: string, plan: PlannedWrite[]): void => {
  for (const write of plan.filter((item) => item.action === "delete")) rmSync(safeTarget(root, write.path), { force: true });
  for (const write of plan.filter((item) => ["create", "update", "migrate"].includes(item.action))) {
    const target = safeTarget(root, write.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, write.content, "utf8");
  }
};

export const formatPlan = (plan: PlannedWrite[]): string => plan.map((item) => `${item.action.padEnd(8)} ${item.path} (${item.reason}; sha=${shortHash(item.contentEncoding === "base64" ? Buffer.from(item.content, "base64") : item.content)})`).join("\n");

const hasOwnedManifest = (root: string): boolean => {
  const path = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(path)) return false;
  try { const parsed = JSON.parse(readFileSync(path, "utf8")) as { managedBy?: string }; return parsed.managedBy === "aidlc-kit" || parsed.managedBy === "aidlc-workflow"; } catch { return false; } /* intentional: a malformed/missing manifest is not owned */
};

const removeManagedBlock = (current: string, owner: string): string => {
  const start = `<!-- aidlc-installer:${owner}:start -->`;
  const end = `<!-- aidlc-installer:${owner}:end -->`;
  return current.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "").replace(/\n{3,}/g, "\n\n").trimEnd();
};

/** One manifest inventory record: the current spec to compare against plus the hash it was installed with. */
interface InstalledEntry { spec: FileSpec; hash?: string }

/** Maps one manifest inventory record onto its current spec and installed hash. */
const uninstallEntry = (key: string, item: ManifestInventoryItem, currentSpecs: FileSpec[]): InstalledEntry => {
  const separator = key.lastIndexOf("#");
  const path = separator > 0 ? key.slice(0, separator) : key;
  const owner = separator > 0 ? key.slice(separator + 1) : item.owner;
  const spec = currentSpecs.find((candidate) => candidate.path === path && (candidate.strategy !== "managed-block" || candidate.owner === owner)) ?? { path, owner, strategy: item.strategy, content: "", ownershipClass: "managed" as const };
  return { spec, hash: item.hash };
};

/** Groups installed specs (or all current specs without a manifest) by path; shared blocks carry multiple owners. */
const uninstallGroups = (installed: WorkflowManifest | undefined, currentSpecs: FileSpec[]): Map<string, Array<InstalledEntry>> => {
  const entries = installed ? Object.entries(installed.files).map(([key, item]) => uninstallEntry(key, item, currentSpecs)) : currentSpecs.map((spec) => ({ spec }));
  const groups = new Map<string, Array<InstalledEntry>>();
  for (const entry of entries) groups.set(entry.spec.path, [...(groups.get(entry.spec.path) ?? []), entry]);
  return groups;
};

/** Removes each verified owner block from a shared file; stops at the first user-modified block. */
const stripManagedBlocks = (group: Array<InstalledEntry>, current: string): { next: string; modified?: FileSpec } => {
  let next = current;
  let modified: FileSpec | undefined;
  for (const { spec, hash } of group) {
    const block = managedBlock(spec, next);
    // A v0.2.1 single-marker block cannot be removed safely; retain ownership instead of orphaning it.
    if (!block) { if (next.includes(`<!-- aidlc-installer:${spec.owner} -->`)) modified = spec; continue; }
    if (contentHash(block) !== (hash ?? contentHash(spec.content.trimEnd()))) { modified = spec; break; }
    next = removeManagedBlock(next, spec.owner);
  }
  return { next, modified };
};

/** Decides the plan entry for a whole-file (non shared-block) path. */
const uninstallWholeFile = (group: Array<InstalledEntry>, exists: boolean, current: string): PlannedWrite => {
  if (!exists) return { ...group[0].spec, action: "skip", reason: "not installed" };
  if (!group.some((entry) => entry.spec.strategy === "managed-block")) {
    const { spec, hash } = group[0];
    const installedHash = hash ?? contentHash(spec.content);
    return contentHash(current) === installedHash ? { ...spec, action: "delete", reason: "remove unchanged managed file" } : { ...spec, action: "preserve", reason: "managed file was modified" };
  }
  const { next, modified } = stripManagedBlocks(group, current);
  const legacyResidue = group.find(({ spec }) => next.includes(`<!-- aidlc-installer:${spec.owner} -->`));
  const ownerSpec = group[0].spec;
  if (modified) return { ...modified, action: "preserve", reason: "managed block was modified" };
  if (legacyResidue) return { ...legacyResidue.spec, action: "preserve", reason: "legacy prompt marker requires manual removal" };
  if (next === current) return { ...ownerSpec, action: "skip", reason: "owned block not found" };
  if (next) return { ...ownerSpec, content: `${next}\n`, action: "update", reason: "remove owned prompt block" };
  return { ...ownerSpec, content: "", action: "delete", reason: "remove owned prompt file" };
};

/** Keeps the ownership manifest only while modified managed files remain on disk. */
const manifestDisposition = (plan: PlannedWrite[]): PlannedWrite => {
  const preserved = plan.some((item) => item.action === "preserve");
  return { path: ".agents/aidlc/manifest.json", owner: "aidlc-core", content: "", ownershipClass: "managed", action: preserved ? "preserve" : "delete", reason: preserved ? "retained while modified managed files remain" : "remove ownership manifest" };
};

/** Plans an uninstall transaction that removes only unchanged managed assets. */
export const planUninstall = (root: string): PlannedWrite[] => {
  const project = resolve(root);
  if (!hasOwnedManifest(project)) throw new Error("No managed ownership manifest (.agents/aidlc/manifest.json) found; refusing to remove files.");
  const installed = readManifest(project);
  const currentSpecs = [...coreWorkflowFiles(), ...resolvedAdapters().flatMap((adapter) => adapter.files()).map((file) => ({ ...file, ownershipClass: "managed" as const }))];
  const plan: PlannedWrite[] = [];
  for (const [path, group] of uninstallGroups(installed, currentSpecs)) {
    const target = safeTarget(project, path);
    const exists = existsSync(target);
    plan.push(uninstallWholeFile(group, exists, exists ? readFileSync(target, "utf8") : ""));
  }
  plan.push(manifestDisposition(plan));
  return plan;
};

/** Reports installed workflow version, schema, and detected agents. */
export const status = (root: string): string => {
  const manifest = readManifest(root);
  const legacyPath = join(resolve(root), ".agents/aidlc/manifest.json");
  return [
    `workflow: ${manifest || existsSync(legacyPath) ? "installed" : "not installed"}`,
    `installed version: ${manifest?.packageVersion ?? (existsSync(legacyPath) ? "legacy/unknown" : "none")}`,
    `schema: ${manifest?.schemaVersion ?? (existsSync(legacyPath) ? "legacy" : "none")}`,
    `detected agents: ${detectedAgents(root).join(", ") || "none"}`
  ].join("\n");
};

/** Path portion of a manifest inventory key (`path#owner` for shared managed blocks). */
const inventoryKeyPath = (key: string): string => {
  const separator = key.lastIndexOf("#");
  return separator > 0 ? key.slice(0, separator) : key;
};

/** Manifest inventory paths whose on-disk content no longer matches the recorded owner hash. */
const modifiedManagedPaths = (root: string, manifest: WorkflowManifest): string[] => {
  const modified = Object.entries(manifest.files).filter(([key, item]) => {
    const target = safeTarget(root, inventoryKeyPath(key));
    if (!existsSync(target)) return true;
    const spec = { owner: item.owner, strategy: item.strategy };
    return managedContentHash(spec, readFileSync(target, "utf8")) !== item.hash;
  });
  return [...new Set(modified.map(([key]) => inventoryKeyPath(key)))];
};

/** Validates the installed workflow manifest and local config/state. */
export const doctor = (root: string, strict = false): string => {
  const manifestPath = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(manifestPath)) return "ERROR: .agents/aidlc/manifest.json is missing. Run npx @felixdotgo/aidlc-kit init --yes.";
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return "ERROR: workflow manifest is invalid JSON."; }
  if (parsed.remoteUpdates || parsed.source !== "local-package-assets" || (parsed.managedBy !== "aidlc-kit" && parsed.managedBy !== "aidlc-workflow")) return "ERROR: workflow manifest violates local-only asset policy.";
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 2) return `ERROR: installed manifest schema ${parsed.schemaVersion} is newer than this CLI supports.`;
  const manifest = readManifest(root);
  if (!manifest) return strict ? "ERROR: legacy manifest requires an explicit user-run npm/npx upgrade." : "WARN: legacy manifest detected; no registry check was performed.";
  try { loadProjectConfig(root); loadState(root); } catch (error) { return `ERROR: local config/state is invalid: ${error instanceof Error ? error.message : String(error)}`; }
  const modified = modifiedManagedPaths(root, manifest);
  if (modified.length) return `${strict ? "ERROR" : "WARN"}: managed integrity differs: ${modified.join(", ")}`;
  return `OK: local workflow ${manifest.packageVersion} is valid; remote updates are disabled.`;
};
