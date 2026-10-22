import Database from "better-sqlite3";
import pg from "pg";

const now = () => Date.now();
const iso = (time) => new Date(time).toISOString();
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
const branchName = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) && !value.includes("..") && !value.endsWith("/");
const copy = (value) => structuredClone(value);
const initial = () => ({ schemaVersion: 1, features: {}, leads: {}, jobs: {} });
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

const requireLead = (state, taskId, actor, epoch, time) => {
  const lead = state.leads[taskId];
  if (!lead || lead.actor !== actor || lead.epoch !== epoch || Date.parse(lead.expiresAt) <= time) throw new FleetConflict("stale or expired lead claim");
  return lead;
};
const requireJob = (state, jobId, actor, epoch, time) => {
  const job = state.jobs[jobId];
  if (!job || job.workerId !== actor || job.epoch !== epoch || job.state !== "leased" || Date.parse(job.expiresAt) <= time) throw new FleetConflict("stale or expired job claim");
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
  } else if (c.type === "run_claim") {
    if (role !== "lead" || !id(c.taskId) || !validLease(c.leaseMs)) throw new Error("invalid lead claim");
    const old = state.leads[c.taskId];
    if (old && Date.parse(old.expiresAt) > time) throw new FleetConflict("lead claim is held", old);
    state.leads[c.taskId] = { taskId: c.taskId, actor, epoch: (old?.epoch ?? 0) + 1, expiresAt: iso(time + c.leaseMs) };
    for (const job of Object.values(state.jobs)) if (job.taskId === c.taskId && job.state !== "integrated" && job.leadEpoch < state.leads[c.taskId].epoch) { job.state = "uncertain"; job.uncertainAt = iso(time); job.expiresAt = null; }
  } else if (c.type === "run_heartbeat" || c.type === "run_release") {
    if (role !== "lead" || !id(c.taskId) || !Number.isInteger(c.epoch)) throw new Error("invalid lead mutation");
    const lead = requireLead(state, c.taskId, actor, c.epoch, time);
    if (c.type === "run_heartbeat") { if (!validLease(c.leaseMs)) throw new Error("invalid lease duration"); lead.expiresAt = iso(time + c.leaseMs); }
    else lead.expiresAt = iso(time);
  } else if (c.type === "job_schedule") {
    if (role !== "lead" || !id(c.jobId) || !id(c.taskId) || !id(c.itemId) || !id(c.workerId) || !["codex", "claude"].includes(c.agent) || !Number.isInteger(c.attempt) || c.attempt < 1 || !Array.isArray(c.ownedPaths) || c.ownedPaths.length > 100 || c.ownedPaths.some((path) => typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) || !/^[a-f0-9]{40}$/.test(c.baseCommit) || !branchName(c.branch)) throw new Error("invalid job schedule");
    requireLead(state, c.taskId, actor, c.leadEpoch, time);
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
    requireLead(state, job.taskId, state.leads[job.taskId]?.actor, job.leadEpoch, time);
    if (job.state === "leased") throw new FleetConflict(Date.parse(job.expiresAt) > time ? "job lease is held" : "expired job lease requires lead reconciliation");
    if (job.state !== "ready") throw new FleetConflict("job requires lead reconciliation");
    job.epoch += 1; job.state = "leased"; job.expiresAt = iso(time + c.leaseMs); job.sessionId = null; job.checkpoint = null;
  } else if (c.type === "job_heartbeat" || c.type === "job_checkpoint" || c.type === "job_report" || c.type === "job_abandon") {
    if (role !== "worker" || !id(c.jobId) || !Number.isInteger(c.epoch)) throw new Error("invalid job mutation");
    const job = requireJob(state, c.jobId, actor, c.epoch, time);
    requireLead(state, job.taskId, state.leads[job.taskId]?.actor, job.leadEpoch, time);
    if (c.type === "job_heartbeat") { if (!validLease(c.leaseMs)) throw new Error("invalid lease duration"); job.expiresAt = iso(time + c.leaseMs); }
    else if (c.type === "job_checkpoint") { if (typeof c.sessionId !== "string" || !c.sessionId || c.sessionId.length > 256 || typeof c.checkpoint !== "string" || c.checkpoint.length > 4000) throw new Error("invalid job checkpoint"); job.sessionId = c.sessionId; job.checkpoint = c.checkpoint; }
    else if (c.type === "job_abandon") { if (typeof c.reason !== "string" || !c.reason.trim() || c.reason.length > 2000) throw new Error("invalid abandonment reason"); job.state = "uncertain"; job.uncertainAt = iso(time); job.report = { reason: c.reason, reportedAt: iso(time) }; job.expiresAt = iso(time); }
    else { if (!/^[a-f0-9]{40}$/.test(c.commitSha) || !validChangedPaths(job,c.changedPaths)) throw new Error("invalid or out-of-scope job report"); job.report = { commitSha: c.commitSha, changedPaths: c.changedPaths, summary: typeof c.summary === "string" ? c.summary.slice(0, 2000) : "", reportedAt: iso(time) }; job.state = "reported"; job.expiresAt = iso(time); }
  } else if (c.type === "job_recover") {
    if(role!=="lead" || !id(c.jobId)) throw new Error("invalid job recovery");
    const job=state.jobs[c.jobId]; if(!job) throw new Error("unknown job");
    requireLead(state,job.taskId,actor,c.leadEpoch,time);
    if(!["uncertain","ready"].includes(job.state)) throw new FleetConflict("job is not awaiting recovery");
    if(!/^[a-f0-9]{40}$/.test(c.commitSha) || !validChangedPaths(job,c.changedPaths)) throw new Error("invalid or out-of-scope recovered commit");
    job.leadEpoch=c.leadEpoch; job.report={commitSha:c.commitSha,changedPaths:c.changedPaths,summary:typeof c.summary==="string"?c.summary.slice(0,2000):"",recoveredAt:iso(time)};
    job.state="reported"; job.expiresAt=null; job.uncertainAt=null;
  } else if (c.type === "job_reconcile") {
    if (role !== "lead" || !id(c.jobId) || !["ready", "uncertain", "integrated"].includes(c.state)) throw new Error("invalid job reconciliation");
    const job = state.jobs[c.jobId]; if (!job) throw new Error("unknown job"); requireLead(state, job.taskId, actor, c.leadEpoch, time); if(c.state==="integrated" && (job.state!=="reported" || !job.report?.commitSha || job.leadEpoch!==c.leadEpoch)) throw new Error("only a current-epoch reported commit may be integrated"); if(c.state==="ready") { if(job.state!=="uncertain") throw new Error("only an uncertain job may be retried"); job.leadEpoch=c.leadEpoch; job.sessionId=null; job.checkpoint=null; job.report=null; job.uncertainAt=null; } if(c.state==="uncertain") job.uncertainAt=iso(time); if(c.state==="integrated") job.uncertainAt=null; job.state = c.state; job.expiresAt = null;
  } else throw new Error("unsupported fleet command");
  return state;
};

const validateMutation = (workspace, revision, key, actor, role) => {
  if (!id(workspace) || !Number.isInteger(revision) || revision < 0 || !id(key) || !id(actor) || !["lead", "worker"].includes(role)) throw new Error("invalid fleet mutation precondition");
};
const view = (row) => ({ workspace: row.workspace, revision: Number(row.revision), fleet: typeof row.fleet === "string" ? JSON.parse(row.fleet) : row.fleet, updatedAt: row.updated_at });

export class SqliteFleetRepository {
  constructor(filename = process.env.MCP_STATE_SQLITE_PATH ?? "./data/mcp-state.db") { this.db = new Database(filename); this.db.pragma("journal_mode = WAL"); this.db.pragma("busy_timeout = 5000"); this.db.exec("CREATE TABLE IF NOT EXISTS fleet_workspaces (workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, fleet TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS fleet_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(workspace,idempotency_key))"); }
  #ensure(workspace) { this.db.prepare("INSERT OR IGNORE INTO fleet_workspaces VALUES (?,0,?,?)").run(workspace, JSON.stringify(initial()), iso(now())); }
  async get(workspace) { if (!id(workspace)) throw new Error("invalid workspace"); this.#ensure(workspace); return view(this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(workspace)); }
  async apply(workspace, expectedRevision, idempotencyKey, actor, role, command) { validateMutation(workspace, expectedRevision, idempotencyKey, actor, role); const scopedKey=`${role}:${actor}:${idempotencyKey}`; this.db.exec("BEGIN IMMEDIATE"); try { this.#ensure(workspace); const cached=this.db.prepare("SELECT response FROM fleet_idempotency WHERE workspace=? AND idempotency_key=?").get(workspace,scopedKey); if(cached){this.db.exec("COMMIT");return JSON.parse(cached.response);} const current=view(this.db.prepare("SELECT * FROM fleet_workspaces WHERE workspace=?").get(workspace)); if(current.revision!==expectedRevision) throw new FleetConflict("fleet revision conflict",current); const fleet=applyFleetCommand(current.fleet,command,actor,role); const response={workspace,revision:expectedRevision+1,fleet,updatedAt:iso(now())}; this.db.prepare("UPDATE fleet_workspaces SET revision=?,fleet=?,updated_at=? WHERE workspace=?").run(response.revision,JSON.stringify(fleet),response.updatedAt,workspace); this.db.prepare("INSERT INTO fleet_idempotency VALUES (?,?,?)").run(workspace,scopedKey,JSON.stringify(response)); this.db.exec("COMMIT"); return response; } catch(error){try{this.db.exec("ROLLBACK");}catch{} throw error;} }
  close() { this.db.close(); }
}

export class PostgresFleetRepository {
  constructor(connectionString = process.env.MCP_STATE_POSTGRES_URL) { if (!connectionString) throw new Error("MCP_STATE_POSTGRES_URL is required"); this.pool = new pg.Pool({ connectionString }); }
  async #init(c) { await c.query("CREATE TABLE IF NOT EXISTS fleet_workspaces (workspace TEXT PRIMARY KEY, revision BIGINT NOT NULL, fleet JSONB NOT NULL, updated_at TEXT NOT NULL)"); await c.query("CREATE TABLE IF NOT EXISTS fleet_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response JSONB NOT NULL, PRIMARY KEY(workspace,idempotency_key))"); }
  async get(workspace) { if (!id(workspace)) throw new Error("invalid workspace"); const c=await this.pool.connect(); try { await this.#init(c); await c.query("INSERT INTO fleet_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING",[workspace,initial(),iso(now())]); return view((await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1",[workspace])).rows[0]); } finally { c.release(); } }
  async apply(workspace,expectedRevision,idempotencyKey,actor,role,command) { validateMutation(workspace,expectedRevision,idempotencyKey,actor,role); const scopedKey=`${role}:${actor}:${idempotencyKey}`; const c=await this.pool.connect(); try { await this.#init(c); await c.query("BEGIN"); await c.query("INSERT INTO fleet_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING",[workspace,initial(),iso(now())]); const row=(await c.query("SELECT * FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const cached=(await c.query("SELECT response FROM fleet_idempotency WHERE workspace=$1 AND idempotency_key=$2",[workspace,scopedKey])).rows[0]; if(cached){await c.query("COMMIT");return cached.response;} const current=view(row); if(current.revision!==expectedRevision) throw new FleetConflict("fleet revision conflict",current); const fleet=applyFleetCommand(current.fleet,command,actor,role); const response={workspace,revision:expectedRevision+1,fleet,updatedAt:iso(now())}; await c.query("UPDATE fleet_workspaces SET revision=$1,fleet=$2,updated_at=$3 WHERE workspace=$4",[response.revision,fleet,response.updatedAt,workspace]); await c.query("INSERT INTO fleet_idempotency VALUES ($1,$2,$3)",[workspace,scopedKey,response]); await c.query("COMMIT");return response; } catch(error){try{await c.query("ROLLBACK");}catch{} throw error;} finally{c.release();} }
  async close(){await this.pool.end();}
}

export const createFleetRepository = () => process.env.MCP_STATE_DATABASE === "postgres" ? new PostgresFleetRepository() : new SqliteFleetRepository();
