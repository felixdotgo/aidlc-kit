// `leases` diagnostic: who holds what, until when, what it blocks, and how to
// clear it. Read-only except `--clear-stale`, which removes only stale or old
// corrupt lease/lock/guard files after re-reading them under the holder guard.
// It never removes a live holder, never releases a claim, and never touches the
// lifecycle state lock (that lock reclaims itself).
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ASSIGNMENT_STATE_LABELS, assignmentReadPath, assignmentRemedy, showLocalAssignments } from "./assignment-store.mjs";
import { isRegularFile, legacyTaskRuntimePath, taskRuntimePath } from "./task-runtime.mjs";
import { CLEAR_STALE_COMMAND, clearStaleHolder, explainHolder, formatAge, GUARD_STALE_MS, LEASE_TTL_MS, LOCK_TTL_MS, pidAlive, readGuard, readHolder } from "./loop-holder.mjs";

export const LEASES_SCHEMA_VERSION = 1;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_LOCK_STALE_MS = 30000;

const loopDir = (root) => join(root, ".agents", "data", "loop");
const assignmentsDir = (root) => join(loopDir(root), "assignments");
const tasksDir = (root) => join(root, ".agents", "data", "tasks");
const isDirectory = (path) => { try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } };
const listDir = (dir) => { try { return readdirSync(dir).sort(); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } };
const isFile = (path) => { try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };

function holderFields(entry) {
  const holder = entry.holder;
  if (!holder) return { holder: null, heartbeatAt: null, expiresAt: null };
  const since = holder.startedAt ?? holder.createdAt ?? null;
  return {
    holder: { pid: holder.pid, host: holder.host ?? null, command: holder.command ?? null, purpose: holder.purpose ?? null, activity: holder.activity ?? null, startedAt: typeof since === "number" ? new Date(since).toISOString() : since, version: entry.version },
    heartbeatAt: holder.heartbeatAt ?? null,
    expiresAt: holder.expiresAt ?? null,
  };
}

function remedyFor(entry, liveRemedy) {
  if (entry.state === "live") return liveRemedy;
  return explainHolder(entry).remedy;
}

function holderEntry({ category, kind, scope, entry, blocks, liveRemedy, ttlMs, clearable = true }) {
  const effectiveBlocks = entry.state === "stale" ? `nothing while stale (the next acquire reclaims it); it was held for: ${blocks}` : blocks;
  return { category, kind, scope, path: entry.path, state: entry.state, reason: entry.reason, ...holderFields(entry), blocks: effectiveBlocks, remedy: remedyFor(entry, liveRemedy), clearable: clearable && entry.reclaimable, ttlMs };
}

function guardEntry(path, scope, category = "guard") {
  const guard = readGuard(path);
  if (!guard) return null;
  return {
    category, kind: "guard", scope, path, state: guard.live ? "live" : "stale",
    reason: guard.live ? `held for ${formatAge(guard.ageMs)}` : `abandoned (${formatAge(guard.ageMs)} old)`,
    holder: null, heartbeatAt: null, expiresAt: null,
    blocks: "concurrent reclaim/heartbeat/release of the guarded holder (held for milliseconds)",
    remedy: guard.live ? `Short-lived; it is treated as abandoned after ${formatAge(GUARD_STALE_MS)}` : `Removed automatically by the next acquire, or run: ${CLEAR_STALE_COMMAND}`,
    clearable: !guard.live, ttlMs: GUARD_STALE_MS,
  };
}

function stateLockEntry(root) {
  const path = join(root, ".agents", "data", "state", ".aidlc-state.lock");
  const entry = readHolder(path, { ttlMs: STATE_LOCK_STALE_MS });
  if (entry.state === "absent") return null;
  // The state lock reclaims itself when its pid is gone AND it is >=30s old.
  let state = entry.state;
  if (entry.holder) state = pidAlive(entry.holder.pid) || entry.ageMs < STATE_LOCK_STALE_MS ? "live" : "stale";
  return {
    category: "state-lock", kind: "lock", scope: "lifecycle-state", path, state, reason: entry.holder ? (pidAlive(entry.holder.pid) ? "held" : `pid ${entry.holder.pid} is not running`) : entry.reason,
    ...holderFields(entry),
    blocks: "every lifecycle mutation (state.mjs) waits up to 5s for it",
    remedy: state === "live" ? "Short-lived; wait for the lifecycle command to finish" : "Reclaimed automatically by the next lifecycle command (pid gone and at least 30s old); leases never removes it",
    clearable: false, ttlMs: STATE_LOCK_STALE_MS,
  };
}

function taskLeaseBlocks(taskId, entry) {
  const turn = entry.version === 2 ? entry.holder?.activity === "turn" : entry.version === 1;
  return turn
    ? `another loop runner/supervisor for ${taskId}, and state.mjs gate approve ${taskId} (a turn is running)`
    : `another loop runner/supervisor for ${taskId} (gate approval is allowed while it waits)`;
}

function claimState(effective) {
  if (effective === "leased" || effective === "reported") return "live";
  if (effective === "expired" || effective === "uncertain") return "expired";
  return effective;
}

function collectClaims(root, taskId) {
  const out = [];
  let value, recordPath;
  try { recordPath = assignmentReadPath(root, taskId); value = showLocalAssignments(root, taskId); }
  catch (error) {
    return [{ category: "claim", kind: "claim", scope: `assignments:${taskId}`, path: recordPath ?? join(assignmentsDir(root), `${taskId}.json`), state: "corrupt", reason: error.message, holder: null, heartbeatAt: null, expiresAt: null, blocks: `every assignment command for ${taskId}`, remedy: "Inspect the file by hand; leases never edits assignment records", clearable: false, ttlMs: null }];
  }
  for (const assignment of value.assignments) {
    if (!["leased", "reported", "uncertain"].includes(assignment.state)) continue;
    const effective = assignment.effectiveState;
    out.push({
      category: "claim", kind: "claim", scope: `item:${taskId}/${assignment.itemId}`, path: recordPath,
      state: claimState(effective), reason: ASSIGNMENT_STATE_LABELS[effective] ?? effective,
      holder: { worker: assignment.workerId, assignmentId: assignment.id, attempt: assignment.attempt, ownedPaths: assignment.ownedPaths, persistedState: assignment.state, effectiveState: effective },
      heartbeatAt: assignment.updatedAt ?? null, expiresAt: assignment.leaseExpiresAt,
      blocks: `item ${assignment.itemId} and paths ${assignment.ownedPaths.join(", ")} for other workers`,
      remedy: assignmentRemedy(taskId, assignment),
      clearable: false, ttlMs: null,
    });
  }
  return out;
}

/** Collect every local holder under `.agents/data` (optionally one task). */
export function collectLocalLeases(rootInput, { taskId } = {}) {
  const root = resolve(rootInput);
  if (taskId !== undefined && !ID.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const entries = [];
  const wanted = (id) => taskId === undefined || id === taskId;
  const daemonPath = join(loopDir(root), "daemon.lock");
  if (taskId === undefined) {
    const daemon = readHolder(daemonPath, { ttlMs: LEASE_TTL_MS });
    if (daemon.state !== "absent") entries.push(holderEntry({ category: "daemon", kind: "lease", scope: "daemon", entry: daemon, blocks: "a second `loop start` (one daemon per project root)", liveRemedy: `Stop that \`loop start\` (Ctrl-C) or wait; if the process is gone the lease expires after ${formatAge(LEASE_TTL_MS)}`, ttlMs: LEASE_TTL_MS }));
    const guard = guardEntry(`${daemonPath}.guard`, "daemon");
    if (guard) entries.push(guard);
  }
  for (const name of listDir(loopDir(root))) {
    const path = join(loopDir(root), name);
    if (!isFile(path)) continue;
    let match;
    if ((match = /^(.+)\.lease$/.exec(name)) && !name.endsWith(".supervisor.lease") && ID.test(match[1]) && wanted(match[1])) {
      const id = match[1];
      const entry = readHolder(path, { ttlMs: LEASE_TTL_MS });
      entries.push(holderEntry({ category: "task", kind: "lease", scope: `task:${id}`, entry, blocks: taskLeaseBlocks(id, entry), liveRemedy: `Stop the owning loop process or wait for it to reach a gate; if the process is gone the lease expires after ${formatAge(LEASE_TTL_MS)}`, ttlMs: LEASE_TTL_MS }));
    } else if ((match = /^(.+)\.supervisor\.lease$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) {
      const id = match[1];
      const entry = readHolder(path, { ttlMs: LEASE_TTL_MS });
      entries.push(holderEntry({ category: "legacy", kind: "lease", scope: `task:${id} (v1 supervisor)`, entry, blocks: `the new loop for ${id} (left by a previous aidlc-kit version)`, liveRemedy: "A loop from the previous version is still running: stop the loop daemon and any `loop start`", ttlMs: LEASE_TTL_MS }));
    } else if ((match = /^(.+)\.supervisor\.guard$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) {
      const guard = guardEntry(path, `task:${match[1]} (v1 supervisor)`, "legacy");
      if (guard) entries.push(guard);
    } else if ((match = /^(.+)\.lease\.guard$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) {
      const guard = guardEntry(path, `task:${match[1]}`);
      if (guard) entries.push(guard);
    }
  }
  const taskIds = new Set();
  const assignmentLock = (path, id) => {
    const entry = readHolder(path, { ttlMs: LOCK_TTL_MS });
    entries.push(holderEntry({ category: "assignment-lock", kind: "lock", scope: `assignments:${id}`, entry, blocks: `assignment claim/report/reconcile/release for ${id} (they wait up to 5s)`, liveRemedy: "Short-lived; wait for the assignment command to finish", ttlMs: LOCK_TTL_MS }));
  };
  // Current layout: .agents/data/tasks/<id>/runtime/{assignments.json,assignments.lock}.
  for (const id of listDir(tasksDir(root))) {
    if (!ID.test(id) || !wanted(id) || !isDirectory(join(tasksDir(root), id))) continue;
    let lock, guard, record;
    try { lock = taskRuntimePath(root, id, "assignments.lock"); guard = `${lock}.guard`; record = taskRuntimePath(root, id, "assignments.json"); } catch { continue; }
    if (isFile(lock)) assignmentLock(lock, id);
    const guardFound = isFile(guard) ? guardEntry(guard, `assignments:${id}`) : null;
    if (guardFound) entries.push(guardFound);
    if (isFile(record)) taskIds.add(id);
  }
  // Pre-runtime layout (.agents/data/loop/assignments/<id>.*): a record still
  // here is read as that task's claims until it is migrated; its lock files
  // are short-lived leftovers that `--clear-stale` may remove.
  for (const name of listDir(assignmentsDir(root))) {
    const path = join(assignmentsDir(root), name);
    if (!isFile(path)) continue;
    let match;
    if ((match = /^(.+)\.lock$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) assignmentLock(path, match[1]);
    else if ((match = /^(.+)\.lock\.guard$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) {
      const guard = guardEntry(path, `assignments:${match[1]}`);
      if (guard) entries.push(guard);
    } else if ((match = /^(.+)\.json$/.exec(name)) && ID.test(match[1]) && wanted(match[1])) {
      if (taskIds.has(match[1])) entries.push({ category: "legacy", kind: "leftover", scope: `assignments:${match[1]} (pre-runtime copy)`, path, state: "stale", reason: "superseded by the runtime/ record; left by a previous aidlc-kit version", holder: null, heartbeatAt: null, expiresAt: null, blocks: "nothing (the runtime/ record is authoritative)", remedy: "Inspect and delete by hand, or run: node .agents/aidlc/scripts/loop-entry.mjs migrate-data --dry-run --json", clearable: false, ttlMs: null });
      else taskIds.add(match[1]);
    }
  }
  for (const id of taskIds) entries.push(...collectClaims(root, id));
  const stateLock = stateLockEntry(root);
  if (stateLock) entries.push(stateLock);
  return entries;
}

/** Read-only fleet view from `fleet_get`: supervisor lease, lead lease
 * (run_claim) and job claims. Supervisor epoch is shown only when it differs
 * from the lead epoch. */
export function summarizeFleet(fleet, { taskId, now = Date.now() } = {}) {
  const live = (expiresAt) => (Date.parse(expiresAt ?? "") > now ? "live" : "expired");
  const tasks = new Set([...Object.keys(fleet?.leads ?? {}), ...Object.keys(fleet?.supervisors ?? {})].filter((id) => taskId === undefined || id === taskId));
  const entries = [];
  for (const id of [...tasks].sort()) {
    const lead = fleet.leads?.[id];
    const supervisor = fleet.supervisors?.[id];
    if (lead) entries.push({ category: "fleet-lead", kind: "lease", scope: `task:${id}`, state: live(lead.expiresAt), holder: { actor: lead.actor ?? null, leadEpoch: lead.epoch, ...(supervisor && supervisor.epoch !== lead.epoch ? { supervisorEpoch: supervisor.epoch } : {}) }, expiresAt: lead.expiresAt ?? null, blocks: `another lead for ${id}`, remedy: live(lead.expiresAt) === "live" ? "Stop the `loop start` on the lead machine or wait for the lease to expire (5 minutes without heartbeat)" : "Expired: the next `loop start` takes over" });
    else if (supervisor) entries.push({ category: "fleet-supervisor", kind: "lease", scope: `task:${id}`, state: live(supervisor.expiresAt), holder: { actor: supervisor.actor ?? null, supervisorEpoch: supervisor.epoch }, expiresAt: supervisor.expiresAt ?? null, blocks: `another supervisor for ${id}`, remedy: "Stop the other `loop start` or wait for the lease to expire" });
  }
  for (const job of Object.values(fleet?.jobs ?? {}).sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (taskId !== undefined && job.taskId !== taskId) continue;
    if (!["leased", "uncertain", "reported"].includes(job.state)) continue;
    const state = job.state === "leased" ? live(job.expiresAt) : job.state === "uncertain" ? "expired" : "live";
    entries.push({ category: "fleet-job", kind: "claim", scope: `item:${job.taskId}/${job.itemId}`, state, holder: { worker: job.workerId, jobId: job.id, jobEpoch: job.epoch ?? null, attempt: job.attempt ?? null, persistedState: job.state }, expiresAt: job.expiresAt ?? null, blocks: `item ${job.itemId} for other workers`, remedy: state === "live" ? "Wait for the worker to report" : "The lead reconciles it on its next run" });
  }
  return entries;
}

/** Remove stale/old-corrupt entries from `collectLocalLeases`; returns the
 * removed paths. Live holders, claims, and the state lock are never touched. */
export function clearStaleLeases(entries) {
  const cleared = [];
  for (const entry of entries) {
    if (!entry.clearable || entry.state === "live") continue;
    if (entry.kind === "guard") {
      const observed = readGuard(entry.path);
      const again = observed && !observed.live ? readGuard(entry.path) : null;
      if (again && !again.live && again.token === observed.token) { try { unlinkSync(entry.path); cleared.push(entry.path); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
      continue;
    }
    if (!["lease", "lock"].includes(entry.kind) || !["daemon", "task", "assignment-lock", "legacy"].includes(entry.category)) continue;
    if (clearStaleHolder(entry.path, { ttlMs: entry.ttlMs ?? LEASE_TTL_MS })) cleared.push(entry.path);
  }
  return cleared;
}

/** Run the diagnostic. `fleetReader` (optional) returns the `fleet_get` result. */
export async function runLeases({ root: rootInput, taskId, clearStale = false, fleetReader, now = Date.now() } = {}) {
  const root = resolve(rootInput);
  let local = collectLocalLeases(root, { taskId });
  let cleared = [];
  if (clearStale) { cleared = clearStaleLeases(local); local = collectLocalLeases(root, { taskId }); }
  let fleet = null;
  if (fleetReader) {
    try { const current = await fleetReader(); fleet = { revision: current?.revision ?? null, entries: summarizeFleet(current?.fleet, { taskId, now }), error: null }; }
    catch (error) { fleet = { revision: null, entries: [], error: error.message }; }
  }
  return { schemaVersion: LEASES_SCHEMA_VERSION, root, taskId: taskId ?? null, generatedAt: new Date(now).toISOString(), entries: local, fleet, cleared };
}

const VOCABULARY = "lock = short mutex while a file is written · lease = process ownership (daemon, task) · claim = a worker's ownership of an item/paths";

function line(entry) {
  const who = entry.holder
    ? entry.holder.pid !== undefined
      ? `pid ${entry.holder.pid}${entry.holder.host ? ` on ${entry.holder.host}` : ""}${entry.holder.command ? ` (${[entry.holder.command, entry.holder.activity].filter(Boolean).join(", ")})` : entry.holder.activity ? ` (${entry.holder.activity})` : ""}`
      : entry.holder.worker !== undefined
        ? `worker ${entry.holder.worker}${entry.holder.assignmentId ? `, assignment ${entry.holder.assignmentId}` : ""}${entry.holder.jobId ? `, job ${entry.holder.jobId}` : ""}${entry.holder.jobEpoch ? `, job epoch ${entry.holder.jobEpoch}` : ""}`
        : [entry.holder.actor, entry.holder.leadEpoch ? `lead epoch ${entry.holder.leadEpoch}` : null, entry.holder.supervisorEpoch ? `supervisor epoch ${entry.holder.supervisorEpoch}` : null].filter(Boolean).join(", ")
    : "-";
  const rows = [`${entry.state.toUpperCase().padEnd(7)} ${entry.kind} ${entry.scope}  [${entry.category}]`, `  holder:  ${who}`];
  if (entry.heartbeatAt || entry.expiresAt) rows.push(`  timing:  ${entry.heartbeatAt ? `heartbeat ${entry.heartbeatAt}` : ""}${entry.heartbeatAt && entry.expiresAt ? ", " : ""}${entry.expiresAt ? `expires ${entry.expiresAt}` : ""}`);
  if (entry.reason && entry.state !== "live") rows.push(`  why:     ${entry.reason}`);
  rows.push(`  blocks:  ${entry.blocks}`);
  if (entry.remedy) rows.push(`  fix:     ${entry.remedy}`);
  if (entry.path) rows.push(`  file:    ${entry.path}`);
  return rows.join("\n");
}

/** Human-readable report. */
export function formatLeases(report) {
  const out = [`Loop leases, locks and claims${report.taskId ? ` for ${report.taskId}` : ""} (${report.root})`, VOCABULARY, ""];
  if (report.cleared.length) out.push(`Cleared ${report.cleared.length} stale file(s):`, ...report.cleared.map((path) => `  - ${path}`), "");
  if (!report.entries.length) out.push("No local holders: nothing is locked.");
  else out.push(...report.entries.map(line).join("\n\n").split("\n"));
  if (report.fleet) {
    out.push("", `Fleet (coordination service${report.fleet.revision !== null ? `, revision ${report.fleet.revision}` : ""}):`);
    if (report.fleet.error) out.push(`  unavailable: ${report.fleet.error}`);
    else if (!report.fleet.entries.length) out.push("  No fleet leases or claims.");
    else out.push(...report.fleet.entries.map(line).join("\n\n").split("\n").map((row) => `  ${row}`));
  }
  const clearable = report.entries.filter((entry) => entry.clearable).length;
  if (clearable && !report.cleared.length) out.push("", `${clearable} stale entr${clearable === 1 ? "y" : "ies"} can be removed with: ${CLEAR_STALE_COMMAND}`);
  return out.join("\n");
}

