/**
 * Authority-neutral read model: local reads canonical state in-process; fleet asks
 * `loop-entry.mjs` (the only place that speaks to the coordination service).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGate, gateView } from "../gate.js";
import type { TaskState, WorkflowState } from "../model.js";
import { assertTaskArtifactPath, loadState, loadTask } from "../state.js";
import { runNode } from "./daemon.js";
import { loopArgs, uiMode, type UiOptions } from "./options.js";

export const ARTIFACT_NAMES = ["intent", "design", "workplan"] as const;

const FEEDBACK_DETAIL = /^Cancelled gate wait at (G0_confirm|G1_review|G2_codereview): /;

/** Feedback entries not yet followed by a passing approval of that gate
 * (mirrors `pendingFeedback` in the installed `loop-runtime.mjs`). */
export const pendingFeedback = (task: Pick<TaskState, "evidence">): Array<{ gate: string; text: string; recordedAt: string }> => {
  const pending: Array<{ gate: string; text: string; recordedAt: string }> = [];
  task.evidence.forEach((entry, index) => {
    if (entry.kind !== "diagnostic" || typeof entry.detail !== "string") return;
    const match = FEEDBACK_DETAIL.exec(entry.detail);
    if (!match) return;
    const gate = match[1] ?? "";
    const approvedAfter = task.evidence.slice(index + 1).some((later) => later.kind === "approval" && later.result === "pass" && later.gate === gate);
    if (!approvedAfter) pending.push({ gate, text: entry.detail.slice(match[0].length), recordedAt: entry.recordedAt });
  });
  return pending;
};

/* Fleet reads spawn `loop-entry.mjs`; live polling (every ~1.5s per open tab)
 * shares one in-flight or recent result per key instead of spawning per request. */
const fleetReads = new Map<string, { at: number; value: Promise<unknown> }>();
const sharedFleetRead = <T>(key: string, maxAgeMs: number, read: () => Promise<T>): Promise<T> => {
  if (maxAgeMs <= 0) return read();
  const now = Date.now();
  const cached = fleetReads.get(key);
  if (cached && now - cached.at < maxAgeMs) return cached.value as Promise<T>;
  const value = read();
  fleetReads.set(key, { at: now, value });
  value.catch(() => { if (fleetReads.get(key)?.value === value) fleetReads.delete(key); });
  return value;
};
/** How stale a fleet read on the live-update path may be. Mutations always read fresh. */
export const LIVE_FLEET_MAX_AGE_MS = 1000;

export const readUiState = async (options: UiOptions, maxAgeMs = 0): Promise<WorkflowState> => {
  if (uiMode(options) === "local") return loadState(options.root);
  return sharedFleetRead(`${options.root}\0tasks`, maxAgeMs, async () => {
    const parsed = JSON.parse(await runNode(options.root, loopArgs(options.root, "tasks"), { timeout: 15000 })) as { tasks?: TaskState[] };
    if (!Array.isArray(parsed.tasks)) throw new Error("Fleet task list is unavailable");
    return { schemaVersion: 4, tasks: Object.fromEntries(parsed.tasks.map((task) => [task.id, task])), archive: {} } as WorkflowState;
  });
};
export const readUiTask = (options: UiOptions, id: string, state: WorkflowState): TaskState | undefined =>
  uiMode(options) === "local" ? loadTask(options.root, id, state) : state.tasks[id];

export interface FleetGate { ok?: boolean; gate?: string; status?: string; checkpoint?: { snapshotId?: string; status?: string } | null; snapshot?: { id?: string; reviewText?: string; integrationCommit?: string | null } | null }
export const fleetGate = (options: UiOptions, id: string, maxAgeMs = 0): Promise<FleetGate> =>
  sharedFleetRead(`${options.root}\0gate\0${id}`, maxAgeMs, async () => JSON.parse(await runNode(options.root, loopArgs(options.root, "gate", id), { timeout: 15000 })) as FleetGate);

export const taskGatePayload = async (options: UiOptions, id: string, known?: WorkflowState, maxAgeMs = 0): Promise<{ ok: boolean; error?: string; gate?: string; view?: unknown; snapshot?: FleetGate["snapshot"] }> => {
  const state = known ?? await readUiState(options, maxAgeMs);
  const task = readUiTask(options, id, state);
  if (!task) return { ok: false, error: `Task not found: ${id}` };
  if (task.status !== "blocked_on_user" || task.gate === "none") return { ok: false, error: "Task is not waiting at a human gate" };
  if (uiMode(options) === "fleet") {
    const gate = await fleetGate(options, id, maxAgeMs);
    return gate.snapshot ? { ok: true, gate: task.gate, snapshot: gate.snapshot } : { ok: false, error: "No current review snapshot for this gate yet" };
  }
  const diagnostics = checkGate(options.root, state, id, task.gate);
  return { ok: true, gate: task.gate, view: gateView(task, diagnostics) };
};

export const artifactPayload = (root: string, id: string, name: string, task: TaskState | undefined = loadTask(root, id)): { ok: boolean; error?: string; name?: string; content?: string } => {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) return { ok: false, error: `Unknown artifact: ${name}` };
  if (!task) return { ok: false, error: `Task not found: ${id}` };
  const artifactPath = task.artifacts?.[name as (typeof ARTIFACT_NAMES)[number]];
  if (!artifactPath) return { ok: false, error: `Artifact ${name} not recorded for ${id}` };
  assertTaskArtifactPath(id, artifactPath);
  try {
    return { ok: true, name, content: readFileSync(join(root, artifactPath), "utf8") };
  } catch {
    return { ok: false, error: `Artifact ${name} is missing for ${id}` };
  }
};
