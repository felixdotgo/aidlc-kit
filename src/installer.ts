import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { adapters, findAdapter, resolvedAdapters } from "./adapters.js";
import type { AgentId, FileSpec, InitOptions, ManifestInventoryItem, PlannedWrite, WorkflowManifest } from "./model.js";
import { loadProjectConfig } from "./profiles.js";
import { loadState } from "./state.js";
import { planProjectLayoutMigration } from "./project-migration.js";
import { legacyManagedMarker, managedBlock, removeManagedBlock } from "./managed-content.js";
import { hasOwnedManifest, managedContentHash, planLoopSelection, planManagedWrites, readManifest, readManifestFile, splitInventoryKey } from "./managed-planning.js";
import { resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { contentHash, coreWorkflowFiles, initialProjectFiles, isExecutableAsset, manifestSpec, packageVersion } from "./workflow.js";

/** Manifest reading lives in the managed-planning core; this export path stays stable for existing importers. */
export { readManifest } from "./managed-planning.js";

const shortHash = (content: string | Uint8Array): string => contentHash(content).slice(0, 12);
const safeTarget = (root: string, path: string): string => resolveProjectPathWithoutSymlinks(root, path, "Managed path escapes the project", "Managed path crosses a symlink");

export const detectedAgents = (root: string): AgentId[] => resolvedAdapters().filter((adapter) => adapter.detect(root)).map((adapter) => adapter.id);

export const selectAgents = (options: Pick<InitOptions, "root" | "agents" | "all">): AgentId[] => {
  if (options.all) return adapters.map((adapter) => adapter.id);
  return [...new Set(options.agents)];
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
  const plan = planManagedWrites(root, files, { flow: "init", force: options.force, installed, resolvePath: safeTarget });
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
    if (isExecutableAsset(write.path) && process.platform !== "win32") chmodSync(target, 0o755);
  }
};

export const formatPlan = (plan: PlannedWrite[]): string => plan.map((item) => `${item.action.padEnd(8)} ${item.path} (${item.reason}; sha=${shortHash(item.contentEncoding === "base64" ? Buffer.from(item.content, "base64") : item.content)})`).join("\n");

/** One manifest inventory record: the current spec to compare against plus the hash it was installed with. */
interface InstalledEntry { spec: FileSpec; hash?: string }

/** Maps one manifest inventory record onto its current spec and installed hash. */
const uninstallEntry = (key: string, item: ManifestInventoryItem, currentSpecs: FileSpec[]): InstalledEntry => {
  const { path, owner: keyedOwner } = splitInventoryKey(key);
  const owner = keyedOwner ?? item.owner;
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
    if (!block) { if (next.includes(legacyManagedMarker(spec.owner))) modified = spec; continue; }
    if (contentHash(block) !== (hash ?? contentHash(spec.content.trimEnd()))) { modified = spec; break; }
    next = removeManagedBlock(next, spec.owner);
  }
  return { next, modified };
};

/** Decides the plan entry for a whole-file (non shared-block) path. */
const uninstallWholeFile = (group: Array<InstalledEntry>, exists: boolean, current: string): PlannedWrite => {
  if (!exists) return { ...group[0]!.spec, action: "skip", reason: "not installed" };
  if (!group.some((entry) => entry.spec.strategy === "managed-block")) {
    const { spec, hash } = group[0]!;
    const installedHash = hash ?? contentHash(spec.content);
    return contentHash(current) === installedHash ? { ...spec, action: "delete", reason: "remove unchanged managed file" } : { ...spec, action: "preserve", reason: "managed file was modified" };
  }
  const { next, modified } = stripManagedBlocks(group, current);
  const legacyResidue = group.find(({ spec }) => next.includes(legacyManagedMarker(spec.owner)));
  const ownerSpec = group[0]!.spec;
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

export const statusData = (root: string): { workflow: string; installedVersion: string; schema: string; detectedAgents: string[] } => {
  const manifest = readManifest(root);
  const legacyPath = join(resolve(root), ".agents/aidlc/manifest.json");
  return {
    workflow: manifest || existsSync(legacyPath) ? "installed" : "not installed",
    installedVersion: manifest?.packageVersion ?? (existsSync(legacyPath) ? "legacy/unknown" : "none"),
    schema: `${manifest?.schemaVersion ?? (existsSync(legacyPath) ? "legacy" : "none")}`,
    detectedAgents: detectedAgents(root)
  };
};

/** Reports installed workflow version, schema, and detected agents. */
export const status = (root: string): string => {
  const data = statusData(root);
  return [
    `workflow: ${data.workflow}`,
    `installed version: ${data.installedVersion}`,
    `schema: ${data.schema}`,
    `detected agents: ${data.detectedAgents.join(", ") || "none"}`
  ].join("\n");
};

/** Manifest inventory paths whose on-disk content no longer matches the recorded owner hash. */
const modifiedManagedPaths = (root: string, manifest: WorkflowManifest): string[] => {
  const modified = Object.entries(manifest.files).filter(([key, item]) => {
    const target = safeTarget(root, splitInventoryKey(key).path);
    if (!existsSync(target)) return true;
    const spec = { owner: item.owner, strategy: item.strategy };
    return managedContentHash(spec, readFileSync(target, "utf8")) !== item.hash;
  });
  return [...new Set(modified.map(([key]) => splitInventoryKey(key).path))];
};

/** Validates the installed workflow manifest and local config/state. */
export const doctor = (root: string, strict = false): string => {
  const read = readManifestFile(root);
  if (read.status === "missing") return "ERROR: .agents/aidlc/manifest.json is missing. Run npx @felixdotgo/aidlc-kit init --yes.";
  if (read.status === "invalid") return "ERROR: workflow manifest is invalid JSON.";
  const parsed = read.value;
  if (parsed.remoteUpdates || parsed.source !== "local-package-assets" || (parsed.managedBy !== "aidlc-kit" && parsed.managedBy !== "aidlc-workflow")) return "ERROR: workflow manifest violates local-only asset policy.";
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 2) return `ERROR: installed manifest schema ${parsed.schemaVersion} is newer than this CLI supports.`;
  const manifest = readManifest(root);
  if (!manifest) return strict ? "ERROR: legacy manifest requires an explicit user-run npm/npx upgrade." : "WARN: legacy manifest detected; no registry check was performed.";
  try { loadProjectConfig(root); loadState(root); } catch (error) { return `ERROR: local config/state is invalid: ${error instanceof Error ? error.message : String(error)}`; }
  const modified = modifiedManagedPaths(root, manifest);
  if (modified.length) return `${strict ? "ERROR" : "WARN"}: managed integrity differs: ${modified.join(", ")}`;
  return `OK: local workflow ${manifest.packageVersion} is valid; remote updates are disabled.`;
};

export const doctorData = (root: string, strict = false): { level: "ok" | "warn" | "error"; message: string; strict: boolean } => {
  const message = doctor(root, strict);
  const level = message.startsWith("ERROR:") ? "error" : message.startsWith("WARN:") ? "warn" : "ok";
  return { level, message, strict };
};
