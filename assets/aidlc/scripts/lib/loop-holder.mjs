// One holder-file primitive for every local loop lease and lock.
//
// Vocabulary (shown to users):
//   lock  — short mutex held only while a file is read-modified-written.
//   lease — process ownership (the loop daemon, a task's loop run).
//   claim — a worker's ownership of an item/paths (local assignment, fleet job).
//
// A holder file is JSON v2:
//   {schemaVersion:2, kind:"lease"|"lock", scope, pid, host, command, purpose,
//    activity, token, startedAt, heartbeatAt, expiresAt}
// It is live when expiresAt is in the future AND, on the same host, its pid is
// alive. A holder on another host is judged by TTL only. v1 files (written by
// older versions) are still read; their liveness is the old pid probe.
// Reclaims, heartbeats, and releases are serialized by `<path>.guard`.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";

export const LEASE_TTL_MS = 60000;
export const LEASE_HEARTBEAT_MS = 15000;
export const LOCK_TTL_MS = 30000;
export const GUARD_STALE_MS = 10000;
export const GUARD_WAIT_MS = 5000;
export const LEASES_COMMAND = "node .agents/aidlc/scripts/loop-entry.mjs leases";
export const CLEAR_STALE_COMMAND = `${LEASES_COMMAND} --clear-stale`;

const KINDS = new Set(["lease", "lock"]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const iso = (ms) => new Date(ms).toISOString();
const isIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const ignoreMissing = (action) => { try { return action(); } catch (error) { if (error?.code !== "ENOENT") throw error; return undefined; } };

export const currentHost = () => hostname();

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

export function formatAge(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function defaultCommand() {
  const script = process.argv[1] ? basename(process.argv[1]) : "node";
  return [script, ...process.argv.slice(2, 4)].join(" ").slice(0, 120);
}

/** Error raised by acquire when a holder blocks the caller. `code` is
 * HOLDER_BUSY (live holder) or HOLDER_CORRUPT (unreadable, recent file). */
export class HolderError extends Error {
  constructor(message, code, entry) { super(message); this.name = "HolderError"; this.code = code; this.entry = entry; }
}

function validV2(value) {
  return value && value.schemaVersion === 2 && KINDS.has(value.kind) && typeof value.scope === "string" && value.scope
    && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.host === "string" && value.host
    && typeof value.token === "string" && value.token && isIso(value.startedAt) && isIso(value.heartbeatAt) && isIso(value.expiresAt)
    && (value.activity === null || value.activity === undefined || typeof value.activity === "string");
}

// Any older holder shape that carries a positive pid and a token (loop lease
// v1, supervisor lease, daemon lock v1, assignment lock). Liveness is pid-only.
function validV1(value) {
  return value && value.schemaVersion !== 2 && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string" && value.token;
}

/** Inspect a holder file without changing it.
 * Returns `{state: "absent"|"live"|"stale"|"corrupt", path, holder, version,
 * reason, ageMs, reclaimable}`. `reclaimable` is true for stale holders and for
 * corrupt files older than `ttlMs` (default: lease TTL). */
export function readHolder(path, { ttlMs = LEASE_TTL_MS, now = Date.now() } = {}) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if (error?.code === "ENOENT") return { state: "absent", path, holder: null, version: null, reason: "no holder file", ageMs: null, reclaimable: false }; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`Holder file is a symlink: ${path}`);
  const ageMs = now - stat.mtimeMs;
  let raw;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { state: "absent", path, holder: null, version: null, reason: "no holder file", ageMs: null, reclaimable: false }; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (validV2(value)) {
    const expired = Date.parse(value.expiresAt) <= now;
    const sameHost = value.host === currentHost();
    const dead = sameHost && !pidAlive(value.pid);
    const reason = expired ? `expired ${formatAge(now - Date.parse(value.expiresAt))} ago` : dead ? `pid ${value.pid} is not running` : "held";
    const state = expired || dead ? "stale" : "live";
    return { state, path, holder: value, version: 2, reason, ageMs, reclaimable: state === "stale" };
  }
  if (validV1(value)) {
    const live = pidAlive(value.pid);
    return { state: live ? "live" : "stale", path, holder: value, version: 1, reason: live ? "held (v1 file, pid probe only)" : `pid ${value.pid} is not running (v1 file)`, ageMs, reclaimable: !live };
  }
  return { state: "corrupt", path, holder: null, version: null, reason: raw.trim() ? "unreadable holder file" : "empty holder file", ageMs, reclaimable: ageMs > ttlMs };
}

/** Human explanation of a `readHolder` entry: `{ summary, remedy }`. */
export function explainHolder(entry) {
  const holder = entry?.holder;
  if (!entry || entry.state === "absent") return { summary: `No holder at ${entry?.path ?? "(unknown)"}`, remedy: null };
  if (entry.state === "corrupt") {
    return {
      summary: `Corrupt holder file ${entry.path} (modified ${formatAge(entry.ageMs)} ago)`,
      remedy: entry.reclaimable ? `It is older than its TTL: reclaimed automatically on the next acquire, or run: ${CLEAR_STALE_COMMAND}` : `It becomes reclaimable once older than its TTL; if no loop process is running, run: ${CLEAR_STALE_COMMAND} after that`,
    };
  }
  const kind = holder.kind ?? "holder";
  const scope = holder.scope ?? (holder.taskId ? `task:${holder.taskId}` : basename(entry.path));
  const where = holder.host ? ` on ${holder.host}` : "";
  const detail = [holder.command, holder.activity].filter(Boolean).join(", ");
  const since = holder.startedAt ?? holder.createdAt;
  const parts = [`${kind} ${scope} is held by pid ${holder.pid}${where}${detail ? ` (${detail})` : ""}`];
  if (since) parts.push(`since ${typeof since === "number" ? iso(since) : since}`);
  if (holder.expiresAt) parts.push(`expires ${holder.expiresAt}`);
  if (entry.state === "stale") {
    return { summary: `Stale ${parts.join(", ")} — ${entry.reason}`, remedy: `Reclaimed automatically on the next acquire, or run: ${CLEAR_STALE_COMMAND}` };
  }
  return { summary: parts.join(", "), remedy: `Inspect: ${LEASES_COMMAND}` };
}

/** One-line message for a holder that blocks the caller. */
export function describeHolder(entry) {
  const { summary, remedy } = explainHolder(entry);
  return remedy ? `${summary}. ${remedy}` : summary;
}

// ---------------------------------------------------------------- guard ----

/** Inspect a `<path>.guard` file: null when absent, else `{ live, token, ageMs }`. */
export function readGuard(path, now = Date.now()) { return guardLive(path, now); }

function guardLive(path, now) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const ageMs = now - stat.mtimeMs;
  let pid = null, token = null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isSafeInteger(value)) pid = value;
    else if (value && Number.isSafeInteger(value.pid)) { pid = value.pid; token = typeof value.token === "string" ? value.token : null; }
  } catch (error) { if (error?.code === "ENOENT") return null; }
  // A guard is live only while its pid runs and it is younger than 10s; an
  // unreadable guard is judged by age alone.
  const live = ageMs < GUARD_STALE_MS && (pid === null || pidAlive(pid));
  return { live, token, ageMs };
}

/** Run `action` while holding `<path>.guard`. Waits up to 5s for a live guard;
 * an abandoned guard (dead pid or older than 10s) is removed. */
export function withHolderGuard(path, action, { waitMs = GUARD_WAIT_MS } = {}) {
  const guard = `${path}.guard`;
  mkdirSync(dirname(guard), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(guard, "wx", 0o600);
      try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`); }
      finally { closeSync(fd); }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const observed = guardLive(guard, Date.now());
      if (!observed) continue;
      if (!observed.live) {
        const again = guardLive(guard, Date.now());
        if (again && !again.live && again.token === observed.token) ignoreMissing(() => unlinkSync(guard));
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for holder guard ${guard}; if no loop process is running, run: ${CLEAR_STALE_COMMAND}`);
      sleep(10);
    }
  }
  try { return action(); }
  finally {
    let current = null;
    try { current = JSON.parse(readFileSync(guard, "utf8")); } catch { current = null; }
    if (current?.token === token) ignoreMissing(() => unlinkSync(guard));
  }
}

// ---------------------------------------------------------------- write ----

// A complete, fsynced temp file next to `path`; removed again if writing fails.
function writeTemporary(path, value) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  catch (error) { closeSync(fd); ignoreMissing(() => unlinkSync(temporary)); throw error; }
  closeSync(fd);
  return temporary;
}

function createExclusive(path, value) {
  // Write a complete temp file, then hard-link it into place so readers never
  // observe a partial holder and an existing holder is never overwritten.
  const temporary = writeTemporary(path, value);
  try { linkSync(temporary, path); }
  catch (error) {
    if (error?.code === "EEXIST") throw error;
    // Filesystems without hard links: fall back to an exclusive create.
    const direct = openSync(path, "wx", 0o600);
    try { writeFileSync(direct, `${JSON.stringify(value)}\n`); fsyncSync(direct); } finally { closeSync(direct); }
  } finally { ignoreMissing(() => unlinkSync(temporary)); }
}

function replaceAtomic(path, value) {
  const temporary = writeTemporary(path, value);
  try { renameSync(temporary, path); }
  catch (error) { ignoreMissing(() => unlinkSync(temporary)); throw error; }
}

function readOwnToken(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return validV2(value) ? value : null;
  } catch { return null; }
}

/** Remove a stale or old-corrupt holder after re-reading it under the guard.
 * Never removes a live holder. Returns the removed entry or null. */
export function clearStaleHolder(path, { ttlMs = LEASE_TTL_MS } = {}) {
  return withHolderGuard(path, () => {
    const entry = readHolder(path, { ttlMs });
    if (!entry.reclaimable) return null;
    ignoreMissing(() => unlinkSync(path));
    return entry;
  });
}

/** Acquire a holder file.
 * Options: path, kind ("lease"|"lock"), scope, ttlMs, heartbeatMs (leases),
 * purpose, command, activity, waitMs (keep retrying a live holder), onWarning,
 * onLost(reason) (called once when a heartbeat finds the holder taken over or
 * removed), busyMessage(entry) to customize the HOLDER_BUSY error text.
 * Returns `{ token, path, holder(), heartbeat(), setActivity(a), assertOwned(),
 * release() }`. */
export function acquireHolder({
  path, kind, scope, ttlMs = kind === "lock" ? LOCK_TTL_MS : LEASE_TTL_MS,
  heartbeatMs = kind === "lease" ? LEASE_HEARTBEAT_MS : 0, purpose = "", command = defaultCommand(),
  activity = null, waitMs = 0, onWarning = () => {}, onLost = () => {}, busyMessage = null,
}) {
  if (!KINDS.has(kind)) throw new Error(`Invalid holder kind: ${kind}`);
  if (typeof scope !== "string" || !scope) throw new Error("Holder scope is required");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error("Holder ttlMs must be at least 1000");
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  let current = null;
  let lost = null;
  // The last requested activity. Every renewal writes it, so a setActivity
  // whose write failed (guard timeout) still converges on the next heartbeat.
  let desiredActivity = activity;
  let timer = null;
  const build = (patch = {}) => {
    const now = Date.now();
    return { schemaVersion: 2, kind, scope, pid: process.pid, host: currentHost(), command, purpose, activity, token, startedAt, ...current, ...patch, activity: desiredActivity, heartbeatAt: iso(now), expiresAt: iso(now + ttlMs) };
  };
  const deadline = Date.now() + waitMs;
  for (;;) {
    const outcome = withHolderGuard(path, () => {
      const entry = readHolder(path, { ttlMs });
      if (entry.state === "live") return { blocked: entry };
      if (entry.state === "corrupt" && !entry.reclaimable) {
        throw new HolderError(`Corrupt ${kind} file ${path} (modified ${formatAge(entry.ageMs)} ago); it is reclaimed automatically once older than ${formatAge(ttlMs)}. If no loop process is running, run: ${CLEAR_STALE_COMMAND} after that`, "HOLDER_CORRUPT", entry);
      }
      if (entry.state === "stale" && entry.version === 2 && entry.holder.scope !== scope) throw new Error(`Conflicting holder scope in ${path}: ${entry.holder.scope} (expected ${scope})`);
      if (entry.state !== "absent") {
        ignoreMissing(() => unlinkSync(path));
        onWarning({ type: "holder_reclaimed", path, previous: entry.holder, reason: entry.reason });
      }
      const value = build();
      createExclusive(path, value);
      return { value };
    });
    if (outcome.value) { current = outcome.value; break; }
    if (Date.now() >= deadline) {
      const message = busyMessage ? busyMessage(outcome.blocked) : describeHolder(outcome.blocked);
      throw new HolderError(message, "HOLDER_BUSY", outcome.blocked);
    }
    sleep(10);
  }

  const lose = (reason) => {
    const first = lost === null;
    lost ??= reason;
    if (timer) { clearInterval(timer); timer = null; }
    if (first && reason !== "released") { try { onLost(reason); } catch (error) { onWarning({ type: "holder_lost_callback_failed", path, error: error.message }); } }
  };
  const renew = (patch) => withHolderGuard(path, () => {
    const onDisk = readOwnToken(path);
    if (!onDisk || onDisk.token !== token || onDisk.pid !== process.pid) {
      const entry = readHolder(path, { ttlMs });
      lose(entry.state === "absent" ? `${kind} file ${path} was removed` : `${kind} ${scope} was taken over: ${describeHolder(entry)}`);
      return false;
    }
    const next = build(patch);
    replaceAtomic(path, next);
    current = next;
    return true;
  });
  const handle = {
    token,
    path,
    holder: () => current,
    heartbeat() {
      if (lost) return false;
      try { return renew(); }
      catch (error) { onWarning({ type: "holder_heartbeat_failed", path, error: error.message }); return false; }
    },
    setActivity(next) {
      handle.assertOwned();
      desiredActivity = next;
      if (!renew()) handle.assertOwned();
    },
    assertOwned() {
      if (lost) throw new Error(`${kind} ownership lost: ${lost}`);
      const onDisk = readOwnToken(path);
      if (!onDisk || onDisk.token !== token || onDisk.pid !== process.pid) {
        const entry = readHolder(path, { ttlMs });
        lose(entry.state === "absent" ? `${kind} file ${path} was removed` : `${kind} ${scope} was taken over: ${describeHolder(entry)}`);
        throw new Error(`${kind} ownership lost: ${lost}`);
      }
      // An expired holder can be reclaimed by anyone; renew under the guard
      // (which also re-checks the token) before allowing a mutation.
      if (Date.parse(onDisk.expiresAt) <= Date.now() && !renew()) throw new Error(`${kind} ownership lost: ${lost}`);
    },
    release() {
      if (timer) { clearInterval(timer); timer = null; }
      if (lost === "released") return;
      try {
        withHolderGuard(path, () => {
          if (readOwnToken(path)?.token === token) ignoreMissing(() => unlinkSync(path));
        });
      } finally { lost = "released"; }
    },
  };
  if (heartbeatMs > 0) {
    timer = setInterval(() => { handle.heartbeat(); }, heartbeatMs);
    timer.unref?.();
  }
  return handle;
}

// ---------------------------------------------------------------- fleet ----

const FLEET_EXPLANATIONS = [
  [/stale or expired lead claim/, "the lead lease (run_claim) is no longer valid: the `loop start` process on the lead machine stopped, lost its connection, or another lead took over; restart the loop on the lead machine"],
  [/stale or expired bound supervisor claim|stale or expired supervisor claim/, "the fleet supervisor lease expired or was taken over; only one `loop start` may supervise a task, restart it on one machine"],
  [/supervisor or prior lead claim is held/, "another `loop start` still holds the supervisor or lead lease for this task; stop it or wait for its lease to expire (5 minutes without heartbeat)"],
  [/lead claim is held/, "another lead holds the lead lease (run_claim) for this task; stop it or wait for its lease to expire (5 minutes without heartbeat)"],
  [/stale or expired job claim/, "this worker's job claim expired or was reassigned; its result is not accepted, the lead must reconcile the job"],
  [/expired job lease requires lead reconciliation|job requires lead reconciliation/, "the job claim expired before the worker reported; the lead must reconcile the job before it can be retried"],
  [/job lease is held/, "a worker still holds the job claim for this item; wait for it to report or for its claim to expire"],
  [/job lead lease is stale/, "the job was created under an older lead lease; the current lead must reconcile it"],
  [/item already has an active job/, "a job claim for this item is already active; reconcile it before creating another"],
];

/** Wrap a coordination-service FleetConflict message with an explanation and
 * an inspect command, keeping the original text in parentheses. Unknown
 * messages are returned unchanged. */
export function explainFleetConflict(message) {
  const text = String(message ?? "");
  if (text.includes(`Inspect: ${LEASES_COMMAND}`)) return text;
  for (const [pattern, explanation] of FLEET_EXPLANATIONS) {
    if (pattern.test(text)) return `Fleet conflict: ${explanation}. Inspect: ${LEASES_COMMAND} (${text})`;
  }
  return text;
}
