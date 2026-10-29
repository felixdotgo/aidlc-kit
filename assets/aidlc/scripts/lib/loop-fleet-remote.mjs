import { randomUUID } from "node:crypto";

const idempotency = () => randomUUID();

/** Map the coordination service's versioned MCP tools to the headless runner. */
export function createFleetRemoteRepository({ callTool, url, token, workspace, root, workerId }) {
  if (typeof callTool !== "function" || !url || !token || !workspace || !root) throw new Error("Fleet remote requires MCP callTool, URL, token, workspace, and project root");
  const call = (name, args) => callTool({ url, token, name, args: { workspace, ...args } });
  let ownerToken;
  let supervisorToken, supervisorEpoch, supervisorTask;
  const fleet = () => call("fleet_get", {});
  const owner = () => { if (!ownerToken) throw new Error("Lead owner token unavailable"); return ownerToken; };
  const mutation = async (name, args, key, retryRevision = false) => {
    const mutationKey = key ?? idempotency();
    for (let attempt = 0; attempt < (retryRevision ? 3 : 1); attempt++) {
      const current = await fleet();
      try { return await call(name, { expectedRevision: current.revision, idempotencyKey: mutationKey, ...args }); }
      catch (error) { if (!retryRevision || error?.code !== "FLEET_CONFLICT" || attempt === 2) throw error; }
    }
  };
  const normalizeJob = (job) => job && ({ ...job, assignmentId: job.id, expiresAt: job.expiresAt });
  return {
    leadOwnerToken: owner,
    claimSupervisor: async ({ taskId, leaseMs, idempotencyKey }) => {
      if (supervisorToken) throw new Error("Supervisor already claimed by this adapter");
      const token = randomUUID() + randomUUID();
      const value = await mutation("supervisor_claim", { taskId, leaseMs, ownerToken: token }, idempotencyKey);
      const claim = value.fleet.supervisors[taskId];
      if (!Number.isSafeInteger(claim?.epoch)) throw new Error("Supervisor claim lacks epoch");
      supervisorToken = token; supervisorEpoch = claim.epoch; supervisorTask = taskId;
      return claim;
    },
    renewSupervisor: async ({ taskId, leaseMs }) => {
      if (taskId !== supervisorTask || !supervisorToken) throw new Error("Supervisor ownership unavailable");
      return mutation("supervisor_heartbeat", { taskId, epoch: supervisorEpoch, leaseMs, ownerToken: supervisorToken }, undefined, true);
    },
    releaseSupervisor: async ({ taskId }) => {
      if (taskId !== supervisorTask || !supervisorToken) throw new Error("Supervisor ownership unavailable");
      const result = await mutation("supervisor_release", { taskId, epoch: supervisorEpoch, ownerToken: supervisorToken });
      supervisorToken = undefined; supervisorEpoch = undefined; supervisorTask = undefined;
      return result;
    },
    readGateCheckpoint: async ({ taskId }) => call("gate_checkpoint_get", { taskId }),
    getFeature: async ({ featureId }) => (await fleet()).fleet.features[featureId] ?? null,
    featureReady: async ({ featureId }) => call("feature_ready", { featureId }),
    listAllJobs: async () => Object.values((await fleet()).fleet.jobs).map(normalizeJob),
    readTask: async ({ taskId }) => {
      const value = await call("task_get", { taskId, clientProjectRoot: root });
      return { task: value.task, nextAction: value.nextAction, revision: value.revision };
    },
    claimLead: async ({ taskId, leaseMs, idempotencyKey, expectedStateRevision, expectedTaskDigest, checkpoint }) => {
      ownerToken = randomUUID() + randomUUID();
      if (supervisorToken && supervisorTask !== taskId) throw new Error("Supervisor task mismatch");
      const binding = supervisorToken ? { supervisorEpoch, supervisorOwnerToken: supervisorToken, expectedStateRevision, expectedTaskDigest, ...(checkpoint?.status === "approved" ? { checkpointSnapshotId: checkpoint.snapshotId, checkpointApprovalRevision: checkpoint.approvalRevision } : {}) } : {};
      const value = await mutation("run_claim", { taskId, leaseMs, ownerToken, ...binding }, idempotencyKey);
      return value.fleet.leads[taskId];
    },
    renewLead: async ({ taskId, epoch, leaseMs }) => mutation("run_heartbeat", { taskId, epoch, leaseMs, ownerToken: owner() }, undefined, true),
    releaseLead: async ({ taskId, epoch }) => mutation("run_release", { taskId, epoch, ownerToken: owner() }),
    listJobs: async ({ taskId }) => Object.values((await fleet()).fleet.jobs).filter((job) => job.taskId === taskId).map(normalizeJob),
    scheduleJob: async ({ taskId, itemId, workerId: assignedWorker, leadEpoch, baseCommit, branch, ownedPaths, agent, idempotencyKey }) => {
      const before = await fleet();
      const prior = Object.values(before.fleet.jobs).filter((job) => job.taskId === taskId && job.itemId === itemId);
      const attempt = Math.max(0, ...prior.map((job) => job.attempt)) + 1;
      const jobId = randomUUID();
      const value = await call("job_schedule", { expectedRevision: before.revision, idempotencyKey, jobId, taskId, itemId, workerId: assignedWorker, attempt, leadEpoch, ownerToken: owner(), baseCommit, branch, ownedPaths, agent });
      return normalizeJob(value.fleet.jobs[jobId]);
    },
    claimJob: async ({ workerId: claimingWorker, leaseMs, idempotencyKey }) => {
      if (workerId && workerId !== claimingWorker) throw new Error("Worker identity does not match configured credential");
      const before = await fleet();
      const ready = Object.values(before.fleet.jobs).find((job) => job.workerId === claimingWorker && job.state === "ready");
      if (!ready) return null;
      const value = await call("job_claim", { expectedRevision: before.revision, idempotencyKey, jobId: ready.id, leaseMs });
      return normalizeJob(value.fleet.jobs[ready.id]);
    },
    renewJob: async ({ assignmentId, epoch, leaseMs }) => mutation("job_heartbeat", { jobId: assignmentId, epoch, leaseMs }, undefined, true),
    checkpointJob: async ({ assignmentId, epoch, sessionId, checkpoint }) => mutation("job_checkpoint", { jobId: assignmentId, epoch, sessionId, checkpoint: JSON.stringify(checkpoint) }, undefined, true),
    reportJob: async ({ assignmentId, epoch, report, idempotencyKey }) => report.status === "reported"
      ? mutation("job_report", { jobId: assignmentId, epoch, commitSha: report.commitSha, changedPaths: report.changedPaths, summary: report.summary ?? "" }, idempotencyKey)
      : mutation("job_abandon", { jobId: assignmentId, epoch, reason: String(report.reason ?? report.status).slice(0, 2000) }, idempotencyKey),
    reconcileJob: async ({ assignmentId, leadEpoch, decision, idempotencyKey }) => mutation("job_reconcile", { jobId: assignmentId, leadEpoch, ownerToken: owner(), state: decision }, idempotencyKey),
    recoverJob: async ({ assignmentId, leadEpoch, commitSha, changedPaths, idempotencyKey }) => mutation("job_recover", { jobId: assignmentId, leadEpoch, ownerToken: owner(), commitSha, changedPaths }, idempotencyKey),
    saveGateSnapshot: async ({ taskId, leadEpoch, expectedRevision, gate, gateView, integrationCommit, idempotencyKey }) => {
      const value = await call("gate_snapshot_put", { taskId, leadEpoch, leadOwnerToken: owner(), checkpoint: true, expectedRevision, gate, reviewText: gateView, ...(integrationCommit ? { integrationCommit } : {}), idempotencyKey });
      return { snapshotId: value.id };
    },
    completeItem: async ({ taskId, itemId, job, integrated, snapshot, leadEpoch }) => {
      const task = structuredClone(snapshot.task);
      const item = task.tasks?.find((entry) => entry.id === itemId);
      if (!item) throw new Error(`Unknown canonical item ${itemId}`);
      if (item.status === "done") return { alreadyDone: true };
      if (!integrated?.integrationCommit || !integrated?.commitSha) throw new Error("Missing verified integration commit");
      item.status = "done";
      task.evidence.push({ kind: "diagnostic", result: "pass", source: `Git integration ${integrated.integrationCommit} for ${job.assignmentId}; worker commit ${integrated.commitSha}`, recordedAt: new Date().toISOString() });
      task.updatedAt = new Date().toISOString();
      return call("state_apply", { expectedRevision: snapshot.revision, idempotencyKey: `item-${job.assignmentId}`, clientProjectRoot: root, leadEpoch, leadOwnerToken: owner(), command: { type: "upsertTask", taskId, task } });
    }
  };
}
