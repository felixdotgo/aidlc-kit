/**
 * Local loop runtime: record management, checkpointing, turn orchestration,
 * and pause/resume handling for a single lead.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLoopLease, assertLoopPath, readLiveLease } from "./loop-lease.mjs";
import { isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";

export const DEFAULT_LIMITS = Object.freeze({ maxTurns: 12, turnTimeoutMs: 600000, maxStallTurns: 2 });
const states = new Set(["running", "gate", "paused", "blocked", "terminal", "complete"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();
const bounded = (value, name, max) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer from 1 to ${max}`); return n; };

export function validateLimits(input = {}) {
  return {
    maxTurns: bounded(input.maxTurns ?? DEFAULT_LIMITS.maxTurns, "maxTurns", 1000),
    turnTimeoutMs: bounded(input.turnTimeoutMs ?? DEFAULT_LIMITS.turnTimeoutMs, "turnTimeoutMs", 3600000),
    maxStallTurns: bounded(input.maxStallTurns ?? DEFAULT_LIMITS.maxStallTurns, "maxStallTurns", 20)
  };
}

export function validateRoot(root) {
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`Invalid project root: ${absolute}`);
  for (const part of [".agents", ".agents/aidlc", ".agents/aidlc/scripts", ".agents/data"]) {
    const path = join(absolute, part);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid installed workflow path: ${path}`);
  }
  return absolute;
}

export const loopRecordPath = (root, taskId) => assertLoopPath(root, taskId);

function validateRecord(value, taskId) {
  if (!value || value.schemaVersion !== 1 || value.taskId !== taskId || typeof value.runId !== "string" || !value.runId || !isLoopProvider(value.agent) || !states.has(value.status) || !Number.isSafeInteger(value.iteration) || value.iteration < 0 || !Number.isSafeInteger(value.stallTurns) || value.stallTurns < 0 || (value.sessionId !== null && (typeof value.sessionId !== "string" || !value.sessionId)) || !value.limits || !value.updatedAt || Number.isNaN(Date.parse(value.updatedAt))) throw new Error(`Corrupt loop run record for ${taskId}`);
  if (typeof value.pausedByLoop !== "boolean" || (value.stopReason !== null && typeof value.stopReason !== "string") || (value.checkpoint !== null && (typeof value.checkpoint !== "object" || Array.isArray(value.checkpoint))) || (value.status === "paused" && !value.stopReason)) throw new Error(`Corrupt loop run record for ${taskId}`);
  validateLimits(value.limits);
  if (value.lastFingerprint !== null && (typeof value.lastFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.lastFingerprint))) throw new Error(`Corrupt loop fingerprint for ${taskId}`);
  return value;
}

export function readLoopRecord(root, taskId) {
  const path = loopRecordPath(root, taskId);
  try { lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Corrupt loop run record for ${taskId}: ${error.message}`); }
  return validateRecord(value, taskId);
}

export function writeLoopRecord(root, record) {
  validateRecord(record, record.taskId);
  const path = loopRecordPath(root, record.taskId);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function cli(root, script, args) {
  return execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts", script), ...args, "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
}
function checkAgent(agent, root) {
  try { execFileSync(agent, ["--version"], { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { throw new Error(`Agent CLI ${agent} is unavailable: ${error?.code ?? error?.message ?? "unknown error"}`); }
}
function envelope(root, script, args) {
  const result = JSON.parse(cli(root, script, args));
  if (result?.ok !== true) throw new Error(`${script} did not return a valid result`);
  return result;
}
export function readCanonical(root, taskId) {
  const next = envelope(root, "state.mjs", ["task", "next", taskId]);
  const shown = envelope(root, "state.mjs", ["task", "show", taskId]);
  const task = shown.result;
  if (!task || task.id !== taskId || next.result?.id !== taskId || !next.nextAction?.classification) throw new Error(`Conflicting canonical task state for ${taskId}`);
  return { task, action: next.nextAction };
}

function safeArtifact(root, relative) {
  if (typeof relative !== "string" || !relative.startsWith(".agents/data/tasks/")) return null;
  const target = resolve(root, relative);
  if (!target.startsWith(`${root}/`)) return null;
  let cursor = root;
  for (const part of relative.split("/")) { cursor = join(cursor, part); try { if (lstatSync(cursor).isSymbolicLink()) return null; } catch (error) { if (error?.code !== "ENOENT") return null; } }
  return target;
}

function worktreeSignal(root) {
  let raw;
  try { raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "buffer", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return { kind: "unknown", reason: "git status unavailable or oversized" }; }
  const entries = raw.toString("utf8").split("\0").filter(Boolean);
  if (entries.length > 128) return { kind: "unknown", reason: "too many changed files" };
  const files = [];
  let bytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    let name = entry.slice(3);
    if (/^[RC]/.test(status) || /[RC]$/.test(status)) name = entries[++i] ?? name;
    if (name.startsWith(".agents/data/loop/")) continue;
    const path = resolve(root, name);
    if (!path.startsWith(`${root}/`)) return { kind: "unknown", reason: "unsafe changed path" };
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 1024 * 1024 || bytes + stat.size > 4 * 1024 * 1024) return { kind: "unknown", reason: "changed file unreadable or oversized" };
      bytes += stat.size;
      files.push([name, status, hash(readFileSync(path))]);
    } catch (error) {
      if (error?.code === "ENOENT") files.push([name, status, "deleted"]);
      else return { kind: "unknown", reason: "changed file unreadable" };
    }
  }
  return { kind: "known", digest: hash(JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0])))) };
}

export function fingerprint(root, task, action) {
  const artifacts = {};
  for (const [key, relative] of Object.entries(task.artifacts ?? {})) {
    const path = safeArtifact(root, relative);
    if (!path) { artifacts[key] = "unknown"; continue; }
    try { const stat = statSync(path); artifacts[key] = stat.size > 1024 * 1024 ? "unknown" : hash(readFileSync(path)); }
    catch (error) { artifacts[key] = error?.code === "ENOENT" ? "missing" : "unknown"; }
  }
  const projection = { phase: task.phase, status: task.status, gate: task.gate, decisions: task.decisions, items: task.tasks, evidence: task.evidence, artifacts, action: { classification: action.classification, itemId: action.itemId, reason: action.reason } };
  const tree = worktreeSignal(root);
  return { digest: hash(JSON.stringify({ projection, tree: tree.kind === "known" ? tree.digest : null })), tree };
}

function checkpoint(task, action, signal, iteration, reason = null) {
  return { goal: task.title.slice(0, 500), state: `${task.phase}/${task.status}/${task.gate}`, completed: task.tasks.filter((item) => item.status === "done").map((item) => item.id).slice(0, 30), observations: [`iteration ${iteration}`, `next: ${action.classification}`, `working tree: ${signal.kind}`], hypothesis: null, blockers: reason ? [reason.slice(0, 500)] : [], files: Object.values(task.artifacts ?? {}).slice(0, 10), links: [], nextAction: { classification: action.classification, phase: action.phase, gate: action.gate, itemId: action.itemId, reason: action.reason }, capturedAt: iso() };
}
export const classifyAction = (action) => {
  if (!["run_phase", "await_user", "blocked", "terminal", "complete"].includes(action?.classification)) throw new Error(`Unknown nextAction classification: ${action?.classification}`);
  return action.classification;
};

function approvalCount(task) { return task.evidence.filter((item) => item.kind === "approval" && item.result === "pass").length; }
function outputStop(record, action, gateView) { return { taskId: record.taskId, runId: record.runId, status: record.status, iteration: record.iteration, sessionId: record.sessionId, stopReason: record.stopReason, nextAction: action, ...(gateView ? { gateView } : {}) }; }

export async function runLoop({ root: rootInput, taskId, agent, mode = "run", limits: limitInput, driver, onEvent = () => {}, preflight = false, precondition }) {
  const root = validateRoot(rootInput);
  // --- Validate mode and load/create the loop record -------------------------
  let record = readLoopRecord(root, taskId);
  if (mode === "run") {
    if (record) throw new Error(`Loop record already exists for ${taskId}; use resume`);
    if (!isLoopProvider(agent)) throw new Error(`--agent must be ${LOOP_PROVIDER_LIST}`);
  } else if (mode === "resume") {
    if (!record) throw new Error(`No loop record for ${taskId}; use run`);
    if (["complete", "terminal"].includes(record.status)) throw new Error(`Cannot resume ${record.status} loop`);
    if (agent && agent !== record.agent) throw new Error("Resume must use the recorded agent");
    if (record.status === "running" && !record.sessionId) throw new Error("Interrupted run has no captured session id; inspect canonical task state before starting a new run");
  } else throw new Error(`Invalid loop mode: ${mode}`);
  const limits = validateLimits({ ...(record?.limits ?? {}), ...(limitInput ?? {}) });
  if (preflight) checkAgent(record?.agent ?? agent, root);
  if (!record) record = { schemaVersion: 1, taskId, runId: randomUUID(), agent, status: "running", sessionId: null, iteration: 0, stallTurns: 0, limits, lastFingerprint: null, checkpoint: null, stopReason: null, pausedByLoop: false, updatedAt: iso() };
  else { const prior = { iteration: record.iteration, status: record.status, stopReason: record.stopReason, limits: record.limits }; record.limits = limits; record.stallTurns = 0; onEvent({ type: "resume", prior }); }
  const release = acquireLoopLease(root, taskId, record.runId);
  try {
    let current = readCanonical(root, taskId);
    if (precondition) {
      const expectedHash = hash(JSON.stringify(current.task));
      const evidenceHash = hash(JSON.stringify(current.task.evidence));
      if (precondition.taskId !== taskId || precondition.phase !== current.task.phase || precondition.taskHash !== expectedHash || precondition.evidenceHash !== evidenceHash || precondition.evidenceCount !== current.task.evidence.length || current.task.status !== "active" || current.action.classification !== "run_phase") throw new Error("Supervisor precondition changed before acquiring loop lease");
    }
    if (mode === "resume" && current.task.status === "paused") {
      if (!record.pausedByLoop || current.task.handoff) throw new Error("Task was paused outside this loop; explicit user handling is required");
      current = readCanonical(root, taskId);
      if (current.task.status !== "paused") throw new Error("Task state changed during resume");
      envelope(root, "state.mjs", ["task", "status", taskId, "--status", "active"]);
      record.pausedByLoop = false;
      current = readCanonical(root, taskId);
    }
    const initial = fingerprint(root, current.task, current.action);
    if (mode === "resume" && record.lastFingerprint && record.lastFingerprint !== initial.digest) onEvent({ type: "context_changed", message: "Canonical task context changed since the last checkpoint; continuing from fresh nextAction", previousCheckpointAt: record.checkpoint?.capturedAt ?? null });
    record.lastFingerprint = initial.digest;
    record.checkpoint = checkpoint(current.task, current.action, initial.tree, record.iteration);
    record.status = "running"; record.stopReason = null; record.updatedAt = iso(); writeLoopRecord(root, record);
    // --- Main turn loop --------------------------------------------------------
  for (;;) {
      const kind = classifyAction(current.action);
      if (kind !== "run_phase") {
        record.status = kind === "await_user" ? "gate" : kind;
        record.stopReason = current.action.reason ?? kind;
        record.updatedAt = iso(); writeLoopRecord(root, record);
        const gateView = kind === "await_user" ? cli(root, "gate-view.mjs", [taskId]).trim() : undefined;
        return outputStop(record, current.action, gateView);
      }
      if (record.iteration >= limits.maxTurns) return pause("turn limit reached");
      let prompt;
      try {
        const packet = JSON.parse(cli(root, "context.mjs", [taskId, "--phase", current.action.phase, ...(current.action.itemId ? ["--item", current.action.itemId] : []), "--format", "json"]));
        if (typeof packet?.content !== "string" || !packet.content.trim()) throw new Error("Context packet was empty or invalid");
        prompt = packet.content;
      } catch {
        // No driver has started for this turn, so it is safe to resume after repairing context.
        // Do not persist arbitrary subprocess output or malformed context in the stop reason.
        return pause("context packet generation or validation failed; inspect context.mjs and resume after repair");
      }
      const beforeApprovals = approvalCount(current.task);
      let observedId = record.sessionId;
      try {
        const result = await driver({ agent: record.agent, root, sessionId: record.sessionId ?? undefined, prompt: `${prompt}\n\nLoop supervisor: complete the current authorized phase or item. Use canonical lifecycle commands for evidence and gates. Never approve a human gate. Stop at a gate and report progress.`, timeoutMs: limits.turnTimeoutMs, onSessionId: (id) => { if (typeof id !== "string" || !id) throw new Error("Invalid agent session id"); observedId = id; record.sessionId = id; record.updatedAt = iso(); writeLoopRecord(root, record); }, onEvent: (event) => { onEvent(event); if (event?.type === "lifecycle_command") { const observed = readCanonical(root, taskId); const signal = fingerprint(root, observed.task, observed.action); record.checkpoint = checkpoint(observed.task, observed.action, signal.tree, record.iteration); record.updatedAt = iso(); writeLoopRecord(root, record); } } });
        if (!observedId && result?.sessionId) { observedId = result.sessionId; record.sessionId = observedId; record.updatedAt = iso(); writeLoopRecord(root, record); }
        if (!observedId) throw new Error("Agent turn ended without a resumable session id");
      } catch (error) {
        current = readCanonical(root, taskId);
        if (classifyAction(current.action) === "await_user") continue;
        return pause(`agent transport failure: ${error.message}`);
      }
      const refreshed = readCanonical(root, taskId);
      if (approvalCount(refreshed.task) !== beforeApprovals) return pause("Approval evidence changed during an agent turn");
      const signal = fingerprint(root, refreshed.task, refreshed.action);
      record.iteration += 1;
      record.stallTurns = signal.digest === record.lastFingerprint ? record.stallTurns + 1 : 0;
      record.lastFingerprint = signal.digest;
      record.checkpoint = checkpoint(refreshed.task, refreshed.action, signal.tree, record.iteration);
      record.updatedAt = iso(); writeLoopRecord(root, record);
      current = refreshed;
      if (classifyAction(current.action) === "run_phase" && record.stallTurns >= limits.maxStallTurns) return pause(`${record.stallTurns} consecutive turns without observable progress`);
    }
    function pause(reason) {
      const fresh = readCanonical(root, taskId);
      record.status = "paused"; record.stopReason = reason;
      if (fresh.task.status === "active" && classifyAction(fresh.action) === "run_phase") {
        envelope(root, "state.mjs", ["task", "status", taskId, "--status", "paused", "--mode", "audited", "--reason", reason, "--source", `loop run ${record.runId}`]);
        record.pausedByLoop = true;
      }
      const stopped = readCanonical(root, taskId);
      const signal = fingerprint(root, stopped.task, stopped.action);
      record.lastFingerprint = signal.digest;
      record.checkpoint = checkpoint(stopped.task, stopped.action, signal.tree, record.iteration, reason);
      record.updatedAt = iso(); writeLoopRecord(root, record);
      return outputStop(record, stopped.action);
    }
  } finally { release(); }
}

export function loopStatus(rootInput, taskId) {
  const root = validateRoot(rootInput);
  const record = readLoopRecord(root, taskId);
  const current = readCanonical(root, taskId);
  return { record, liveLease: readLiveLease(root, taskId), nextAction: current.action };
}
