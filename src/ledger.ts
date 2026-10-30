import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskState, WorkflowState } from "./model.js";
import { validateState } from "./state.js";

export const trackedTasksPath = (root: string): string => join(resolve(root), ".agents/workflow/tasks");
export const taskEventsPath = (root: string, taskId: string): string => join(trackedTasksPath(root), taskId, "events");

export interface TaskLedgerEvent {
  schemaVersion: 1;
  id: string;
  taskId: string;
  parentDigest: string | null;
  actor: string;
  recordedAt: string;
  snapshot: TaskState;
  digest: string;
}

type UnsignedEvent = Omit<TaskLedgerEvent, "digest">;

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const eventContent = (event: TaskLedgerEvent): string => `${JSON.stringify(event, null, 2)}\n`;
const eventPath = (root: string, event: TaskLedgerEvent): string => join(taskEventsPath(root, event.taskId), `${event.id}.json`);
const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

const assertSafeTaskId = (taskId: string): void => {
  if (!taskIdPattern.test(taskId)) throw new Error(`Invalid ledger task id: ${taskId}`);
};

const atomicWrite = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
};

export const validateLedgerEvent = (value: unknown): TaskLedgerEvent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ledger event must be an object");
  const event = value as Partial<TaskLedgerEvent>;
  if (event.schemaVersion !== 1 || typeof event.id !== "string" || !taskIdPattern.test(event.id) || typeof event.taskId !== "string" || !taskIdPattern.test(event.taskId) || (event.parentDigest !== null && !/^[a-f0-9]{64}$/.test(event.parentDigest ?? "")) || typeof event.actor !== "string" || !event.actor.trim() || !iso(event.recordedAt) || !event.snapshot || typeof event.digest !== "string" || !/^[a-f0-9]{64}$/.test(event.digest)) throw new Error("Invalid ledger event fields");
  if (event.snapshot.id !== event.taskId) throw new Error(`Ledger event task mismatch: ${event.id}`);
  validateState({ schemaVersion: 4, tasks: { [event.taskId]: event.snapshot }, archive: {} });
  const { digest: supplied, ...unsigned } = event as TaskLedgerEvent;
  if (digest(unsigned) !== supplied) throw new Error(`Ledger event digest mismatch: ${event.id}`);
  return event as TaskLedgerEvent;
};

export const createLedgerEvent = (task: TaskState, parentDigest: string | null, actor: string, recordedAt = new Date().toISOString(), id: string = randomUUID()): TaskLedgerEvent => {
  assertSafeTaskId(task.id);
  if (!actor.trim() || !iso(recordedAt) || !taskIdPattern.test(id)) throw new Error("Invalid ledger event metadata");
  validateState({ schemaVersion: 4, tasks: { [task.id]: task }, archive: {} });
  const unsigned: UnsignedEvent = { schemaVersion: 1, id, taskId: task.id, parentDigest, actor, recordedAt, snapshot: task };
  return { ...unsigned, digest: digest(unsigned) };
};

export const loadTaskLedger = (root: string, taskId: string): TaskLedgerEvent[] => {
  assertSafeTaskId(taskId);
  const directory = taskEventsPath(root, taskId);
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Ledger path crosses a symlink: ${taskId}`);
  const events = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => validateLedgerEvent(JSON.parse(readFileSync(join(directory, entry.name), "utf8"))))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (events.some((event) => event.taskId !== taskId)) throw new Error(`Ledger event is in the wrong task directory: ${taskId}`);
  return events;
};

export const reduceTaskLedger = (events: readonly TaskLedgerEvent[]): { task: TaskState; headDigest: string } | undefined => {
  if (!events.length) return undefined;
  const byDigest = new Map(events.map((event) => [event.digest, event]));
  if (byDigest.size !== events.length) throw new Error("Duplicate ledger event digest");
  const roots = events.filter((event) => event.parentDigest === null);
  if (roots.length !== 1) throw new Error("Ledger must have exactly one root event");
  const children = new Map<string, TaskLedgerEvent[]>();
  for (const event of events) if (event.parentDigest) {
    if (!byDigest.has(event.parentDigest)) throw new Error(`Ledger event has unknown parent: ${event.id}`);
    const siblings = children.get(event.parentDigest) ?? [];
    siblings.push(event); children.set(event.parentDigest, siblings);
  }
  const sibling = [...children.values()].find((items) => items.length > 1);
  if (sibling) throw new Error(`Concurrent ledger events require resolution: ${sibling.map((event) => event.id).join(", ")}`);
  const visited = new Set<string>();
  const rootEvent = roots[0];
  if (!rootEvent) throw new Error("Ledger must have exactly one root event");
  let current = rootEvent;
  while (true) {
    if (visited.has(current.digest)) throw new Error("Ledger event cycle");
    visited.add(current.digest);
    const next = children.get(current.digest) ?? [];
    if (!next.length) break;
    current = next[0]!;
  }
  if (visited.size !== events.length) throw new Error("Ledger contains disconnected events");
  return { task: current.snapshot, headDigest: current.digest };
};

export const loadTrackedState = (root: string): WorkflowState | undefined => {
  const directory = trackedTasksPath(root);
  if (!existsSync(directory)) return undefined;
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Tracked ledger path crosses a symlink");
  const tasks: Record<string, TaskState> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !taskIdPattern.test(entry.name)) continue;
    const reduced = reduceTaskLedger(loadTaskLedger(root, entry.name));
    if (reduced) tasks[entry.name] = reduced.task;
  }
  return validateState({ schemaVersion: 4, tasks, archive: {} });
};

export const appendTaskLedgerEvent = (root: string, task: TaskState, actor: string): TaskLedgerEvent => {
  const current = reduceTaskLedger(loadTaskLedger(root, task.id));
  const event = createLedgerEvent(task, current?.headDigest ?? null, actor);
  const path = eventPath(root, event);
  if (existsSync(path)) throw new Error(`Ledger event already exists: ${event.id}`);
  atomicWrite(path, eventContent(event));
  return event;
};
