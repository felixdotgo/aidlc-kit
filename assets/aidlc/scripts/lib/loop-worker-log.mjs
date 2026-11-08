/**
 * Per-task record of worker containers and a raw tee of their output.
 *
 * Both the local loop (`loop-local-workers.mjs`) and fleet workers
 * (`loop-fleet-cli.mjs`) write the same structure under the task's own data
 * directory, so the dashboard lists containers identically in every mode:
 *
 *   .agents/data/tasks/<taskId>/runtime/workers/index.json      one entry per container (turn)
 *   .agents/data/tasks/<taskId>/runtime/workers/<assignmentId>.log  raw stdout+stderr, all turns
 *
 * The log is capped at WORKER_LOG_MAX_BYTES and rotates once to `.log.1`
 * (overwritten), the same rule as the per-task event log. Writes never throw
 * into the caller: the first failure is reported through `onError`, later ones
 * are swallowed. The `runtime/` directory is operational and never committed.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { taskRuntimeDir } from "./task-runtime.mjs";

export const WORKER_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const WORKER_INDEX_MAX_ENTRIES = 500;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODES = new Set(["local", "fleet"]);
const safeId = (value, label) => { if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`); return value; };
const iso = () => new Date().toISOString();

/** True when `path` is missing or a real (non-symlink) entry. */
const refuseSymlink = (path) => {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Worker log path crosses symlink: ${path}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
};

/** `.agents/data/tasks/<taskId>/runtime/workers`, refusing symlinked components. */
export function workerLogDirectory(root, taskId) {
  const path = join(taskRuntimeDir(root, safeId(taskId, "task id")), "workers");
  refuseSymlink(path);
  return path;
}
export const workerIndexPath = (root, taskId) => join(workerLogDirectory(root, taskId), "index.json");
export function workerLogPath(root, taskId, assignmentId, generation = 0) {
  safeId(assignmentId, "assignment id");
  const path = join(workerLogDirectory(root, taskId), `${assignmentId}.log${generation ? `.${generation}` : ""}`);
  refuseSymlink(path);
  return path;
}

const validEntry = (entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.name === "string" && typeof entry.assignmentId === "string" && typeof entry.startedAt === "string";

/** Read a task's container index; a missing or corrupt file reads as empty. */
export function readWorkerIndex(root, taskId) {
  let raw;
  try { raw = readFileSync(workerIndexPath(root, taskId), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter(validEntry) : []; }
  catch { return []; }
}

function writeWorkerIndex(directory, entries) {
  const path = join(directory, "index.json"), temp = join(directory, `index.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  const trimmed = entries.length > WORKER_INDEX_MAX_ENTRIES ? entries.slice(entries.length - WORKER_INDEX_MAX_ENTRIES) : entries;
  const fd = openSync(temp, "w", 0o644);
  try { writeSync(fd, `${JSON.stringify(trimmed, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temp, path); }
  catch (error) { try { unlinkSync(temp); } catch { /* best effort */ } throw error; }
}

/**
 * Open the container record and raw log for one assignment.
 * Returns `{ turnStart(containerName, turn), tee(child), turnEnd(exitCode), close() }`.
 * `turnStart` appends `--- turn <N> container <name> <ISO> ---` and adds an index
 * entry; `tee` appends every stdout/stderr chunk unmodified; `turnEnd` appends a
 * trailer and records `endedAt`/`exitCode`; `close` ends a dangling turn
 * (exitCode null) and releases the file descriptor. Methods never throw.
 */
export function openWorkerLog({ root, taskId, assignmentId, itemId, workerId, agent, mode, onError, maxBytes = WORKER_LOG_MAX_BYTES } = {}) {
  if (typeof root !== "string" || !root) throw new Error("Worker log root is required");
  safeId(taskId, "task id"); safeId(assignmentId, "assignment id"); safeId(itemId, "item id"); safeId(workerId, "worker id"); safeId(agent, "agent");
  if (!MODES.has(mode)) throw new Error("Worker log mode must be local or fleet");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid worker log size cap");
  const base = resolve(root), host = hostname(), logName = `${assignmentId}.log`;
  let fd = null, size = 0, reported = false, current = null, closed = false;
  const report = (error) => {
    if (reported) return;
    reported = true;
    if (typeof onError === "function") { try { onError(error instanceof Error ? error : new Error(String(error))); } catch { /* diagnostics never throw */ } }
  };
  const guard = (fn) => { try { fn(); } catch (error) { report(error); } };
  const directory = () => { const path = workerLogDirectory(base, taskId); mkdirSync(path, { recursive: true }); refuseSymlink(path); return path; };
  const open = () => {
    if (fd !== null) return;
    const path = workerLogPath(base, taskId, assignmentId);
    directory();
    fd = openSync(path, "a", 0o644);
    try { size = lstatSync(path).size; } catch { size = 0; }
  };
  const write = (chunk) => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (!bytes.length) return;
    open();
    if (size > 0 && size + bytes.length > maxBytes) {
      closeSync(fd); fd = null;
      const path = workerLogPath(base, taskId, assignmentId);
      refuseSymlink(workerLogPath(base, taskId, assignmentId, 1));
      renameSync(path, `${path}.1`);
      open();
    }
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    size += bytes.length;
  };
  const updateIndex = (mutate) => {
    const dir = directory();
    const entries = readWorkerIndex(base, taskId);
    writeWorkerIndex(dir, mutate(entries));
  };
  const finish = (exitCode) => {
    if (!current) return;
    const entry = current; current = null;
    const endedAt = iso(), code = Number.isSafeInteger(exitCode) ? exitCode : null;
    try { write(`--- end turn ${entry.turn} container ${entry.name} exit ${code === null ? "signal" : code} ${endedAt} ---\n`); }
    catch (error) { report(error); }
    updateIndex((entries) => {
      const index = entries.findIndex((candidate) => candidate.name === entry.name && candidate.assignmentId === assignmentId && candidate.turn === entry.turn);
      const record = { ...(index === -1 ? entry.record : entries[index]), endedAt, exitCode: code };
      if (index === -1) entries.push(record); else entries[index] = record;
      return entries;
    });
  };
  return {
    turnStart(containerName, turn) {
      guard(() => {
        if (closed) throw new Error("Worker log is closed");
        safeId(containerName, "container name");
        if (!Number.isSafeInteger(turn) || turn < 0) throw new Error("Invalid worker turn");
        if (current) finish(null);
        const startedAt = iso();
        const record = { name: containerName, assignmentId, itemId, workerId, agent, mode, host, turn, startedAt, log: logName };
        current = { name: containerName, turn, record };
        write(`--- turn ${turn} container ${containerName} ${startedAt} ---\n`);
        updateIndex((entries) => { entries.push(record); return entries; });
      });
    },
    tee(child) {
      const listener = (chunk) => guard(() => write(chunk));
      for (const stream of [child?.stdout, child?.stderr]) { if (stream && typeof stream.on === "function") stream.on("data", listener); }
      return child;
    },
    turnEnd(exitCode) { guard(() => finish(exitCode)); },
    close() {
      guard(() => finish(null));
      closed = true;
      if (fd !== null) { const handle = fd; fd = null; try { closeSync(handle); } catch (error) { report(error); } }
    }
  };
}
