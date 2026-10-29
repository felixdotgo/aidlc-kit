import Database from "better-sqlite3";
import pg from "pg";
import { createHash } from "node:crypto";
import { nextAction } from "./lifecycle-core.mjs";

const now = () => Date.now();
const iso = (time) => new Date(time).toISOString();
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const branchName = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) && !value.includes("..") && !value.endsWith("/");
const copy = (value) => structuredClone(value);
const initial = () => ({ schemaVersion: 1, features: {}, leads: {}, supervisors: {}, jobs: {} });
const validLease = (value) => Number.isInteger(value) && value >= 60000 && value <= 3600000;

export class FleetConflict extends Error {
  constructor(message, current) { super(message); this.name = "FleetConflict"; this.current = current; }
}

export const validateFeature = (feature) => {
  if (!feature || !id(feature.id) || !Array.isArray(feature.tasks) || !feature.tasks.length || feature.tasks.length > 100 || !branchName(feature.integrationBranch)) throw new Error("invalid feature manifest");
  const tasks = new Map();
  for (const task of feature.tasks) {
    if (!id(task?.id) || tasks.has(task.id) || !Array.isArray(task.dependsOn) || task.dependsOn.some((dependency) => !id(dependency))) throw new Error("invalid or duplicate feature task");
    tasks.set(task.id, task);
  }
  const visiting = new Set(), visited = new Set();
  const visit = (taskId) => {
    if (!tasks.has(taskId)) throw new Error(`unknown feature dependency: ${taskId}`);
    if (visiting.has(taskId)) throw new Error("feature dependency cycle");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of tasks.get(taskId).dependsOn) visit(dependency);
    visiting.delete(taskId); visited.add(taskId);
  };
  for (const taskId of tasks.keys()) visit(taskId);
  return { schemaVersion: 1, id: feature.id, integrationBranch: feature.integrationBranch, tasks: feature.tasks.map((task) => ({ id: task.id, dependsOn: [...new Set(task.dependsOn)] })) };
};

export const featureReady = (feature, completedIds = []) => {
  const completed = new Set(completedIds);
  return feature.tasks.map((task) => ({ taskId: task.id, ready: !completed.has(task.id) && task.dependsOn.every((dependency) => completed.has(dependency)), blockers: task.dependsOn.filter((dependency) => !completed.has(dependency)) }));
};

export const validateCanonicalFeature = (feature, state) => {
  const manifest=validateFeature(feature);
  for(const member of manifest.tasks) {
    const task=state.tasks?.[member.id];
    if(!task) throw new Error(`feature task does not exist in canonical state: ${member.id}`);
    if(task.featureId && task.featureId!==manifest.id) throw new Error(`task belongs to another feature: ${member.id}`);
  }
  return manifest;
};

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const requireSupervisor = (state, taskId, actor, epoch, time, ownerToken) => {
  const supervisor = state.supervisors?.[taskId];
  if (!supervisor || supervisor.actor !== actor || supervisor.epoch !== epoch || Date.parse(supervisor.expiresAt) <= time || typeof ownerToken !== "string" || tokenHash(ownerToken) !== supervisor.ownerTokenHash) throw new FleetConflict("stale or expired supervisor claim");
  return supervisor;
};
const verifyBoundSupervisor = (state, lead, time) => {
  if (state.supervisors?.[lead.taskId]) {
    const supervisor = state.supervisors[lead.taskId];
    if (!lead.supervisorEpoch || supervisor.epoch !== lead.supervisorEpoch || supervisor.actor !== lead.actor || supervisor.ownerTokenHash !== lead.supervisorOwnerTokenHash || Date.parse(supervisor.expiresAt) <= time) throw new FleetConflict("stale or expired bound supervisor claim");
  }
};
const requireLead = (state, taskId, actor, epoch, time, ownerToken) => {
  const lead = state.leads[taskId];
  if (!lead || lead.actor !== actor || lead.epoch !== epoch || Date.parse(lead.expiresAt) <= time || (lead.ownerTokenHash && (typeof ownerToken !== "string" || tokenHash(ownerToken) !== lead.ownerTokenHash))) throw new FleetConflict("stale or expired lead claim");
  verifyBoundSupervisor(state, lead, time);
  return lead;
};
const requireJob = (state, jobId, actor, epoch, time) => {
  const job = state.jobs[jobId];
  if (!job || job.workerId !== actor || job.epoch !== epoch || job.state !== "leased" || Date.parse(job.expiresAt) <= time) throw new FleetConflict("stale or expired job claim");
  const lead = state.leads[job.taskId];
  if (state.supervisors?.[job.taskId] && (!lead || lead.epoch !== job.leadEpoch || Date.parse(lead.expiresAt) <= time)) throw new FleetConflict("job lead lease is stale");
  if (lead) verifyBoundSupervisor(state, lead, time);
  return job;
};
const validChangedPaths = (job, paths) => Array.isArray(paths) && paths.length <= 100 && paths.every((path) => typeof path === "string" && Boolean(path) && !path.startsWith("/") && !path.split("/").includes("..") && job.ownedPaths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`)));

export const applyFleetCommand = (before, command, actor, role, time = now()) => {
  const state = copy(before);
  const c = command ?? {};
  if (c.type === "feature_apply") {
    if (role !== "lead") throw new Error("lead credential required");
    const feature = validateFeature(c.feature);
    for (const existing of Object.values(state.features)) for (const member of existing.tasks) if (existing.id !== feature.id && feature.tasks.some((task) => task.id === member.id)) throw new Error(`task already belongs to feature ${existing.id}`);
    const old = state.features[feature.id];
    if (old && c.feature.revision !== old.revision) throw new FleetConflict("feature revision conflict");
    state.features[feature.id] = { ...feature, revision: (old?.revision ?? 0) + 1, updatedAt: iso(time) };
  } else if (c.type === "supervisor_claim") {
    if (role !== "lead" || !id(c.taskId) || !validLease(c.leaseMs) || typeof c.ownerToken !== "string" || c.ownerToken.length < 32 || c.ownerToken.length > 256) throw new Error("invalid supervisor claim");
    state.supervisors ??= {};
    const old = state.supervisors[c.taskId], lead = state.leads[c.taskId];
    if ((old && Date.parse(old.expiresAt) > time) || (lead && Date.parse(lead.expiresAt) > time)) throw new FleetConflict("supervisor or prior lead claim is held");
    state.supervisors[c.taskId] = { taskId: c.taskId, actor, epoch: (old?.epoch ?? 0) + 1, expiresAt: iso(time + c.leaseMs), ownerTokenHash: tokenHash(c.ownerToken) };
  } else if (c.type === "supervisor_heartbeat" || c.type === "supervisor_release") {
    if (role !== "lead" || !id(c.taskId) || !Number.isInteger(c.epoch)) throw new Error("invalid supervisor mutation");
    const supervisor = requireSupervisor(state, c.taskId, actor, c.epoch, time, c.ownerToken);
    if (c.type === "supervisor_heartbeat") { if (!validLease(c.leaseMs)) throw new Error("invalid lease duration"); supervisor.expiresAt = iso(time + c.leaseMs); }
    else supervisor.expiresAt = iso(time);
  } else if (c.type === "run_claim") {
    if (role !== "lead" || !id(c.taskId) || !validLease(c.leaseMs)) throw new Error("invalid lead claim");
    if (c.ownerToken !== undefined && (typeof c.ownerToken !== "string" || c.ownerToken.length < 32 || c.ownerToken.length > 256)) throw new Error("invalid owner token");
    const supervisor = state.supervisors?.[c.taskId];
    if (supervisor) {
      requireSupervisor(state, c.taskId, actor, c.supervisorEpoch, time, c.supervisorOwnerToken);
      if (typeof c.ownerToken !== "string" || c.ownerToken.length < 32) throw new Error("supervised run requires a secret owner token");
    }
    const old = state.leads[c.taskId];
    if (old && Date.parse(old.expiresAt) > time) throw new FleetConflict("lead claim is held");
    state.leads[c.taskId] = { taskId: c.taskId, actor, epoch: (old?.epoch ?? 0) + 1, expiresAt: iso(time + c.leaseMs), ...(c.ownerToken ? { ownerTokenHash: tokenHash(c.ownerToken) } : {}), ...(supervisor ? { supervisorEpoch: supervisor.epoch, supervisorOwnerTokenHash: supervisor.ownerTokenHash, ...(c.checkpointSnapshotId ? { checkpointSnapshotId: c.checkpointSnapshotId } : {}) } : {}) };
    for (const job of Object.values(state.jobs)) if (job.taskId === c.taskId && job.state !== "integrated" && job.leadEpoch < state.leads[c.taskId].epoch) { job.state = "uncertain"; job.uncertainAt = iso(time); job.expiresAt = null; }
  } else if (c.type === "run_heartbeat" || c.type === "run_release") {
    if (role !== "lead" || !id(c.taskId) || !Number.isInteger(c.epoch)) throw new Error("invalid lead mutation");
    const lead = requireLead(state, c.taskId, actor, c.epoch, time, c.ownerToken);
    if (c.type === "run_heartbeat") { if (!validLease(c.leaseMs)) throw new Error("invalid lease duration"); lead.expiresAt = iso(time + c.leaseMs); }
    else lead.expiresAt = iso(time);
  } else if (c.type === "job_schedule") {
    if (role !== "lead" || !id(c.jobId) || !id(c.taskId) || !id(c.itemId) || !id(c.workerId) || !["codex", "claude"].includes(c.agent) || !Number.isInteger(c.attempt) || c.attempt < 1 || !Array.isArray(c.ownedPaths) || c.ownedPaths.length > 100 || c.ownedPaths.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) || !/^[a-f0-9]{40}$/.test(c.baseCommit) || !branchName(c.branch)) throw new Error("invalid job schedule");
    requireLead(state, c.taskId, actor, c.leadEpoch, time, c.ownerToken);
    if (state.jobs[c.jobId]) throw new FleetConflict("job ID already exists");
    const priorJobs=Object.values(state.jobs).filter((job)=>job.taskId===c.taskId&&job.itemId===c.itemId);
    if(priorJobs.some((job)=>job.state==="integrated")) throw new FleetConflict("item already integrated");
    if(priorJobs.some((job)=>!["integrated","uncertain"].includes(job.state))) throw new FleetConflict("item already has an active job");
    if(priorJobs.length && c.attempt<=Math.max(...priorJobs.map((job)=>job.attempt))) throw new FleetConflict("job attempt must increase after reconciliation");
    state.jobs[c.jobId] = { schemaVersion: 1, id: c.jobId, taskId: c.taskId, itemId: c.itemId, workerId: c.workerId, agent: c.agent, attempt: c.attempt, leadEpoch: c.leadEpoch, epoch: 0, ownedPaths: c.ownedPaths, baseCommit: c.baseCommit, branch: c.branch, state: "ready", expiresAt: null, uncertainAt: null, sessionId: null, checkpoint: null, report: null };
  } else if (c.type === "job_claim") {
    if (role !== "worker" || !id(c.jobId) || !validLease(c.leaseMs)) throw new Error("invalid job claim");
    const job = state.jobs[c.jobId];
    if (!job || job.workerId !== actor) throw new Error("job is not assigned to worker");
    { const lead = state.leads[job.taskId]; if (!lead || lead.epoch !== job.leadEpoch || Date.parse(lead.expiresAt) <= time) throw new FleetConflict("stale or expired lead claim"); verifyBoundSupervisor(state, lead, time); }
    if (job.state === "leased") throw new FleetConflict(Date.parse(job.expiresAt) > time ? "job lease is held" : "expired job lease requires lead reconciliation");
    if (job.state !== "ready") throw new FleetConflict("job requires lead reconciliation");
    job.epoch += 1; job.state = "leased"; job.expiresAt = iso(time + c.leaseMs); job.sessionId = null; job.checkpoint = null;
  } else if (c.type === "job_heartbeat" || c.type === "job_checkpoint" || c.type === "job_report" || c.type === "job_abandon") {
    if (role !== "worker" || !id(c.jobId) || !Number.isInteger(c.epoch)) throw new Error("invalid job mutation");
    const job = requireJob(state, c.jobId, actor, c.epoch, time);
    { const lead = state.leads[job.taskId]; if (!lead || lead.epoch !== job.leadEpoch || Date.parse(lead.expiresAt) <= time) throw new FleetConflict("stale or expired lead claim"); }
    if (c.type === "job_heartbeat") { if (!validLease(c.leaseMs)) throw new Error("invalid lease duration"); job.expiresAt = iso(time + c.leaseMs); }
    else if (c.type === "job_checkpoint") { if (typeof c.sessionId !== "string" || !c.sessionId || c.sessionId.length > 256 || typeof c.checkpoint !== "string" || c.checkpoint.length > 4000) throw new Error("invalid job checkpoint"); if (job.sessionId && job.sessionId !== c.sessionId) throw new FleetConflict("job session cannot change within a leased attempt"); job.sessionId = c.sessionId; job.checkpoint = c.checkpoint; }
    else if (c.type === "job_abandon") { if (typeof c.reason !== "string" || !c.reason.trim() || c.reason.length > 2000) throw new Error("invalid abandonment reason"); job.state = "uncertain"; job.uncertainAt = iso(time); job.report = { reason: c.reason, reportedAt: iso(time) }; job.expiresAt = iso(time); }
    else { if (!/^[a-f0-9]{40}$/.test(c.commitSha) || !validChangedPaths(job,c.changedPaths)) throw new Error("invalid or out-of-scope job report"); job.report = { commitSha: c.commitSha, changedPaths: c.changedPaths, summary: typeof c.summary === "string" ? c.summary.slice(0, 2000) : "", reportedAt: iso(time) }; job.state = "reported"; job.expiresAt = iso(time); }
  } else if (c.type === "job_recover") {
    if(role!=="lead" || !id(c.jobId)) throw new Error("invalid job recovery");
    const job=state.jobs[c.jobId]; if(!job) throw new Error("unknown job");
    requireLead(state,job.taskId,actor,c.leadEpoch,time,c.ownerToken);
    if(!["uncertain","ready"].includes(job.state)) throw new FleetConflict("job is not awaiting recovery");
    if(!/^[a-f0-9]{40}$/.test(c.commitSha) || !validChangedPaths(job,c.changedPaths)) throw new Error("invalid or out-of-scope recovered commit");
    job.leadEpoch=c.leadEpoch; job.report={commitSha:c.commitSha,changedPaths:c.changedPaths,summary:typeof c.summary==="string"?c.summary.slice(0,2000):"",recoveredAt:iso(time)};
    job.state="reported"; job.expiresAt=null; job.uncertainAt=null;
  } else if (c.type === "job_reconcile") {
    if (role !== "lead" || !id(c.jobId) || !["ready", "uncertain", "integrated"].includes(c.state)) throw new Error("invalid job reconciliation");
    const job = state.jobs[c.jobId]; if (!job) throw new Error("unknown job"); requireLead(state, job.taskId, actor, c.leadEpoch, time, c.ownerToken); if(c.state==="integrated" && (job.state!=="reported" || !job.report?.commitSha || job.leadEpoch!==c.leadEpoch)) throw new Error("only a current-epoch reported commit may be integrated"); if(c.state==="ready") { if(job.state!=="uncertain") throw new Error("only an uncertain job may be retried"); job.leadEpoch=c.leadEpoch; job.sessionId=null; job.checkpoint=null; job.report=null; job.uncertainAt=null; } if(c.state==="uncertain") job.uncertainAt=iso(time); if(c.state==="integrated") job.uncertainAt=null; job.state = c.state; job.expiresAt = null;
  } else throw new Error("unsupported fleet command");
  return state;
};

const validateMutation = (workspace, revision, key, actor, role) => {
  if (!id(workspace) || !Number.isInteger(revision) || revision < 0 || !id(key) || !id(actor) || !["lead", "worker"].includes(role)) throw new Error("invalid fleet mutation precondition");
};
const publicFleet = (input) => {
  const fleet = copy(input);
  for (const entry of Object.values(fleet.leads ?? {})) { delete entry.ownerTokenHash; delete entry.supervisorOwnerTokenHash; }
  for (const entry of Object.values(fleet.supervisors ?? {})) delete entry.ownerTokenHash;
  return fleet;
};
const payloadDigest = (role, actor, command) => createHash("sha256").update(JSON.stringify([role, actor, command])).digest("hex");
const verifyReplayFence = (state, command, actor, role, time = now()) => {
  const type = command.type;
  if (type.startsWith("supervisor_")) return requireSupervisor(state, command.taskId, actor, type === "supervisor_claim" ? state.supervisors?.[command.taskId]?.epoch : command.epoch, time, command.ownerToken);
  if (type === "run_claim") return requireLead(state, command.taskId, actor, state.leads?.[command.taskId]?.epoch, time, command.ownerToken);
  if (type === "run_heartbeat" || type === "run_release") return requireLead(state, command.taskId, actor, command.epoch, time, command.ownerToken);
  if (["job_schedule", "job_reconcile", "job_recover"].includes(type)) return requireLead(state, command.taskId ?? state.jobs?.[command.jobId]?.taskId, actor, command.leadEpoch, time, command.ownerToken);
  if (["job_claim", "job_heartbeat", "job_checkpoint", "job_report", "job_abandon"].includes(type)) return requireJob(state, command.jobId, actor, type === "job_claim" ? state.jobs?.[command.jobId]?.epoch : command.epoch, time);
};
const verifyResume = (command, row, checkpoint, review) => {
  if (!row || !Number.isSafeInteger(command.expectedStateRevision) || command.expectedStateRevision !== Number(row.revision)) throw new FleetConflict("canonical revision changed before run claim");
  const state = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
  const task = state?.tasks?.[command.taskId];
  if (!task || typeof command.expectedTaskDigest !== "string" || createHash("sha256").update(JSON.stringify(task)).digest("hex") !== command.expectedTaskDigest || task.status !== "active" || task.handoff || nextAction(task).classification !== "run_phase") throw new FleetConflict("canonical task changed or is not runnable");
  if (checkpoint?.status === "pending") throw new FleetConflict("human approval is still pending");
  if (checkpoint?.status === "approved") {
    const target = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" }[checkpoint.gate];
    const originalPhase = { G0_confirm: "clarify", G1_review: "plan", G2_codereview: "build" }[checkpoint.gate];
    if (checkpoint.phase !== originalPhase || command.checkpointSnapshotId !== checkpoint.snapshot_id || command.checkpointApprovalRevision !== Number(checkpoint.approval_revision) || Number(row.revision) !== Number(checkpoint.approval_revision) || !review || review.task_id !== command.taskId || review.gate !== checkpoint.gate || review.task_digest !== checkpoint.task_digest || Number(review.state_revision) !== Number(checkpoint.state_revision) || review.integration_commit !== checkpoint.integration_commit || task.phase !== target || !task.evidence?.some((e) => e.kind === "approval" && e.gate === checkpoint.gate && e.result === "pass" && typeof e.source === "string" && e.source.trim())) throw new FleetConflict("approved gate checkpoint is stale or mismatched");
  } else if (command.checkpointSnapshotId !== undefined || command.checkpointApprovalRevision !== undefined) throw new FleetConflict("unexpected checkpoint precondition");
};
const gitIntent = (input) => {
  const {workspace,taskId,epoch,ownerToken,operationId,ref,oldOid,newOid} = input ?? {};
  if (!id(workspace) || !id(taskId) || !Number.isInteger(epoch) || typeof ownerToken !== "string" || !id(operationId) || typeof ref !== "string" || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(ref) || ref.includes("..") || ref.endsWith("/") || !/^[a-f0-9]{40}$/.test(oldOid ?? "") || !/^[a-f0-9]{40}$/.test(newOid ?? "") || oldOid === newOid) throw new Error("invalid Git operation intent");
  return {workspace,taskId,epoch,ownerToken,operationId,ref,oldOid,newOid};
};
const gitFence = (fleet, taskId, epoch, ownerToken, marginMs = 1000, time = now()) => {
  const lead=fleet?.leads?.[taskId]; if (!fleet?.supervisors?.[taskId] || !lead) throw new FleetConflict("Git gateway requires supervisor-bound run");
  requireLead(fleet,taskId,lead.actor,epoch,time+marginMs,ownerToken);
};
const gitRow = (row) => row && ({ workspace:row.workspace, operationId:row.operation_id, taskId:row.task_id, epoch:Number(row.epoch), ref:row.ref, oldOid:row.old_oid, newOid:row.new_oid, status:row.status });
const view = (row) => ({ workspace: row.workspace, revision: Number(row.revision), fleet: typeof row.fleet === "string" ? JSON.parse(row.fleet) : row.fleet, updatedAt: row.updated_at });

export class SqliteFleetRepository {
  constructor(filename = process.env.MCP_STATE_SQLITE_PATH ?? "./data/mcp-state.db") { this.db = new Database(filename); this.db.pragma("journal_mode = WAL"); this.db.pragma("busy_timeout = 5000"); this.db.exec("CREATE TABLE IF NOT EXISTS fleet_workspaces (workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, fleet TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS fleet_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(workspace,idempotency_key)); CREATE TABLE IF NOT EXISTS fleet_git_operations (workspace TEXT NOT NULL, operation_id TEXT NOT NULL, task_id TEXT NOT NULL, epoch INTEGER NOT NULL, ref TEXT NOT NULL, old_oid TEXT NOT NULL, new_oid TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(workspace,operation_id))"); }
  #ensure(workspace) { this.db.prepare("INSERT OR IGNORE INTO fleet_workspaces VALUES (?,0,?,?)").run(workspace, JSON.stringify(initial()), iso(now())); }
  async get(workspace) { if (!id(workspace)) throw new Error("invalid workspace"); this.#ensure(workspace); const current=view(this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(workspace)); return {...current,fleet:publicFleet(current.fleet)}; }
  async apply(workspace, expectedRevision, idempotencyKey, actor, role, command) { validateMutation(workspace, expectedRevision, idempotencyKey, actor, role); const scopedKey=`${role}:${actor}:${idempotencyKey}`; this.db.exec("BEGIN IMMEDIATE"); try { this.#ensure(workspace); const current=view(this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(workspace)); const cached=this.db.prepare("SELECT response FROM fleet_idempotency WHERE workspace=? AND idempotency_key=?").get(workspace,scopedKey); if(cached){const entry=JSON.parse(cached.response); if(entry.payloadDigest!==payloadDigest(role,actor,command)) throw new FleetConflict("idempotency payload mismatch"); verifyReplayFence(current.fleet,command,actor,role); this.db.exec("COMMIT");return entry.response;} if(current.revision!==expectedRevision) throw new FleetConflict("fleet revision conflict",{...current,fleet:publicFleet(current.fleet)}); if(command.type==="run_claim" && current.fleet.supervisors?.[command.taskId]) { if(this.db.prepare("SELECT 1 FROM fleet_git_operations WHERE workspace=? AND task_id=? AND status='pending' LIMIT 1").get(workspace,command.taskId)) throw new FleetConflict("pending Git operation requires reconciliation"); const row=this.db.prepare("SELECT revision,state FROM state_workspaces WHERE workspace=?").get(workspace); const checkpoint=this.db.prepare("SELECT * FROM state_gate_checkpoints WHERE workspace=? AND task_id=?").get(workspace,command.taskId); const review=checkpoint ? this.db.prepare("SELECT * FROM state_gate_snapshots WHERE workspace=? AND id=?").get(workspace,checkpoint.snapshot_id) : null; verifyResume(command,row,checkpoint,review); } if(command.type==="job_schedule" && this.db.prepare("SELECT 1 FROM fleet_git_operations WHERE workspace=? AND task_id=? AND status='pending' LIMIT 1").get(workspace,command.taskId)) throw new FleetConflict("pending Git operation requires reconciliation"); const fleet=applyFleetCommand(current.fleet,command,actor,role); if(command.type==="job_schedule"){const checkpointId=fleet.leads?.[command.taskId]?.checkpointSnapshotId;if(checkpointId){const changed=this.db.prepare("UPDATE state_gate_checkpoints SET status='consumed' WHERE workspace=? AND task_id=? AND snapshot_id=? AND status='approved'").run(workspace,command.taskId,checkpointId);if(!changed.changes){const cp=this.db.prepare("SELECT snapshot_id,status FROM state_gate_checkpoints WHERE workspace=? AND task_id=?").get(workspace,command.taskId);if(!cp || cp.snapshot_id!==checkpointId || cp.status!=="consumed") throw new Error("checkpoint changed before fenced dispatch");}}} const response={workspace,revision:expectedRevision+1,fleet:publicFleet(fleet),updatedAt:iso(now())}; this.db.prepare("UPDATE fleet_workspaces SET revision=?,fleet=?,updated_at=? WHERE workspace=?").run(response.revision,JSON.stringify(fleet),response.updatedAt,workspace); this.db.prepare("INSERT INTO fleet_idempotency VALUES (?,?,?)").run(workspace,scopedKey,JSON.stringify({payloadDigest:payloadDigest(role,actor,command),response})); this.db.exec("COMMIT"); return response; } catch(error){try{this.db.exec("ROLLBACK");}catch{} throw error;} }
  async prepareGitOperation(input) {
    const intent=gitIntent(input); this.db.exec("BEGIN IMMEDIATE");
    try { const row=this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(intent.workspace); gitFence(row && view(row).fleet,intent.taskId,intent.epoch,intent.ownerToken); const old=gitRow(this.db.prepare("SELECT * FROM fleet_git_operations WHERE workspace=? AND operation_id=?").get(intent.workspace,intent.operationId)); if(old){if(old.taskId!==intent.taskId || old.epoch!==intent.epoch || old.ref!==intent.ref || old.oldOid!==intent.oldOid || old.newOid!==intent.newOid) throw new FleetConflict("Git operation intent mismatch"); this.db.exec("COMMIT");return {status:old.status};} this.db.prepare("INSERT INTO fleet_git_operations VALUES (?,?,?,?,?,?,?,?)").run(intent.workspace,intent.operationId,intent.taskId,intent.epoch,intent.ref,intent.oldOid,intent.newOid,"pending");this.db.exec("COMMIT");return {status:"pending"}; } catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }
  async getGitOperation({workspace,operationId}) { if(!id(workspace)||!id(operationId)) throw new Error("invalid Git operation lookup"); return gitRow(this.db.prepare("SELECT * FROM fleet_git_operations WHERE workspace=? AND operation_id=?").get(workspace,operationId)) ?? null; }
  async withGitFence({workspace,taskId,epoch,ownerToken,operationId},callback) {
    if(!id(workspace)||!id(taskId)||!Number.isInteger(epoch)||typeof ownerToken!=="string"||!id(operationId)||typeof callback!=="function") throw new Error("invalid Git fence request");
    this.db.exec("BEGIN IMMEDIATE");try { const row=this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(workspace), fleet=row && view(row).fleet; const record=gitRow(this.db.prepare("SELECT * FROM fleet_git_operations WHERE workspace=? AND operation_id=?").get(workspace,operationId)); const assertValid=()=>gitFence(fleet,taskId,epoch,ownerToken);assertValid();if(!record || record.taskId!==taskId || record.epoch!==epoch || record.status!=="pending") throw new FleetConflict("Git operation is absent, stale or already completed");let complete=false;const result=await callback({record,assertValid,complete:async()=>{assertValid();complete=true;}});assertValid();if(!complete) throw new Error("Git callback did not complete operation");this.db.prepare("UPDATE fleet_git_operations SET status='complete' WHERE workspace=? AND operation_id=? AND status='pending'").run(workspace,operationId);this.db.exec("COMMIT");return result;}catch(error){try{this.db.exec("ROLLBACK");}catch{}throw error;}
  }
  close() { this.db.close(); }
}

export class PostgresFleetRepository {
  constructor(connectionString = process.env.MCP_STATE_POSTGRES_URL) { if (!connectionString) throw new Error("MCP_STATE_POSTGRES_URL is required"); this.pool = new pg.Pool({ connectionString }); }
  async #init(c) { await c.query("CREATE TABLE IF NOT EXISTS fleet_workspaces (workspace TEXT PRIMARY KEY, revision BIGINT NOT NULL, fleet JSONB NOT NULL, updated_at TEXT NOT NULL)"); await c.query("CREATE TABLE IF NOT EXISTS fleet_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response JSONB NOT NULL, PRIMARY KEY(workspace,idempotency_key))"); await c.query("CREATE TABLE IF NOT EXISTS fleet_git_operations (workspace TEXT NOT NULL, operation_id TEXT NOT NULL, task_id TEXT NOT NULL, epoch BIGINT NOT NULL, ref TEXT NOT NULL, old_oid TEXT NOT NULL, new_oid TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(workspace,operation_id))"); }
  async get(workspace) { if (!id(workspace)) throw new Error("invalid workspace"); const c=await this.pool.connect(); try { await this.#init(c); await c.query("INSERT INTO fleet_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING",[workspace,initial(),iso(now())]); const current=view((await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1",[workspace])).rows[0]); return {...current,fleet:publicFleet(current.fleet)}; } finally { c.release(); } }
  async apply(workspace,expectedRevision,idempotencyKey,actor,role,command) { validateMutation(workspace,expectedRevision,idempotencyKey,actor,role); const scopedKey=`${role}:${actor}:${idempotencyKey}`; const c=await this.pool.connect(); try { await this.#init(c); await c.query("BEGIN"); await c.query("INSERT INTO fleet_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING",[workspace,initial(),iso(now())]); const row=(await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const current=view(row); const dbTime=Number((await c.query("SELECT extract(epoch from clock_timestamp()) * 1000 AS ms")).rows[0].ms); const cached=(await c.query("SELECT response FROM fleet_idempotency WHERE workspace=$1 AND idempotency_key=$2",[workspace,scopedKey])).rows[0]; if(cached){const entry=cached.response; if(entry.payloadDigest!==payloadDigest(role,actor,command)) throw new FleetConflict("idempotency payload mismatch"); verifyReplayFence(current.fleet,command,actor,role,dbTime); await c.query("COMMIT");return entry.response;} if(current.revision!==expectedRevision) throw new FleetConflict("fleet revision conflict",{...current,fleet:publicFleet(current.fleet)}); if(command.type==="run_claim" && current.fleet.supervisors?.[command.taskId]) { if((await c.query("SELECT 1 FROM fleet_git_operations WHERE workspace=$1 AND task_id=$2 AND status='pending' LIMIT 1",[workspace,command.taskId])).rowCount) throw new FleetConflict("pending Git operation requires reconciliation"); const stateRow=(await c.query("SELECT revision,state FROM state_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const checkpoint=(await c.query("SELECT * FROM state_gate_checkpoints WHERE workspace=$1 AND task_id=$2 FOR UPDATE",[workspace,command.taskId])).rows[0]; const review=checkpoint ? (await c.query("SELECT * FROM state_gate_snapshots WHERE workspace=$1 AND id=$2",[workspace,checkpoint.snapshot_id])).rows[0] : null; verifyResume(command,stateRow,checkpoint,review); } if(command.type==="job_schedule" && (await c.query("SELECT 1 FROM fleet_git_operations WHERE workspace=$1 AND task_id=$2 AND status='pending' LIMIT 1",[workspace,command.taskId])).rowCount) throw new FleetConflict("pending Git operation requires reconciliation"); const fleet=applyFleetCommand(current.fleet,command,actor,role,dbTime); if(command.type==="job_schedule"){const checkpointId=fleet.leads?.[command.taskId]?.checkpointSnapshotId;if(checkpointId){await c.query("SELECT revision FROM state_workspaces WHERE workspace=$1 FOR UPDATE",[workspace]);const changed=await c.query("UPDATE state_gate_checkpoints SET status='consumed' WHERE workspace=$1 AND task_id=$2 AND snapshot_id=$3 AND status='approved'",[workspace,command.taskId,checkpointId]);if(!changed.rowCount){const cp=(await c.query("SELECT snapshot_id,status FROM state_gate_checkpoints WHERE workspace=$1 AND task_id=$2",[workspace,command.taskId])).rows[0];if(!cp || cp.snapshot_id!==checkpointId || cp.status!=="consumed") throw new Error("checkpoint changed before fenced dispatch");}}} const response={workspace,revision:expectedRevision+1,fleet:publicFleet(fleet),updatedAt:iso(now())}; await c.query("UPDATE fleet_workspaces SET revision=$1,fleet=$2,updated_at=$3 WHERE workspace=$4",[response.revision,fleet,response.updatedAt,workspace]); await c.query("INSERT INTO fleet_idempotency VALUES ($1,$2,$3)",[workspace,scopedKey,{payloadDigest:payloadDigest(role,actor,command),response}]); await c.query("COMMIT");return response; } catch(error){try{await c.query("ROLLBACK");}catch{} throw error;} finally{c.release();} }
  async prepareGitOperation(input) {
    const intent=gitIntent(input), c=await this.pool.connect();try{await this.#init(c);await c.query("BEGIN");const row=(await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[intent.workspace])).rows[0];gitFence(row && view(row).fleet,intent.taskId,intent.epoch,intent.ownerToken,1000,Number((await c.query("SELECT extract(epoch from clock_timestamp()) * 1000 AS ms")).rows[0].ms));const old=gitRow((await c.query("SELECT * FROM fleet_git_operations WHERE workspace=$1 AND operation_id=$2 FOR UPDATE",[intent.workspace,intent.operationId])).rows[0]);if(old){if(old.taskId!==intent.taskId||old.epoch!==intent.epoch||old.ref!==intent.ref||old.oldOid!==intent.oldOid||old.newOid!==intent.newOid)throw new FleetConflict("Git operation intent mismatch");await c.query("COMMIT");return {status:old.status};}await c.query("INSERT INTO fleet_git_operations VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')",[intent.workspace,intent.operationId,intent.taskId,intent.epoch,intent.ref,intent.oldOid,intent.newOid]);await c.query("COMMIT");return {status:"pending"};}catch(error){try{await c.query("ROLLBACK");}catch{}throw error;}finally{c.release();}
  }
  async getGitOperation({workspace,operationId}) {if(!id(workspace)||!id(operationId))throw new Error("invalid Git operation lookup");const c=await this.pool.connect();try{await this.#init(c);return gitRow((await c.query("SELECT * FROM fleet_git_operations WHERE workspace=$1 AND operation_id=$2",[workspace,operationId])).rows[0])??null;}finally{c.release();}}
  async withGitFence({workspace,taskId,epoch,ownerToken,operationId},callback) {
    if(!id(workspace)||!id(taskId)||!Number.isInteger(epoch)||typeof ownerToken!=="string"||!id(operationId)||typeof callback!=="function")throw new Error("invalid Git fence request");const c=await this.pool.connect();try{await this.#init(c);await c.query("BEGIN");const row=(await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0],fleet=row&&view(row).fleet;const record=gitRow((await c.query("SELECT * FROM fleet_git_operations WHERE workspace=$1 AND operation_id=$2 FOR UPDATE",[workspace,operationId])).rows[0]);const assertValid=async()=>gitFence(fleet,taskId,epoch,ownerToken,1000,Number((await c.query("SELECT extract(epoch from clock_timestamp()) * 1000 AS ms")).rows[0].ms));await assertValid();if(!record||record.taskId!==taskId||record.epoch!==epoch||record.status!=="pending")throw new FleetConflict("Git operation is absent, stale or already completed");let complete=false;const result=await callback({record,assertValid,complete:async()=>{await assertValid();complete=true;}});await assertValid();if(!complete)throw new Error("Git callback did not complete operation");await c.query("UPDATE fleet_git_operations SET status='complete' WHERE workspace=$1 AND operation_id=$2 AND status='pending'",[workspace,operationId]);await c.query("COMMIT");return result;}catch(error){try{await c.query("ROLLBACK");}catch{}throw error;}finally{c.release();}
  }
  async close(){await this.pool.end();}
}

export const createFleetRepository = () => process.env.MCP_STATE_DATABASE === "postgres" ? new PostgresFleetRepository() : new SqliteFleetRepository();
