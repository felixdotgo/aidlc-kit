import { createHash, randomUUID } from "node:crypto";
import { readyTaskItems, formatGateView } from "./store.mjs";

export const FLEET_LIMITS = Object.freeze({ maxTurns: 12, turnTimeoutMs: 600_000, maxStallTurns: 2, maxWorkers: 4, leaseMs: 300_000, heartbeatMs: 60_000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const integer = (value, name, max) => { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be an integer from 1 to ${max}`); return value; };
const required = (object, method) => { if (typeof object?.[method] !== "function") throw new Error(`Fleet adapter requires ${method}()`); return object[method].bind(object); };
const assertId = (value, label) => { if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${label}`); return value; };
const actionKind = (action) => { if (!["run_phase", "dispatch", "await_user", "reconcile", "blocked", "terminal", "complete"].includes(action?.classification)) throw new Error(`Invalid canonical nextAction: ${action?.classification}`); return action.classification; };

export function validateFleetLimits(input = {}) {
  const value = { ...FLEET_LIMITS, ...input };
  integer(value.maxTurns, "maxTurns", 1000);
  integer(value.turnTimeoutMs, "turnTimeoutMs", 3_600_000);
  integer(value.maxStallTurns, "maxStallTurns", 20);
  integer(value.maxWorkers, "maxWorkers", 100);
  integer(value.leaseMs, "leaseMs", 3_600_000);
  integer(value.heartbeatMs, "heartbeatMs", 600_000);
  if (value.heartbeatMs * 2 >= value.leaseMs) throw new Error("heartbeatMs must be less than half the leaseMs");
  return value;
}

function validateSnapshot(snapshot, taskId) {
  if (!snapshot || snapshot.task?.id !== taskId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error(`Invalid remote task snapshot for ${taskId}`);
  actionKind(snapshot.nextAction);
  return snapshot;
}

function readyItems(task) {
  const items = Array.isArray(task.tasks) ? task.tasks : [];
  const ready = new Set(readyTaskItems(task).ready);
  return items.filter((item) => item.status === "todo" && ready.has(item.id));
}
const overlaps = (left, right) => left === right || (left.endsWith("/") && right.startsWith(left)) || (right.endsWith("/") && left.startsWith(right));
const pathsOverlap = (left = [], right = []) => left.some((a) => right.some((b) => overlaps(a, b)));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function key(...parts) { return digest(parts); }

export async function reconcileFleetJobs({ repository, taskId, leadEpoch, snapshot, handoff, now = Date.now(), allowCodeOnlyRetry = false, quiesceMs = 0 }) {
  const jobs = await required(repository, "listJobs")({ taskId });
  if (!Array.isArray(jobs)) throw new Error("Invalid job list");
  const pending = [];
  for (const job of jobs) {
    if (job.taskId !== taskId || !job.assignmentId || !job.itemId) throw new Error("Invalid assignment in job list");
    const item = snapshot.task.tasks?.find((candidate) => candidate.id === job.itemId);
    if (item?.status === "done") {
      if (["reported", "uncertain"].includes(job.state)) {
        const result = job.state === "reported" ? await required(handoff, "verify")({ job, snapshot }) : await required(handoff, "recover")({ job, snapshot });
        if (!result?.valid || !result.alreadyIntegrated) pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: result?.reason ?? "Canonical item done but reported commit is not integrated" });
        else {
          if (job.state === "uncertain") await required(repository, "recoverJob")({ assignmentId: job.assignmentId, leadEpoch, commitSha: result.report.commitSha, changedPaths: result.report.changedPaths, idempotencyKey: key("recover", job.assignmentId, leadEpoch, result.commitSha) });
          await required(repository, "reconcileJob")({ assignmentId: job.assignmentId, leadEpoch, decision: "integrated", idempotencyKey: key("integrated", job.assignmentId, leadEpoch, result.commitSha) });
        }
      }
      continue;
    }
    if (job.state === "leased" && Date.parse(job.expiresAt) <= now) {
      const reconcileJob = required(repository, "reconcileJob");
      const updated = await reconcileJob({ assignmentId: job.assignmentId, leadEpoch, decision: "uncertain", reason: "worker lease expired", idempotencyKey: key("expire", job.assignmentId, leadEpoch, job.attempt, job.epoch) });
      job.state = "uncertain";
      job.uncertainAt = updated?.fleet?.jobs?.[job.assignmentId]?.uncertainAt ?? new Date(now).toISOString();
    }
    if (job.state === "uncertain") {
      if (typeof handoff?.recover === "function") {
        const recovered = await handoff.recover({ job, snapshot });
        if (recovered?.recovered) {
          await required(repository, "recoverJob")({ assignmentId: job.assignmentId, leadEpoch, commitSha: recovered.report.commitSha, changedPaths: recovered.report.changedPaths, idempotencyKey: key("recover", job.assignmentId, leadEpoch, recovered.report.commitSha) });
          job.report = recovered.report;
          job.state = "reported";
          pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: "recovered pushed branch after lost report", artifact: { valid: true, ...recovered } });
        } else if (allowCodeOnlyRetry && recovered?.retryable === true && Number.isFinite(Date.parse(job.uncertainAt))) {
          const waitUntil = Date.parse(job.uncertainAt) + quiesceMs;
          if (now < waitUntil) pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: "waiting for stale worker turn to quiesce", waitUntil });
          else {
            await required(repository, "reconcileJob")({ assignmentId: job.assignmentId, leadEpoch, decision: "ready", idempotencyKey: randomUUID() });
            job.state = "ready";
          }
        } else pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: recovered?.reason ?? "uncertain assignment; inspect Git branch before retry" });
      } else pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: "uncertain assignment; inspect Git branch before retry" });
    } else if (job.state === "reported") {
      if (typeof handoff?.verify !== "function") throw new Error("Reported job requires Git handoff verify adapter");
      const result = await handoff.verify({ job, snapshot });
      if (!result?.valid) pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: result?.reason ?? "Git artifact verification failed" });
      else pending.push({ assignmentId: job.assignmentId, itemId: job.itemId, reason: "verified report awaits lead integration", artifact: result });
    }
  }
  return { jobs, pending };
}

async function withHeartbeat(renew, intervalMs, work) {
  const abort = new AbortController();
  let failure;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending.then(() => renew()).catch((error) => { failure = error; abort.abort(error); });
  }, intervalMs);
  timer.unref?.();
  try {
    const result = await work(abort.signal);
    await pending;
    if (failure) throw new Error(`Fleet lease renewal failed: ${failure.message}`);
    return result;
  } finally { clearInterval(timer); await pending; }
}

/**
 * One fenced coordinator invocation. The repository is the remote authority;
 * no local lifecycle file or PID lease is consulted in fleet mode.
 */
export async function runFleetCoordinator({ repository, taskId, ownerId = randomUUID(), workerIds = [], reservedJobs = [], allowCodeOnlyRetry = false, limits: inputLimits, pollMs = 5000, pickupTimeoutMs: inputPickupTimeout, packet, driver, gateView, handoff, completeItem, onEvent = () => {} }) {
  assertId(taskId, "task ID"); assertId(ownerId, "owner ID");
  if (!Array.isArray(workerIds) || new Set(workerIds).size !== workerIds.length) throw new Error("workerIds must be distinct IDs");
  for (const workerId of workerIds) assertId(workerId, "worker ID");
  const limits = validateFleetLimits(inputLimits);
  integer(pollMs, "pollMs", 300000);
  const pickupTimeoutMs = integer(inputPickupTimeout ?? limits.leaseMs, "pickupTimeoutMs", 3_600_000);
  const readTask = required(repository, "readTask");
  const claimLead = required(repository, "claimLead");
  const renewLead = required(repository, "renewLead");
  const releaseLead = required(repository, "releaseLead");
  const listJobs = required(repository, "listJobs");
  const scheduleJob = required(repository, "scheduleJob");
  const saveGateSnapshot = required(repository, "saveGateSnapshot");
  let snapshot = validateSnapshot(await readTask({ taskId }), taskId);
  const claim = await claimLead({ taskId, ownerId, leaseMs: limits.leaseMs, expectedRevision: snapshot.revision, idempotencyKey: randomUUID() });
  if (!Number.isSafeInteger(claim?.epoch) || claim.epoch < 1) throw new Error("Lead claim lacks a fencing epoch");
  const epoch = claim.epoch;
  let turns = 0, stalls = 0, lastSignal = null;
  const startedAt = Date.now();
  const readySeen = new Map();
  try {
    return await withHeartbeat(() => renewLead({ taskId, ownerId, epoch, leaseMs: limits.leaseMs }), limits.heartbeatMs, async (signal) => {
      for (;;) {
        if (signal.aborted) throw new Error("Lead lease renewal failed");
        if (Date.now() - startedAt >= limits.maxTurns * limits.turnTimeoutMs) return { status: "paused", taskId, reason: "coordinator wall-time limit reached" };
        snapshot = validateSnapshot(await readTask({ taskId }), taskId);
        const kind = actionKind(snapshot.nextAction);
        if (kind === "await_user") {
          const reconciled = await reconcileFleetJobs({ repository, taskId, leadEpoch: epoch, snapshot, handoff, allowCodeOnlyRetry, quiesceMs: limits.turnTimeoutMs + limits.heartbeatMs + 1000 });
          if (reconciled.pending.length && reconciled.pending.every((entry) => entry.waitUntil)) { await wait(pollMs); continue; }
          if (reconciled.pending.length) return { status: "reconcile", taskId, revision: snapshot.revision, pending: reconciled.pending };
          const gate = snapshot.nextAction.gate;
          const baseReview = await (gateView ?? ((value) => formatGateView(value.task, [], "markdown")))(snapshot);
          if (typeof baseReview !== "string" || !baseReview.trim()) throw new Error("Empty gate review snapshot");
          const integrationCommit = gate === "G2_codereview" ? await required(handoff, "currentCommit")() : undefined;
          const review = integrationCommit ? `${baseReview.trimEnd()}\n\nIntegration commit: ${integrationCommit}\n` : baseReview;
          const saved = await saveGateSnapshot({ taskId, leadEpoch: epoch, expectedRevision: snapshot.revision, gate, gateView: review, integrationCommit, idempotencyKey: key("gate", taskId, snapshot.revision, gate, integrationCommit ?? "") });
          onEvent({ type: "gate", taskId, gate, snapshotId: saved.snapshotId });
          return { status: "gate", taskId, gate, snapshotId: saved.snapshotId, revision: snapshot.revision, gateView: review };
        }
        if (["blocked", "terminal", "complete"].includes(kind)) return { status: kind, taskId, revision: snapshot.revision, nextAction: snapshot.nextAction };
        if (turns >= limits.maxTurns) return { status: "paused", taskId, reason: "turn limit reached", revision: snapshot.revision };
        const before = digest({ revision: snapshot.revision, action: snapshot.nextAction });
        if (kind === "dispatch" || (kind === "run_phase" && snapshot.task.phase === "build")) {
          const reconciled = await reconcileFleetJobs({ repository, taskId, leadEpoch: epoch, snapshot, handoff, allowCodeOnlyRetry, quiesceMs: limits.turnTimeoutMs + limits.heartbeatMs + 1000 });
          if (reconciled.pending.length && reconciled.pending.every((entry) => entry.waitUntil)) { await wait(pollMs); continue; }
          if (reconciled.pending.length) {
            const verified = reconciled.pending.filter((entry) => entry.artifact?.valid);
            if (verified.length && typeof handoff?.integrate === "function" && typeof completeItem === "function") {
              for (const entry of verified) {
                const job = reconciled.jobs.find((candidate) => candidate.assignmentId === entry.assignmentId);
                const integrated = await handoff.integrate({ job, artifact: entry.artifact });
                const fresh = validateSnapshot(await readTask({ taskId }), taskId);
                await completeItem({ taskId, itemId: job.itemId, job, integrated, snapshot: fresh, leadEpoch: epoch });
                const committed = validateSnapshot(await readTask({ taskId }), taskId);
                if (committed.task.tasks?.find((item) => item.id === job.itemId)?.status !== "done") throw new Error(`Canonical item ${job.itemId} was not completed after integration`);
                await required(repository, "reconcileJob")({ assignmentId: job.assignmentId, leadEpoch: epoch, decision: "integrated", idempotencyKey: key("integrated", job.assignmentId, epoch, integrated.integrationCommit) });
                onEvent({ type: "job_integrated", taskId, itemId: job.itemId, assignmentId: job.assignmentId, commitSha: integrated.integrationCommit });
              }
              continue;
            }
            return { status: "reconcile", taskId, revision: snapshot.revision, pending: reconciled.pending };
          }
          const jobs = reconciled.jobs;
          const active = jobs.filter((job) => ["ready", "leased", "reported", "uncertain"].includes(job.state));
          const pathClaims = [...active, ...reservedJobs].filter((job) => ["ready", "leased", "reported", "uncertain"].includes(job.state));
          const reserved = new Set(active.map((job) => job.itemId));
          const load = new Map(workerIds.map((id) => [id, active.filter((job) => job.workerId === id).length]));
          for (const item of readyItems(snapshot.task)) {
            if (active.length >= limits.maxWorkers) break;
            if (reserved.has(item.id)) continue;
            if (!workerIds.length) throw new Error("Fleet dispatch requires at least one configured worker ID");
            if (typeof handoff?.prepare !== "function") throw new Error("Fleet dispatch requires Git handoff prepare adapter");
            const artifact = await handoff.prepare({ taskId, item, snapshot });
            if (pathClaims.some((job) => pathsOverlap(artifact.ownedPaths, job.ownedPaths))) continue;
            const workerId = [...load].sort((a, b) => a[1] - b[1])[0][0];
            const job = await scheduleJob({ taskId, itemId: item.id, workerId, leadEpoch: epoch, expectedRevision: snapshot.revision, baseCommit: artifact.baseCommit, branch: artifact.branch, ownedPaths: artifact.ownedPaths, agent: artifact.agent, idempotencyKey: randomUUID() });
            active.push(job); reserved.add(item.id);
            pathClaims.push({ ...job, ownedPaths: artifact.ownedPaths, state: "ready" });
            load.set(workerId, load.get(workerId) + 1);
            onEvent({ type: "job_scheduled", taskId, itemId: item.id, assignmentId: job.assignmentId });
          }
          if (active.length) {
            for (const job of active) {
              if (job.state !== "ready") { readySeen.delete(job.assignmentId); continue; }
              if (!readySeen.has(job.assignmentId)) readySeen.set(job.assignmentId, Date.now());
              if (Date.now() - readySeen.get(job.assignmentId) >= pickupTimeoutMs) {
                await required(repository, "reconcileJob")({ assignmentId: job.assignmentId, leadEpoch: epoch, decision: "uncertain", idempotencyKey: randomUUID() });
                return { status: "blocked", taskId, reason: `Worker did not claim assignment ${job.assignmentId} within ${pickupTimeoutMs} ms` };
              }
            }
            onEvent({ type: "jobs_active", taskId, assignments: active.map((job) => job.assignmentId) });
            await wait(pollMs);
            continue;
          }
        }
        if (kind === "reconcile") return { status: "reconcile", taskId, revision: snapshot.revision, nextAction: snapshot.nextAction };
        if (typeof packet !== "function" || typeof driver !== "function") throw new Error("Fleet lead requires packet and driver adapters");
        const prompt = await packet(snapshot, epoch);
        if (typeof prompt !== "string" || !prompt) throw new Error("Empty fleet lead packet");
        await driver({ taskId, snapshot, leadEpoch: epoch, prompt, timeoutMs: limits.turnTimeoutMs, signal });
        turns++;
        const after = validateSnapshot(await readTask({ taskId }), taskId);
        const nextSignal = digest({ revision: after.revision, action: after.nextAction });
        stalls = nextSignal === before || nextSignal === lastSignal ? stalls + 1 : 0;
        lastSignal = nextSignal;
        if (stalls >= limits.maxStallTurns) return { status: "paused", taskId, reason: `${stalls} lead turns without canonical progress`, revision: after.revision };
      }
    });
  } finally {
    await releaseLead({ taskId, ownerId, epoch }).catch((error) => onEvent({ type: "release_failed", taskId, message: error.message }));
  }
}

/** A worker claims one attempt, persists its exact CLI session, and reports a Git artifact. */
export async function runFleetWorker({ repository, workerId = randomUUID(), limits: inputLimits, driver, packet, handoff, onEvent = () => {} }) {
  assertId(workerId, "worker ID");
  const limits = validateFleetLimits(inputLimits);
  const claimJob = required(repository, "claimJob");
  const renewJob = required(repository, "renewJob");
  const checkpointJob = required(repository, "checkpointJob");
  const reportJob = required(repository, "reportJob");
  const readTask = required(repository, "readTask");
  const job = await claimJob({ workerId, leaseMs: limits.leaseMs, idempotencyKey: key("worker-claim", workerId, randomUUID()) });
  if (!job) return { status: "idle" };
  assertId(job.taskId, "job task ID"); assertId(job.itemId, "job item ID");
  if (!Number.isSafeInteger(job.epoch) || job.epoch < 1 || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || !job.assignmentId) throw new Error("Job claim lacks a fenced attempt");
  const identity = { assignmentId: job.assignmentId, attempt: job.attempt, epoch: job.epoch, workerId };
  let sessionId = job.sessionId ?? null;
  let turns = 0, stalls = 0;
  const report = async (outcome) => reportJob({ ...identity, report: outcome, idempotencyKey: key("job-report", job.assignmentId, job.attempt, job.epoch, outcome.status, outcome.commitSha ?? "") });
  return withHeartbeat(() => renewJob({ ...identity, leaseMs: limits.leaseMs }), limits.heartbeatMs, async (signal) => {
    if (typeof driver !== "function" || typeof packet !== "function" || typeof handoff?.prepare !== "function" || typeof handoff?.observe !== "function" || typeof handoff?.finish !== "function") throw new Error("Worker requires driver, packet, and Git handoff adapters");
    const workspace = await handoff.prepare(job);
    if (!workspace?.root) throw new Error("Git handoff did not supply a worker root");
    let lastObservation = null;
    for (;;) {
      if (signal.aborted) throw new Error("Job lease renewal failed");
      const snapshot = validateSnapshot(await readTask({ taskId: job.taskId }), job.taskId);
      const item = snapshot.task.tasks?.find((candidate) => candidate.id === job.itemId);
      if (!item || item.status === "done") {
        await report({ status: "superseded", reason: "Item absent or canonically done" });
        return { status: "superseded", assignmentId: job.assignmentId };
      }
      const kind = actionKind(snapshot.nextAction);
      if (kind === "await_user" || kind === "blocked" || kind === "terminal") {
        await report({ status: "paused", reason: `Canonical action: ${kind}` });
        return { status: "paused", assignmentId: job.assignmentId };
      }
      if (turns >= limits.maxTurns) {
        await report({ status: "uncertain", reason: "turn limit reached", sessionId });
        return { status: "uncertain", assignmentId: job.assignmentId };
      }
      const prompt = await packet({ job, snapshot, workspace, turns });
      if (typeof prompt !== "string" || !prompt) throw new Error("Empty worker packet");
      const result = await driver({ agent: job.agent, root: workspace.root, sessionId: sessionId ?? undefined, prompt: `${prompt}\n\nWorker scope: modify only assigned paths. Do not mutate AI-DLC lifecycle state or approve any gate. When the scoped implementation is ready for commit, end the final answer with AI-DLC-ITEM-COMPLETE on its own line.`, timeoutMs: limits.turnTimeoutMs, signal, onSessionId: async (id) => {
        if (typeof id !== "string" || !id) throw new Error("Invalid worker session ID");
        await checkpointJob({ ...identity, sessionId: id, checkpoint: { turns, capturedAt: new Date().toISOString() } });
        sessionId = id;
      }, onEvent });
      if (result?.sessionId && !sessionId) {
        await checkpointJob({ ...identity, sessionId: result.sessionId, checkpoint: { turns, capturedAt: new Date().toISOString() } });
        sessionId = result.sessionId;
      }
      turns++;
      const observed = await handoff.observe({ job, workspace, result, turns });
      if (observed?.done) {
        const artifact = await handoff.finish({ job, workspace, result });
        if (!artifact?.commitSha || !Array.isArray(artifact.changedPaths)) throw new Error("Invalid Git handoff artifact");
        await report({ status: "reported", commitSha: artifact.commitSha, changedPaths: artifact.changedPaths, sessionId });
        return { status: "reported", assignmentId: job.assignmentId, commitSha: artifact.commitSha };
      }
      const currentObservation = digest({ revision: snapshot.revision, artifact: observed?.fingerprint ?? null });
      stalls = currentObservation === lastObservation ? stalls + 1 : 0;
      lastObservation = currentObservation;
      if (stalls >= limits.maxStallTurns) {
        await report({ status: "uncertain", reason: `${stalls} worker turns without observable progress`, sessionId });
        return { status: "uncertain", assignmentId: job.assignmentId };
      }
    }
  });
}
