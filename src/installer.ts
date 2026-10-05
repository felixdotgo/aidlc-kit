import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { adapters, findAdapter, installableAdapters, resolvedAdapters } from "./adapters.js";
import type { AgentId, FileSpec, InitOptions, PlannedWrite, WorkflowManifest } from "./model.js";
import { loadProjectConfig } from "./profiles.js";
import { loadState } from "./state.js";
import { planProjectLayoutMigration } from "./project-migration.js";
import { managedBlock, mergeManagedBlock } from "./managed-content.js";
import { resolveProjectPathWithoutSymlinks } from "./project-path.js";
import { contentHash, coreWorkflowFiles, initialProjectFiles, manifestSpec, packageVersion } from "./workflow.js";

const shortHash = (content: string | Uint8Array): string => contentHash(content).slice(0, 12);
const safeTarget = (root: string, path: string): string => resolveProjectPathWithoutSymlinks(root, path, "Managed path escapes the project", "Managed path crosses a symlink");

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
    return value.schemaVersion === 2 && typeof value.packageVersion === "string" && value.workflow === "AI-DLC" && value.source === "local-package-assets" && value.remoteUpdates === false && value.managedBy === "aidlc-workflow" && Array.isArray(value.adapters) && validFiles ? value as WorkflowManifest : undefined;
  } catch {
    return undefined;
  }
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
  const installedHash = installed?.files[spec.path]?.hash;
  if (installedHash && contentHash(current) === installedHash) return { ...spec, action: "update", reason: "unchanged managed file" };
  if (force) return { ...spec, action: "update", reason: "--force permits replacement of an unmanaged file" };
  return { ...spec, action: "conflict", reason: "managed ownership cannot be proven; use upgrade or review --force" };
};

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
  const plan = files.map((spec) => planFile(root, spec, options.force, installed));
  planProjectLayoutMigration(root, plan);
  return plan;
};

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
  try { return JSON.parse(readFileSync(path, "utf8")).managedBy === "aidlc-workflow"; } catch { return false; }
};

export const planUninstall = (root: string): PlannedWrite[] => {
  const project = resolve(root);
  if (!hasOwnedManifest(project)) throw new Error("No aidlc-workflow ownership manifest found; refusing to remove files.");
  const installed = readManifest(project);
  const currentSpecs = [...coreWorkflowFiles(), ...resolvedAdapters().flatMap((adapter) => adapter.files()).map((file) => ({ ...file, ownershipClass: "managed" as const }))];
  const specs = installed ? Object.entries(installed.files).map(([path, item]) => currentSpecs.find((spec) => spec.path === path) ?? ({ path, owner: item.owner, strategy: item.strategy, content: "", ownershipClass: "managed" as const })) : currentSpecs;
  const plan = specs.map((spec): PlannedWrite => {
    const target = safeTarget(project, spec.path);
    if (!existsSync(target)) return { ...spec, action: "skip", reason: "not installed" };
    const current = readFileSync(target, "utf8");
    if (spec.strategy === "managed-block") {
      const block = managedBlock(spec, current);
      if (!block) return { ...spec, action: "skip", reason: "owned block not found" };
      const installedHash = installed?.files[spec.path]?.hash ?? contentHash(spec.content.trimEnd());
      if (contentHash(block) !== installedHash) return { ...spec, action: "preserve", reason: "managed block was modified" };
      const start = `<!-- aidlc-installer:${spec.owner}:start -->`;
      const end = `<!-- aidlc-installer:${spec.owner}:end -->`;
      const next = current.replace(new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "g"), "").replace(/\n{3,}/g, "\n\n").trimEnd();
      return next ? { ...spec, content: `${next}\n`, action: "update", reason: "remove owned prompt block" } : { ...spec, content: "", action: "delete", reason: "remove owned prompt file" };
    }
    const installedHash = installed?.files[spec.path]?.hash ?? contentHash(spec.content);
    return contentHash(current) === installedHash ? { ...spec, action: "delete", reason: "remove unchanged managed file" } : { ...spec, action: "preserve", reason: "managed file was modified" };
  });
  plan.push({ path: ".agents/aidlc/manifest.json", owner: "aidlc-core", content: "", ownershipClass: "managed", action: plan.some((item) => item.action === "preserve") ? "preserve" : "delete", reason: plan.some((item) => item.action === "preserve") ? "retained while modified managed files remain" : "remove ownership manifest" });
  return plan;
};

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

export const doctor = (root: string, strict = false): string => {
  const manifestPath = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(manifestPath)) return "ERROR: .agents/aidlc/manifest.json is missing. Run npx @felixdotgo/aidlc-kit init --yes.";
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { return "ERROR: workflow manifest is invalid JSON."; }
  if (parsed.remoteUpdates || parsed.source !== "local-package-assets" || parsed.managedBy !== "aidlc-workflow") return "ERROR: workflow manifest violates local-only asset policy.";
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > 2) return `ERROR: installed manifest schema ${parsed.schemaVersion} is newer than this CLI supports.`;
  const manifest = readManifest(root);
  if (!manifest) return strict ? "ERROR: legacy manifest requires an explicit user-run npm/npx upgrade." : "WARN: legacy manifest detected; no registry check was performed.";
  try { loadProjectConfig(root); loadState(root); } catch (error) { return `ERROR: local config/state is invalid: ${error instanceof Error ? error.message : String(error)}`; }
  const modified = Object.entries(manifest.files).filter(([path, item]) => {
    const target = safeTarget(root, path);
    if (!existsSync(target)) return true;
    const spec = { owner: item.owner, strategy: item.strategy };
    return managedContentHash(spec, readFileSync(target, "utf8")) !== item.hash;
  }).map(([path]) => path);
  if (modified.length) return `${strict ? "ERROR" : "WARN"}: managed integrity differs: ${modified.join(", ")}`;
  return `OK: local workflow ${manifest.packageVersion} is valid; remote updates are disabled.`;
};
