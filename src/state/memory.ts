import { existsSync } from "node:fs";
import type { AgenticMemoryEntry, AgenticMemoryRegistry, Phase } from "../model.js";
import { loadState, loadTask } from "./store.js";
import { assertNoSymlinkPath, idPattern, iso, memoryRegistryPath, parseJsonFile, text, writeAtomic } from "./shared.js";

const memoryPhases = ["clarify", "plan", "build", "wrap", "*"] as const;

const validateMemoryEntry = (entry: AgenticMemoryEntry): void => {
  if (!entry || !idPattern.test(entry.id) || !text(entry.summary) || !text(entry.guidance) || !Array.isArray(entry.areas) || !entry.areas.length || entry.areas.some((area) => !text(area)) || !Array.isArray(entry.phases) || !entry.phases.length || entry.phases.some((phase) => !memoryPhases.includes(phase)) || !Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 100 || !idPattern.test(entry.sourceTaskId) || !idPattern.test(entry.sourceLessonId) || !text(entry.approvedBy) || !iso(entry.approvedAt)) throw new Error(`Invalid agentic memory entry: ${entry?.id ?? "unknown"}`);
};

export const emptyMemoryRegistry = (): AgenticMemoryRegistry => ({ schemaVersion: 1, entries: [], retired: [] });

export const validateMemoryRegistry = (value: unknown): AgenticMemoryRegistry => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agentic memory registry must be an object");
  const registry = value as Partial<AgenticMemoryRegistry>;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.entries) || !Array.isArray(registry.retired)) throw new Error("Unsupported agentic memory registry schema");
  const ids = new Set<string>();
  for (const entry of registry.entries) {
    validateMemoryEntry(entry);
    if (ids.has(entry.id)) throw new Error(`Duplicate agentic memory entry: ${entry.id}`);
    ids.add(entry.id);
  }
  for (const entry of registry.retired) {
    validateMemoryEntry(entry);
    if (!text(entry.retiredBy) || !text(entry.reason) || !iso(entry.retiredAt)) throw new Error(`Invalid retired agentic memory entry: ${entry.id}`);
    if (ids.has(entry.id)) throw new Error(`Agentic memory entry is active and retired: ${entry.id}`);
    ids.add(entry.id);
  }
  return registry as AgenticMemoryRegistry;
};

const registryPathRelative = ".agents/data/memory/agentic-memory.json";

export const loadMemoryRegistry = (root: string): AgenticMemoryRegistry => {
  assertNoSymlinkPath(root, registryPathRelative);
  return existsSync(memoryRegistryPath(root)) ? validateMemoryRegistry(parseJsonFile(memoryRegistryPath(root), "Agentic memory registry")) : emptyMemoryRegistry();
};

export const saveMemoryRegistry = (root: string, registry: AgenticMemoryRegistry): void => {
  const normalized = validateMemoryRegistry(registry);
  assertNoSymlinkPath(root, registryPathRelative);
  writeAtomic(memoryRegistryPath(root), `${JSON.stringify(normalized, null, 2)}\n`);
};

export const selectAgenticMemory = (registry: AgenticMemoryRegistry, areas: string[], phase: Exclude<Phase, "done">, maxChars: number): AgenticMemoryEntry[] => {
  const areaSet = new Set(areas.map((area) => area.toLocaleLowerCase()));
  const matches = registry.entries.filter((entry) => entry.phases.includes("*") || entry.phases.includes(phase)).filter((entry) => entry.areas.includes("*") || entry.areas.some((area) => areaSet.has(area.toLocaleLowerCase()))).sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const selected: AgenticMemoryEntry[] = [];
  let used = 0;
  for (const entry of matches) {
    const size = `- ${entry.id} — ${entry.summary} — guidance: ${entry.guidance} — source: ${entry.sourceTaskId}/${entry.sourceLessonId}\n`.length;
    if (used + size > maxChars) continue;
    selected.push(entry);
    used += size;
  }
  return selected;
};

export const promoteAgenticMemory = (root: string, entry: AgenticMemoryEntry): AgenticMemoryEntry => {
  const state = loadState(root);
  const source = loadTask(root, entry.sourceTaskId, state);
  if (!source?.lessons?.some((lesson) => lesson.id === entry.sourceLessonId)) throw new Error(`Agentic memory source lesson is missing: ${entry.sourceTaskId}/${entry.sourceLessonId}`);
  const registry = loadMemoryRegistry(root);
  const current = registry.entries.find((item) => item.id === entry.id);
  if (current) {
    if (JSON.stringify(current) === JSON.stringify(entry)) return current;
    throw new Error(`Agentic memory entry already exists with different content: ${entry.id}`);
  }
  if (registry.retired.some((item) => item.id === entry.id)) throw new Error(`Retired agentic memory id cannot be reused: ${entry.id}`);
  registry.entries.push(entry);
  registry.entries.sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  saveMemoryRegistry(root, registry);
  return entry;
};

export const retireAgenticMemory = (root: string, id: string, reason: string, retiredBy: string, retiredAt = new Date().toISOString()): AgenticMemoryEntry => {
  if (!text(reason) || !text(retiredBy) || !iso(retiredAt)) throw new Error("Retiring agentic memory requires a reason, approver, and valid timestamp");
  const registry = loadMemoryRegistry(root);
  const index = registry.entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`Unknown active agentic memory entry: ${id}`);
  const [entry] = registry.entries.splice(index, 1);
  if (!entry) throw new Error(`Unknown active agentic memory entry: ${id}`);
  registry.retired.push({ ...entry, retiredBy, retiredAt, reason });
  registry.retired.sort((left, right) => right.retiredAt.localeCompare(left.retiredAt) || left.id.localeCompare(right.id));
  saveMemoryRegistry(root, registry);
  return entry;
};
