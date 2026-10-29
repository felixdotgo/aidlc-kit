import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlannedWrite } from "./model.js";
import { resolveProjectPath } from "./project-path.js";

const safePath = (root: string, relative: string): string => resolveProjectPath(root, relative, "Unsafe migration path");

/* Legacy `.aidlc/...` path translation into the canonical `.agents/` layout. */
const legacyReference = (value: string): string => {
  if (value === ".aidlc/config.json") return ".agents/config.json";
  if (value === ".aidlc/index") return ".agents/index";
  if (value.startsWith(".aidlc/index/")) return `.agents/data/index/${value.slice(".aidlc/index/".length)}`;
  if (value === ".aidlc") return ".agents/project";
  if (value.startsWith(".aidlc/")) return `.agents/project/${value.slice(".aidlc/".length)}`;
  return value;
};

const rewriteStrings = (value: unknown): unknown => Array.isArray(value) ? value.map((entry) => typeof entry === "string" ? legacyReference(entry) : entry) : value;

/** Rewrites legacy `.aidlc/` path references inside the JSON file formats that are known to hold them. */
const rewriteKnownJson = (relative: string, content: Buffer): { content: string; changed: boolean } | undefined => {
  const isConfig = relative === "config.json";
  const isProfile = /^profiles\/.+\/profile\.json$/.test(relative);
  const isAdapter = /^adapters\/.+\/adapter\.json$/.test(relative);
  if (!isConfig && !isProfile && !isAdapter) return undefined;
  const source = content.toString("utf8");
  const value = JSON.parse(source) as Record<string, unknown>;
  const before = JSON.stringify(value);
  if (isConfig || isProfile) {
    const discovery = value.discovery as Record<string, unknown> | undefined;
    const specs = value.specs as Record<string, unknown> | undefined;
    const rules = value.rules as Record<string, unknown> | undefined;
    if (discovery) {
      discovery.roots = rewriteStrings(discovery.roots);
      discovery.workspaceMarkers = rewriteStrings(discovery.workspaceMarkers);
    }
    if (specs) specs.roots = rewriteStrings(specs.roots);
    if (rules) rules.include = rewriteStrings(rules.include);
  }
  if (isAdapter) {
    value.detect = rewriteStrings(value.detect);
    if (Array.isArray(value.files)) for (const file of value.files) {
      if (file && typeof file === "object" && typeof (file as Record<string, unknown>).path === "string") {
        (file as Record<string, unknown>).path = legacyReference((file as Record<string, unknown>).path as string);
      }
    }
  }
  const changed = before !== JSON.stringify(value);
  return { content: changed ? `${JSON.stringify(value, null, 2)}\n` : source, changed };
};

const migrationPayload = (relative: string, source: Buffer): Pick<PlannedWrite, "content" | "contentEncoding"> => {
  const rewritten = rewriteKnownJson(relative, source);
  return rewritten ? { content: rewritten.content } : { content: source.toString("base64"), contentEncoding: "base64" };
};

const payloadBuffer = (item: Pick<PlannedWrite, "content" | "contentEncoding">): Buffer => item.contentEncoding === "base64" ? Buffer.from(item.content, "base64") : Buffer.from(item.content, "utf8");

const legacyDestination = (relative: string): string => {
  if (relative === "config.json") return ".agents/config.json";
  if (relative === "index") return ".agents/index";
  if (relative.startsWith("index/")) return `.agents/data/index/${relative.slice("index/".length)}`;
  return `.agents/project/${relative}`;
};

/** Plans the copy of one legacy file into its destination, including a tracked delete of the source. */
const planMigrationFile = (project: string, plan: PlannedWrite[], sourcePath: string, destinationPath: string, legacyRelative: string): void => {
  const source = safePath(project, sourcePath);
  const payload = migrationPayload(legacyRelative, readFileSync(source));
  const destination = safePath(project, destinationPath);
  const existingPlan = plan.find((item) => item.path === destinationPath);
  const destinationContent = existingPlan && ["update", "migrate"].includes(existingPlan.action)
    ? payloadBuffer(existingPlan)
    : existsSync(destination) && lstatSync(destination).isFile() ? readFileSync(destination) : undefined;
  if (existsSync(destination) && !lstatSync(destination).isFile()) {
    plan.push({ path: destinationPath, owner: "aidlc-project", ownershipClass: "project", content: "", action: "conflict", reason: `legacy migration destination is not a regular file: ${sourcePath}` });
    return;
  }
  if (destinationContent) {
    if (!destinationContent.equals(payloadBuffer(payload))) {
      plan.push({ path: destinationPath, owner: "aidlc-project", ownershipClass: "project", ...payload, action: "conflict", reason: `legacy source differs from existing destination: ${sourcePath}` });
      return;
    }
  } else if (existingPlan?.action === "create") {
    if (existingPlan.ownershipClass === "managed" && !payloadBuffer(existingPlan).equals(payloadBuffer(payload))) {
      Object.assign(existingPlan, { action: "conflict", reason: `legacy managed file differs from the new managed content: ${sourcePath}` });
      return;
    }
    Object.assign(existingPlan, payload, { action: "migrate", reason: `migrate legacy project file from ${sourcePath}` });
  } else {
    plan.push({ path: destinationPath, owner: "aidlc-project", ownershipClass: "project", ...payload, action: "migrate", reason: `migrate legacy project file from ${sourcePath}` });
  }
  if (!plan.some((item) => item.path === sourcePath && item.action === "delete")) {
    plan.push({ path: sourcePath, owner: "aidlc-project", ownershipClass: "project", content: "", action: "delete", reason: `remove migrated legacy project file after creating ${destinationPath}` });
  }
};

/** Walks the legacy `.aidlc/` tree, refusing symlinks and special entries with a conflicted plan entry. */
const planLegacyTreeMigration = (project: string, plan: PlannedWrite[]): void => {
  const legacyRoot = safePath(project, ".aidlc");
  if (!existsSync(legacyRoot)) return;
  if (lstatSync(legacyRoot).isSymbolicLink() || !lstatSync(legacyRoot).isDirectory()) {
    plan.push({ path: ".aidlc", owner: "aidlc-project", ownershipClass: "project", content: "", action: "conflict", reason: "legacy migration root must be a real directory" });
    return;
  }
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const sourcePath = `.aidlc/${relative}`;
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        plan.push({ path: sourcePath, owner: "aidlc-project", ownershipClass: "project", content: "", action: "conflict", reason: "legacy migration refuses symlink or special filesystem entry" });
      } else if (entry.isDirectory()) visit(safePath(project, sourcePath), relative);
      else planMigrationFile(project, plan, sourcePath, legacyDestination(relative), relative);
    }
  };
  visit(legacyRoot);
};

/** Rewrites legacy `.aidlc/` references inside an already-installed canonical project config. */
const planExistingConfigRewrite = (project: string, plan: PlannedWrite[]): void => {
  const path = ".agents/config.json";
  const target = safePath(project, path);
  if (!existsSync(target)) return;
  const rewritten = rewriteKnownJson("config.json", readFileSync(target));
  if (!rewritten?.changed) return;
  const item = plan.find((candidate) => candidate.path === path);
  if (item) Object.assign(item, { content: rewritten.content, action: "migrate", reason: "rewrite legacy .aidlc references in canonical project config" });
};

/** Moves the legacy `.agents/data/state/{repo-map,specs-index}` files into the data/index directory. */
const planLegacyIndexMigration = (project: string, plan: PlannedWrite[]): void => {
  for (const name of ["repo-map.md", "specs-index.md"]) {
    const source = `.agents/data/state/${name}`;
    if (existsSync(safePath(project, source))) planMigrationFile(project, plan, source, `.agents/data/index/${name}`, `index/${name}`);
  }
};

/** Plans the full legacy-layout migration: config rewrite, `.aidlc/` tree, and legacy index files. */
export const planProjectLayoutMigration = (project: string, plan: PlannedWrite[]): void => {
  planExistingConfigRewrite(project, plan);
  planLegacyTreeMigration(project, plan);
  planLegacyIndexMigration(project, plan);
};
