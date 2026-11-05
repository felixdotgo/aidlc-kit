/**
 * Managed-planning core shared by init and upgrade: the manifest-reader family,
 * inventory-key handling, managed-content hash proofs, and the single
 * create/skip/update/conflict ladder for managed files, driven by explicit
 * per-flow policies so installation and upgrade keep their exact semantics.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FileSpec, LoopConfig, ManifestInventoryItem, PlannedWrite, WorkflowManifest } from "./model.js";
import { legacyManagedMarker, managedBlock, mergeManagedBlock } from "./managed-content.js";
import { validateLoopConfig } from "./profiles.js";
import { contentHash } from "./workflow.js";

/** Constructs manifest inventory keys (`path#owner` for shared managed blocks). The definition should live here; it stays in workflow.ts pending a cross-owner move. */
export { manifestKey } from "./workflow.js";

/* --- Manifest reading family: one read+parse, three strictnesses --------------- */

/** Raw outcome of reading the ownership manifest: missing on disk, unparseable, or parsed but unvalidated. */
export type ManifestFileRead = { status: "missing" } | { status: "invalid" } | { status: "parsed"; value: Record<string, unknown> };

/** The single read+parse of .agents/aidlc/manifest.json that every manifest question goes through. */
export const readManifestFile = (root: string): ManifestFileRead => {
  const path = join(resolve(root), ".agents/aidlc/manifest.json");
  if (!existsSync(path)) return { status: "missing" };
  try { return { status: "parsed", value: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> }; } catch { return { status: "invalid" }; } /* intentional: an unreadable manifest is missing/invalid, never a crash */
};

/** Strict schema-v2 ownership manifest; malformed or non-conforming content reads as "not installed". */
export const readManifest = (root: string): WorkflowManifest | undefined => {
  const read = readManifestFile(root);
  if (read.status !== "parsed") return undefined;
  try {
    const value = read.value as Partial<WorkflowManifest>;
    const validFiles = value.files && typeof value.files === "object" && !Array.isArray(value.files) && Object.values(value.files).every((item) => item && typeof item.hash === "string" && typeof item.owner === "string" && ["replace", "managed-block"].includes(item.strategy));
    return value.schemaVersion === 2 && typeof value.packageVersion === "string" && value.workflow === "AI-DLC" && value.source === "local-package-assets" && value.remoteUpdates === false && (value.managedBy === "aidlc-kit" || value.managedBy === "aidlc-workflow") && Array.isArray(value.adapters) && validFiles ? value as WorkflowManifest : undefined;
  } catch {
    return undefined;
  } /* intentional: a malformed manifest is treated as "not installed" */
};

/** Whether the on-disk manifest is owned by this package (any schema version). */
export const hasOwnedManifest = (root: string): boolean => {
  const read = readManifestFile(root);
  if (read.status !== "parsed") return false;
  try { return read.value.managedBy === "aidlc-kit" || read.value.managedBy === "aidlc-workflow"; } catch { return false; } /* intentional: a malformed/missing manifest is not owned */
};

/** Whether the on-disk manifest is a legacy aidlc-workflow v0.x install (schema 0 or 1). */
export const legacyManifest = (root: string): boolean => {
  const read = readManifestFile(root);
  if (read.status !== "parsed") return false;
  try { return read.value.managedBy === "aidlc-workflow" && (read.value.schemaVersion === 0 || read.value.schemaVersion === 1); } catch { return false; } /* intentional: a malformed/missing manifest is not a legacy v0.x install */
};

/* --- Inventory keys and hash proofs --------------------------------------------- */

/** Splits a manifest inventory key into its path and, when present, its `#owner` suffix. */
export const splitInventoryKey = (key: string): { path: string; owner?: string } => {
  const separator = key.lastIndexOf("#");
  return separator > 0 ? { path: key.slice(0, separator), owner: key.slice(separator + 1) } : { path: key };
};

/** Managed prompt blocks share a path across owners, so inventory keys carry the owner. */
export const installedHashFor = (files: Record<string, ManifestInventoryItem> | undefined, spec: Pick<FileSpec, "path" | "owner" | "strategy">): string | undefined => {
  if (!files) return undefined;
  const keyed = files[`${spec.path}#${spec.owner}`];
  if (keyed) return keyed.hash;
  const legacy = files[spec.path];
  return legacy && (spec.strategy !== "managed-block" || legacy.owner === spec.owner) ? legacy.hash : undefined;
};

/** Hash of the managed slice of a file: the owned block for managed-block strategies, the whole file otherwise. */
export const managedContentHash = (spec: Pick<FileSpec, "owner" | "strategy">, content: string): string | undefined => {
  const managed = managedBlock(spec, content);
  return managed === undefined ? undefined : contentHash(managed);
};

/* --- Owned-file preservation ------------------------------------------------------ */

/** Plans one project/state-owned file: preserved verbatim when present, seeded from the package when absent. */
export const preserveOwnedFile = (target: string, spec: FileSpec): PlannedWrite => existsSync(target)
  ? { ...spec, content: readFileSync(target, "utf8"), action: "preserve", reason: `${spec.ownershipClass}-owned file` }
  : { ...spec, action: "create", reason: `new ${spec.ownershipClass}-owned file` };

/* --- Per-flow policies --------------------------------------------------------------- */

/** Caller-supplied project-path resolver so each flow keeps its own error persona (init refuses escapes and symlinks; upgrade refuses only escapes). */
export type ProjectPathResolver = (root: string, relative: string) => string;

/** Policy fields shared by both flows. */
export interface PlanPolicyBase {
  /** Installed manifest to prove ownership against, when one exists. */
  installed?: WorkflowManifest;
  /** Project-path resolver carrying the caller's error persona. */
  resolvePath: ProjectPathResolver;
}

/** Init: managed blocks merge unconditionally and --force may replace unmanaged files. */
export interface InitPlanPolicy extends PlanPolicyBase { flow: "init"; force: boolean }

/** Upgrade: ownership is proven against installed hashes and the frozen v0.2.1 baselines. */
export interface UpgradePlanPolicy extends PlanPolicyBase {
  flow: "upgrade";
  /** True when no schema-2 manifest exists and a legacy v0.x install is being migrated. */
  legacy: boolean;
  /** Recognizes a v0.2.1 baseline for a spec's current managed-content hash; consulted only while `legacy` is set. */
  legacyBaseline?: (spec: FileSpec, currentHash: string | undefined) => boolean;
}

/** Per-flow policy for the shared managed-file ladder; the union makes each flow's knobs explicit. */
export type PlanPolicy = InitPlanPolicy | UpgradePlanPolicy;

/* --- The one managed-file planning ladder -------------------------------------------- */

/**
 * The single managed-file planning ladder shared by init and upgrade. The flows
 * share the head rungs and then diverge; every difference is pinned below so
 * each caller behaves exactly as it did before the extraction:
 * - project/state specs: init plans preserve/create here; upgrade never passes
 *   them (its project files go through its own preserveProjectFiles pass).
 * - fresh managed-block file: init merges into the empty file and says "new
 *   managed prompt"; upgrade copies spec.content verbatim and says "new managed
 *   file".
 * - current content: init skips on whole-file equality ("already current");
 *   upgrade compares managed-content hashes ("managed content already current")
 *   and can still plan an update when only the surrounding layout changed.
 * - manifest refresh and --force: init-only rungs (upgrade rewrites the
 *   manifest unconditionally through its own manifestSpec entry).
 * - installed-hash proof: init compares the whole-file hash (only replace files
 *   reach this rung); upgrade compares the managed-content hash (block-scoped
 *   for shared blocks).
 * - v0.2.1 baselines and the legacy single-marker conflict: upgrade-only rungs.
 * - terminal conflict: init reports unprovable ownership; upgrade names the
 *   legacy-baseline or installed-hash mismatch.
 */
const planManagedFile = (root: string, spec: FileSpec, policy: PlanPolicy): PlannedWrite => {
  const target = policy.resolvePath(root, spec.path);
  if (policy.flow === "init" && (spec.ownershipClass === "project" || spec.ownershipClass === "state")) return preserveOwnedFile(target, spec);
  if (policy.flow === "init" && spec.strategy === "managed-block") {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    const next = mergeManagedBlock(spec, current);
    return { ...spec, content: next, action: existsSync(target) ? (next === current ? "skip" : "update") : "create", reason: existsSync(target) ? "managed prompt block" : "new managed prompt" };
  }
  if (!existsSync(target)) return { ...spec, action: "create", reason: "new managed file" };
  const current = readFileSync(target, "utf8");
  if (policy.flow === "init") {
    if (current === spec.content) return { ...spec, action: "skip", reason: "already current" };
    if (spec.path === ".agents/aidlc/manifest.json" && policy.installed) return { ...spec, action: "update", reason: "refresh manifest inventory" };
    const installedHash = installedHashFor(policy.installed?.files, spec);
    if (installedHash && contentHash(current) === installedHash) return { ...spec, action: "update", reason: "unchanged managed file" };
    if (policy.force) return { ...spec, action: "update", reason: "--force permits replacement of an unmanaged file" };
    return { ...spec, action: "conflict", reason: "managed ownership cannot be proven; use upgrade or review --force" };
  }
  const next = spec.strategy === "managed-block" ? mergeManagedBlock(spec, current) : spec.content;
  const currentHash = managedContentHash(spec, current);
  const nextHash = contentHash(spec.strategy === "managed-block" ? spec.content.trimEnd() : spec.content);
  if (currentHash === nextHash) return { ...spec, content: next, action: next === current ? "skip" : "update", reason: "managed content already current" };
  const installedHash = installedHashFor(policy.installed?.files, spec);
  if (installedHash && currentHash === installedHash) return { ...spec, content: next, action: "update", reason: "unchanged managed file" };
  if (policy.legacy && policy.legacyBaseline?.(spec, currentHash)) return { ...spec, content: next, action: "update", reason: "recognized v0.2.1 baseline" };
  if (spec.strategy === "managed-block" && current.includes(legacyManagedMarker(spec.owner))) return { ...spec, content: next, action: "conflict", reason: "managed prompt block was modified" };
  return { ...spec, content: next, action: "conflict", reason: policy.legacy ? "legacy core differs from known baseline" : "managed file differs from installed hash" };
};

/**
 * Merges a later owner of a shared managed-block path into the already-planned
 * entry. Upgrade proof-checks the later owner's installed block hash first so a
 * user edit to a later adapter's block is reported instead of being silently
 * overwritten; init has nothing to prove against and merges unconditionally,
 * saying "new managed prompt" for a file that did not exist yet.
 */
const mergeSharedBlockOwner = (root: string, previous: PlannedWrite, spec: FileSpec, policy: PlanPolicy): void => {
  if (!["create", "update", "skip"].includes(previous.action)) return;
  const target = policy.resolvePath(root, spec.path);
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (policy.flow === "upgrade") {
    const installedBlockHash = installedHashFor(policy.installed?.files, spec);
    const currentBlockHash = managedContentHash(spec, current);
    if (installedBlockHash !== undefined && currentBlockHash !== undefined && installedBlockHash !== currentBlockHash) {
      previous.action = "conflict";
      previous.reason = "managed prompt block was modified";
      return;
    }
  }
  previous.content = mergeManagedBlock(spec, previous.content);
  previous.action = existsSync(target) ? (previous.content === current ? "skip" : "update") : "create";
  previous.reason = policy.flow === "init" && !existsSync(target) ? "new managed prompt" : "managed prompt block";
};

/**
 * Plans managed files (and, for init, the manifest and project/state files) in
 * order; later owners of a shared managed-block path merge into the earlier
 * entry. Init finds the earlier entry by scanning the plan; upgrade tracks the
 * first block entry per path so a conflicted first owner stays the single
 * reportable entry for that path.
 */
export const planManagedWrites = (root: string, files: FileSpec[], policy: PlanPolicy): PlannedWrite[] => {
  const plan: PlannedWrite[] = [];
  const firstBlocks = new Map<string, PlannedWrite>();
  for (const spec of files) {
    const previous = spec.strategy === "managed-block"
      ? policy.flow === "init" ? plan.find((item) => item.path === spec.path && ["create", "update", "skip"].includes(item.action)) : firstBlocks.get(spec.path)
      : undefined;
    if (!previous) {
      const write = planManagedFile(root, spec, policy);
      plan.push(write);
      if (policy.flow === "upgrade" && spec.strategy === "managed-block") firstBlocks.set(spec.path, write);
    } else mergeSharedBlockOwner(root, previous, spec, policy);
  }
  return plan;
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
