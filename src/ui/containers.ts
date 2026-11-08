/**
 * Worker containers of one task for `/api/tasks/:id/containers` and the Containers
 * panel, and the raw container log tail for `/api/tasks/:id/containers/:assignment/log`.
 *
 * The source of truth is the task's own runtime record, written by the loop
 * (`loop-worker-log.mjs`) identically in local and fleet mode:
 *
 *   .agents/data/tasks/<taskId>/runtime/workers/index.json       one entry per container turn
 *   .agents/data/tasks/<taskId>/runtime/workers/<assignmentId>.log  raw output (rotated once to .log.1)
 *
 * Docker only enriches `running`: `docker ps --filter label=aidlc.task=<id>` runs via
 * `execFile` (no shell, allow-listed environment, 4 s timeout) and its result is shared
 * for a short time so live polling does not spawn docker on every tick. When docker is
 * missing, slow, or failing the index still answers and `docker` reads `unavailable`.
 * Every path component is validated against the canonical id pattern and refused when
 * it crosses a symlink (the same rule as the assignment records in ./changes.ts).
 */
import { execFile } from "node:child_process";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { readUiState, readUiTask } from "./data.js";
import { readRange } from "./files.js";
import { TASK_ID_PATTERN, type UiOptions } from "./options.js";

/** Canonical id pattern shared by task, assignment, item, and worker ids (`loop-worker-log.mjs`). */
export const ID_PATTERN = TASK_ID_PATTERN;
export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const MAX_TAIL_BYTES = 1024 * 1024;
export const TRUNCATED_PREFIX = "… (earlier output truncated)\n";
/** How long one `docker ps` answer is shared per task (live polling runs every ~1.5 s). */
export const DOCKER_PS_MAX_AGE_MS = 1500;
const DOCKER_TIMEOUT_MS = 4000;
/** The only variables the docker CLI receives: where the binary is and how to reach the daemon. */
const DOCKER_ENV = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "USERPROFILE", "SystemRoot", "TEMP", "TMP"];

/** One recorded container turn as written by the loop (`index.json`). */
export interface WorkerIndexEntry {
  name: string;
  assignmentId: string;
  itemId?: string;
  workerId?: string;
  agent?: string;
  mode?: "local" | "fleet";
  host?: string;
  turn?: number;
  startedAt: string;
  endedAt?: string;
  /** Exit code; null when the container ended by signal or was finalized without one. */
  exitCode?: number | null;
  log?: string;
}
export interface ContainerEntry extends WorkerIndexEntry {
  /** Still running: no `endedAt` and docker lists the name (or docker is unavailable). */
  running: boolean;
  /** Recorded on this host, so its log file can be served from this checkout. */
  local: boolean;
}
export interface ContainersPayload { ok: true; docker: "ok" | "unavailable"; host: string; containers: ContainerEntry[] }
export type ContainersResult =
  | { status: 200; payload: ContainersPayload }
  | { status: 400 | 404; payload: { ok: false; error: string } };
export interface ContainerLogResult { status: 200 | 400 | 404; body: string; contentType: "text/plain; charset=utf-8"; truncated: boolean; size: number }

/* ---------------------------------------------------------------------------
 * Paths (mirrors `workerLogDirectory` / `workerLogPath` in loop-worker-log.mjs)
 * ------------------------------------------------------------------------- */

class SymlinkRefused extends Error {}

/** `lstat` that reads a missing entry as undefined and refuses a symlink. */
const lstatNoFollow = (path: string): Stats | undefined => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new SymlinkRefused(`Path crosses a symlink: ${path}`);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** `.agents/data/tasks/<taskId>/runtime/workers`, every component checked for symlinks. */
export const workerLogDirectory = (root: string, taskId: string): string => {
  if (!ID_PATTERN.test(taskId)) throw new Error("Invalid task id");
  let path = resolve(root);
  for (const part of [".agents", "data", "tasks", taskId, "runtime", "workers"]) { path = join(path, part); lstatNoFollow(path); }
  return path;
};
export const workerIndexPath = (root: string, taskId: string): string => join(workerLogDirectory(root, taskId), "index.json");
export const workerLogPath = (root: string, taskId: string, assignmentId: string, generation = 0): string => {
  if (!ID_PATTERN.test(assignmentId)) throw new Error("Invalid assignment id");
  return join(workerLogDirectory(root, taskId), `${assignmentId}.log${generation ? `.${generation}` : ""}`);
};

const validEntry = (entry: unknown): entry is WorkerIndexEntry =>
  entry !== null && typeof entry === "object" && !Array.isArray(entry)
  && typeof (entry as WorkerIndexEntry).name === "string" && ID_PATTERN.test((entry as WorkerIndexEntry).name)
  && typeof (entry as WorkerIndexEntry).assignmentId === "string" && ID_PATTERN.test((entry as WorkerIndexEntry).assignmentId)
  && typeof (entry as WorkerIndexEntry).startedAt === "string";

/** The task's container index; missing, corrupt, or symlinked reads as empty. */
export const readWorkerIndex = (root: string, taskId: string): WorkerIndexEntry[] => {
  let raw: string;
  try {
    const path = workerIndexPath(root, taskId);
    if (!lstatNoFollow(path)?.isFile()) return [];
    raw = readFileSync(path, "utf8");
  } catch { return []; }
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(validEntry) : [];
  } catch { return []; }
};

/* ---------------------------------------------------------------------------
 * docker ps
 * ------------------------------------------------------------------------- */

const dockerEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DOCKER_ENV) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
  return env;
};

/** Names of the task's running containers, or undefined when docker cannot answer. */
const dockerRunning = (taskId: string): Promise<Set<string> | undefined> =>
  new Promise((done) => {
    try {
      execFile("docker", ["ps", "--filter", `label=aidlc.task=${taskId}`, "--format", "{{.Names}}"], { shell: false, env: dockerEnv(), timeout: DOCKER_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error) return done(undefined);
        done(new Set(String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)));
      });
    } catch { done(undefined); }
  });

const dockerReads = new Map<string, { at: number; value: Promise<Set<string> | undefined> }>();
/** One `docker ps` per task per DOCKER_PS_MAX_AGE_MS, shared by concurrent requests. */
const sharedDockerRunning = (root: string, taskId: string): Promise<Set<string> | undefined> => {
  const key = `${root}\0${taskId}`;
  const now = Date.now();
  const cached = dockerReads.get(key);
  if (cached && now - cached.at < DOCKER_PS_MAX_AGE_MS) return cached.value;
  const value = dockerRunning(taskId);
  dockerReads.set(key, { at: now, value });
  if (dockerReads.size > 64) { for (const [name, entry] of dockerReads) if (now - entry.at >= DOCKER_PS_MAX_AGE_MS) dockerReads.delete(name); }
  return value;
};

/* ---------------------------------------------------------------------------
 * Public entry points
 * ------------------------------------------------------------------------- */

/**
 * The task's recorded containers with `running` and `local`. 400 for a malformed id,
 * 404 for an unknown task; a missing or corrupt index is an empty list, never an error.
 */
export const taskContainers = async (options: UiOptions, taskId: string): Promise<ContainersResult> => {
  if (!ID_PATTERN.test(taskId)) return { status: 400, payload: { ok: false, error: "Invalid task id" } };
  const task = readUiTask(options, taskId, await readUiState(options));
  if (!task) return { status: 404, payload: { ok: false, error: `Task not found: ${taskId}` } };
  const entries = readWorkerIndex(options.root, taskId);
  const live = await sharedDockerRunning(options.root, taskId);
  const host = hostname();
  const containers = entries.map((entry): ContainerEntry => ({
    ...entry,
    running: !entry.endedAt && (live === undefined || live.has(entry.name)),
    local: entry.host === host,
  }));
  return { status: 200, payload: { ok: true, docker: live === undefined ? "unavailable" : "ok", host, containers } };
};

/**
 * The last `tailBytes` of one assignment's raw log (default 64 KiB, at most 1 MiB; a
 * larger request is clamped). A tail that cut the file starts at the first complete
 * line after the cut, prefixed with one `… (earlier output truncated)` line. When the
 * current log is missing but a rotated `.log.1` exists, that generation is served.
 */
export const containerLog = async (options: UiOptions, taskId: string, assignmentId: string, tailBytes: number = DEFAULT_TAIL_BYTES): Promise<ContainerLogResult> => {
  const contentType = "text/plain; charset=utf-8";
  const fail = (status: 400 | 404, body: string): ContainerLogResult => ({ status, body, contentType, truncated: false, size: 0 });
  if (!ID_PATTERN.test(taskId)) return fail(400, "Invalid task id");
  if (!ID_PATTERN.test(assignmentId)) return fail(400, "Invalid assignment id");
  if (!Number.isSafeInteger(tailBytes) || tailBytes < 1) return fail(400, "Invalid tail: expected a positive number of bytes");
  const tail = Math.min(tailBytes, MAX_TAIL_BYTES);
  const task = readUiTask(options, taskId, await readUiState(options));
  if (!task) return fail(404, `Task not found: ${taskId}`);

  let path: string | undefined;
  let size = 0;
  try {
    for (const generation of [0, 1]) {
      const candidate = workerLogPath(options.root, taskId, assignmentId, generation);
      const stat = lstatNoFollow(candidate);
      if (stat?.isFile()) { path = candidate; size = stat.size; break; }
    }
  } catch { return fail(404, "Container log not found"); }
  if (path === undefined) return fail(404, "Container log not found");

  const truncated = size > tail;
  let buffer: Buffer;
  try { buffer = readRange(path, truncated ? size - tail : 0, size, true); }
  catch { return fail(404, "Container log not found"); }
  let body = buffer.toString("utf8");
  if (truncated) {
    // Drop the partial first line; a tail with no newline at all is kept as is.
    const newline = body.indexOf("\n");
    if (newline >= 0) body = body.slice(newline + 1);
    body = TRUNCATED_PREFIX + body;
  }
  return { status: 200, body, contentType, truncated, size };
};
