/**
 * Parallel work partition checks, mirroring `assets/aidlc/scripts/lib/store.mjs`
 * (`pathOverlaps`, `pathsOverlap`, `concurrentItemPairs`, `partitionDiagnostics`,
 * `loopPartitionStrict`). Owned paths overlap by path segment (`a` overlaps
 * `a/b`, not `ab`); two open items can run concurrently unless one is a direct
 * or transitive dependency of the other.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Diagnostic, TaskState } from "../model.js";

type Item = TaskState["tasks"][number];

const ownedPathKey = (path: string): string => String(path).replace(/\/+$/, "");

export const pathOverlaps = (left: string, right: string): boolean => {
  const a = ownedPathKey(left); const b = ownedPathKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
};

export const pathsOverlap = (left: readonly string[] = [], right: readonly string[] = []): boolean => left.some((a) => right.some((b) => pathOverlaps(a, b)));

const itemAncestors = (task: TaskState): ((id: string) => Set<string>) => {
  const byId = new Map(task.tasks.map((item) => [item.id, item]));
  const memo = new Map<string, Set<string>>();
  const walk = (id: string, trail = new Set<string>()): Set<string> => {
    const cached = memo.get(id); if (cached) return cached;
    const found = new Set<string>(); if (trail.has(id)) return found;
    trail.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) { if (!byId.has(dep)) continue; found.add(dep); for (const deeper of walk(dep, trail)) found.add(deeper); }
    trail.delete(id); memo.set(id, found); return found;
  };
  return (id) => walk(id);
};

/** Pairs of open (not done/deferred) items that are not ordered by `dependsOn`. */
export const concurrentItemPairs = (task: TaskState): Array<[Item, Item]> => {
  const open = task.tasks.filter((item) => item.status !== "done" && item.status !== "deferred");
  const ancestors = itemAncestors(task); const pairs: Array<[Item, Item]> = [];
  for (let i = 0; i < open.length; i += 1) for (let j = i + 1; j < open.length; j += 1) {
    const a = open[i]!; const b = open[j]!;
    if (!ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id)) pairs.push([a, b]);
  }
  return pairs;
};

/** Approve-plan partition check. `strict` (enabled loop) makes findings ERRORs; otherwise WARNs. */
export const partitionDiagnostics = (task: TaskState, { strict = true }: { strict?: boolean } = {}): Diagnostic[] => {
  const level: Diagnostic["level"] = strict ? "ERROR" : "WARN"; const diagnostics: Diagnostic[] = [];
  const unscoped = task.tasks.filter((item) => item.status !== "done" && item.status !== "deferred" && !(Array.isArray(item.ownedPaths) && item.ownedPaths.length));
  if (unscoped.length) diagnostics.push({ level, code: "PARTITION_SCOPE", message: `Build items need owned paths (--owns) for parallel workers: ${unscoped.map((item) => item.id).join(", ")}` });
  for (const [a, b] of concurrentItemPairs(task)) {
    const shared = (a.ownedPaths ?? []).filter((path) => (b.ownedPaths ?? []).some((other) => pathOverlaps(path, other)));
    if (shared.length) diagnostics.push({ level, code: "PARTITION_OVERLAP", message: `Items ${a.id} and ${b.id} can run concurrently but both own ${shared.join(", ")}; split the paths or add --depends-on` });
  }
  return diagnostics;
};

/** Strict when `loop.mode` is local/fleet or inside a fleet-enabled coordination service; a missing config is `off`; an unreadable one fails closed. */
export const loopPartitionStrict = (root: string | undefined): boolean => {
  if (process.env["MCP_FLEET_ENABLED"] === "1") return true;
  if (root === undefined) return false;
  const path = join(resolve(root), ".agents", "config.json");
  if (!existsSync(path)) return false;
  try { const mode = (JSON.parse(readFileSync(path, "utf8")) as { loop?: { mode?: unknown } } | null)?.loop?.mode; return mode === "local" || mode === "fleet"; }
  catch { return true; }
};

/** ` — owns: a, b · after: x` suffix for a rendered workplan line. */
export const workplanScope = (item: Item): string => {
  const parts = [item.ownedPaths?.length ? `owns: ${item.ownedPaths.join(", ")}` : "", item.dependsOn?.length ? `after: ${item.dependsOn.join(", ")}` : ""].filter(Boolean);
  return parts.length ? ` — ${parts.join(" · ")}` : "";
};
