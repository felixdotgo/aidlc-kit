import Database from "better-sqlite3";
import pg from "pg";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasCurrentBuildApproval, nextAction, stampLegacyG2Waits, transitionDiagnostics, transitionTask, validateState } from "./lifecycle-core.mjs";

const emptyState = () => ({ schemaVersion: 4, tasks: {}, archive: {} });
const emptyIndex = (revision) => ({ schemaVersion: 1, sourceRevision: revision, taskIds: [], updatedAt: new Date().toISOString() });
const parse = (value) => JSON.parse(value);
const encode = (value) => JSON.stringify(value);
// Rows persisted by a pre-v4 service are the only trusted source of legacy G2 stamps; the stamp
// timestamp reuses task.updatedAt so repeated loads stay byte-identical until a write persists v4.
const upgradeStoredState = (state) => {
  if (Number(state?.schemaVersion) !== 3) return state;
  const next = structuredClone(state);
  next.schemaVersion = 4;
  stampLegacyG2Waits(next);
  return next;
};
const snapshot = (row) => ({ workspace: row.workspace, revision: Number(row.revision), state: upgradeStoredState(parse(row.state)), index: parse(row.task_index), updatedAt: row.updated_at });
const same = (left, right) => isDeepStrictEqual(left, right);
const assertStateIntegrity = (before, after) => {
  for (const [taskId, current] of Object.entries(after.tasks ?? {})) {
    const marker = current?.legacyG2Wait;
    if (marker !== undefined && !same(marker, before.tasks?.[taskId]?.legacyG2Wait)) throw new Error(`Task ${taskId} legacy G2 wait marker is migration-owned and cannot be created or changed by a client`);
  }
  for (const [taskId, previous] of Object.entries(before.tasks ?? {})) {
    const current = after.tasks?.[taskId];
    if (!current) {
      if (previous.status === "blocked_on_user") throw new Error(`Task ${taskId} cannot be removed while waiting at ${previous.gate}`);
      continue;
    }
    const priorEvidence = Array.isArray(previous.evidence) ? previous.evidence : [];
    const currentEvidence = Array.isArray(current.evidence) ? current.evidence : [];
    if (currentEvidence.length < priorEvidence.length || !same(currentEvidence.slice(0, priorEvidence.length), priorEvidence)) throw new Error(`Task ${taskId} evidence history is append-only`);
    if (previous.status !== "blocked_on_user") continue;
    const leftWait = current.status !== "blocked_on_user" || current.phase !== previous.phase || current.gate !== previous.gate;
    const withoutVolatile = ({ evidence, updatedAt, status, ...rest }) => rest;
    if (!leftWait) {
      // Readiness-bearing state is frozen while a task waits at a gate; only evidence may be appended.
      if (!same(withoutVolatile(current), withoutVolatile(previous))) throw new Error(`Task ${taskId} is frozen while waiting at ${previous.gate}; only evidence may be appended`);
      continue;
    }
    // Mirrors the local CLI recovery for an invalid wait at the gateless wrap phase; it flips only the status and is not a human approval.
    if (previous.gate === "none" && previous.phase === "wrap" && current.status === "active" && current.phase === previous.phase && current.gate === previous.gate) {
      if (!same(withoutVolatile(current), withoutVolatile(previous))) throw new Error(`Task ${taskId} gateless wrap recovery may only return the wait to active`);
      continue;
    }
    const appended = currentEvidence.slice(priorEvidence.length);
    const approved = appended.some((item) => item?.kind === "approval" && item.result === "pass" && item.gate === previous.gate && typeof item.source === "string" && Boolean(item.source.trim()));
    const cancelled = appended.some((item) => item?.kind === "diagnostic" && item.result === "pass" && typeof item.source === "string" && Boolean(item.source.trim()) && typeof item.detail === "string" && item.detail.startsWith(`Cancelled gate wait at ${previous.gate}: `));
    const closureExit = (current.status === "closed" || current.status === "superseded") && typeof current.closure?.reason === "string" && Boolean(current.closure.reason.trim()) && typeof current.closure?.source === "string" && Boolean(current.closure.source.trim());
    const handoffExit = current.status === "paused" && typeof current.handoff?.reason === "string" && Boolean(current.handoff.reason.trim()) && typeof current.handoff?.source === "string" && Boolean(current.handoff.source.trim());
    if (!approved && !cancelled && !closureExit && !handoffExit) throw new Error(`Task ${taskId} cannot leave ${previous.gate} without a same-gate approval, audited cancellation, or sourced closure/handoff record`);
  }
};
const mutationResult = (before, state, index, touchedTaskIds = []) => {
  validateState(state);
  if (Number(state.schemaVersion) < 4) { state.schemaVersion = 4; state.archive ??= {}; validateState(state); }
  assertStateIntegrity(before, state);
  for (const taskId of touchedTaskIds) {
    const task = state.tasks?.[taskId];
    if (task?.status === "blocked_on_user" && nextAction(task).classification !== "await_user") throw new Error(`Task ${taskId} cannot enter or hold blocked_on_user unless its gate wait is valid and ready`);
  }
  return { state, index, touchedTaskIds };
};
const rejectLeadApprovals = (before, after) => {
  for(const [taskId, task] of Object.entries(after.tasks ?? {})) {
    const prior=before.tasks?.[taskId]?.evidence ?? [];
    const appended=(task.evidence ?? []).slice(prior.length).filter((item)=>item.kind==="approval");
    if(appended.some((item)=>item.result==="pass")) throw new Error("lead credential cannot record human gate approval");
    if(appended.length && !(appended.length===1 && appended[0].result==="fail" && appended[0].gate==="G1_review" && before.tasks?.[taskId]?.phase==="build" && before.tasks[taskId].status==="paused" && before.tasks[taskId].handoff && task.phase==="plan" && task.status==="active")) throw new Error("lead credential cannot record gate approval evidence");
  }
};
const assertLeadTransitions = (before, after) => {
  for(const [taskId, task] of Object.entries(after.tasks ?? {})) {
    const previous=before.tasks?.[taskId];
    if(!previous) { if(task.phase!=="clarify" || task.gate!=="G0_confirm" || task.status!=="active" || task.evidence.some((item)=>item.kind==="approval")) throw new Error("new fleet task must start active at G0 without approvals"); continue; }
    if(task.phase===previous.phase) continue;
    if(previous.phase==="wrap" && task.phase==="done" && previous.status==="active" && task.status==="done" && task.gate==="none" && hasCurrentBuildApproval(previous,"G2_codereview") && !transitionDiagnostics(previous,"done").some((item)=>item.level==="ERROR")) continue;
    if(previous.phase==="build" && task.phase==="plan" && previous.status==="paused" && previous.handoff && task.status==="active" && task.gate==="G1_review" && task.evidence.slice(previous.evidence.length).some((item)=>item.kind==="approval" && item.gate==="G1_review" && item.result==="fail")) continue;
    throw new Error(`lead credential cannot change phase ${previous.phase} to ${task.phase}; human gate approval is required`);
  }
  for(const [taskId, previous] of Object.entries(before.tasks ?? {})) if(!after.tasks?.[taskId] && !["done","closed","superseded"].includes(previous.status)) throw new Error("active fleet task cannot be removed");
};
const snapshotId = (workspace, taskId, revision, gate, reviewText, integrationCommit) => createHash("sha256").update(JSON.stringify([workspace, taskId, revision, gate, reviewText, integrationCommit ?? null])).digest("hex");
const taskDigest = (task) => createHash("sha256").update(JSON.stringify(task)).digest("hex");
const reviewWithCommit = (gate, reviewText, integrationCommit) => gate === "G2_codereview" && typeof reviewText === "string" ? `${reviewText.trimEnd()}\n\nIntegration commit: ${integrationCommit}` : reviewText;
const validateGateSnapshot = (current, taskId, gate, reviewText, integrationCommit) => {
  const task = current.state.tasks?.[taskId];
  if (!task || task.gate !== gate || task.status !== "blocked_on_user" || nextAction(task).classification !== "await_user") throw new Error("task is not ready at requested gate");
  if (typeof reviewText !== "string" || !reviewText.trim() || reviewText.length > 20000) throw new Error("bounded gate review text is required");
  if ((integrationCommit !== undefined && integrationCommit !== null && !/^[a-f0-9]{40}$/.test(integrationCommit)) || (gate === "G2_codereview" && !/^[a-f0-9]{40}$/.test(integrationCommit ?? ""))) throw new Error("G2 review snapshot requires a 40-character integration commit SHA");
};
const approveSnapshot = (current, snapshot, taskId, source, integrationCommit) => {
  if (typeof source !== "string" || !source.trim() || source.length > 2000) throw new Error("explicit approval source is required");
  if (!snapshot || snapshot.task_id !== taskId || !current.state.tasks?.[taskId] || snapshot.task_digest !== taskDigest(current.state.tasks[taskId])) throw new Error("stale gate snapshot");
  if(snapshot.integration_commit && snapshot.integration_commit!==integrationCommit) throw new Error("reviewed integration commit does not match approval request");
  const task = current.state.tasks?.[taskId];
  if (!task || task.gate !== snapshot.gate || task.status !== "blocked_on_user" || nextAction(task).classification !== "await_user") throw new Error("gate is no longer ready");
  const state = structuredClone(current.state);
  state.tasks[taskId].evidence.push({ kind: "approval", gate: snapshot.gate, source, result: "pass", recordedAt: new Date().toISOString() });
  const target = { G0_confirm: "plan", G1_review: "build", G2_codereview: "wrap" }[snapshot.gate];
  if (!target) throw new Error("invalid gate");
  transitionTask(state, taskId, target);
  return mutationResult(current.state, state, current.index, [taskId]);
};
const verifyFence = (fleet, taskId, epoch) => {
  const lead = fleet?.leads?.[taskId];
  if (!lead || !Number.isInteger(epoch) || lead.epoch !== epoch || Date.parse(lead.expiresAt) <= Date.now()) throw new Error("stale or expired lead epoch");
};

export class RevisionConflict extends Error {
  constructor(current) { super(`State revision conflict: expected a newer snapshot than ${current.revision}`); this.name = "RevisionConflict"; this.current = current; }
}

const applyCommand = (current, command) => {
  if (!command || typeof command !== "object" || typeof command.type !== "string") throw new Error("state.apply requires a typed command");
  const state = structuredClone(current.state);
  let index = structuredClone(current.index);
  if (command.type === "replaceState") {
    if (!command.state || typeof command.state !== "object" || Array.isArray(command.state)) throw new Error("replaceState requires an object state");
    const nextState = structuredClone(command.state);
    return mutationResult(current.state, nextState, index, [...new Set([...Object.keys(current.state.tasks ?? {}), ...Object.keys(nextState.tasks ?? {})])]);
  }
  if (command.type === "upsertTask") {
    if (typeof command.taskId !== "string" || !command.taskId || !command.task || typeof command.task !== "object" || Array.isArray(command.task)) throw new Error("upsertTask requires taskId and task");
    state.tasks ??= {}; state.tasks[command.taskId] = structuredClone(command.task);
    index = { ...index, taskIds: Object.keys(state.tasks).sort() };
    return mutationResult(current.state, state, index, [command.taskId]);
  }
  if (command.type === "removeTask") {
    if (typeof command.taskId !== "string" || !command.taskId) throw new Error("removeTask requires taskId");
    delete state.tasks?.[command.taskId];
    index = { ...index, taskIds: Object.keys(state.tasks ?? {}).sort() };
    return mutationResult(current.state, state, index, [command.taskId]);
  }
  if (command.type === "transition") {
    if (typeof command.taskId !== "string" || typeof command.target !== "string") throw new Error("transition requires taskId and target");
    transitionTask(state, command.taskId, command.target);
    index = { ...index, taskIds: Object.keys(state.tasks ?? {}).sort() };
    return mutationResult(current.state, state, index, [command.taskId]);
  }
  if (command.type === "replaceIndex") {
    if (!command.index || typeof command.index !== "object" || Array.isArray(command.index)) throw new Error("replaceIndex requires an object index");
    return mutationResult(current.state, state, structuredClone(command.index));
  }
  throw new Error(`Unsupported state command: ${command.type}`);
};

export class SqliteStateRepository {
  constructor(filename = process.env.MCP_STATE_SQLITE_PATH ?? "./data/mcp-state.db") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_workspaces (
        workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, task_index TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL, command TEXT NOT NULL, recorded_at TEXT NOT NULL,
        UNIQUE(workspace, revision)
      );
      CREATE TABLE IF NOT EXISTS state_idempotency (
        workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(workspace, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS state_gate_snapshots (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT NOT NULL, gate TEXT NOT NULL, state_revision INTEGER NOT NULL, task_digest TEXT NOT NULL, integration_commit TEXT, review_text TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    if(!this.db.prepare("PRAGMA table_info(state_gate_snapshots)").all().some((column)=>column.name==="task_digest")) this.db.exec("ALTER TABLE state_gate_snapshots ADD COLUMN task_digest TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare("PRAGMA table_info(state_gate_snapshots)").all().some((column)=>column.name==="integration_commit")) this.db.exec("ALTER TABLE state_gate_snapshots ADD COLUMN integration_commit TEXT");
  }

  #ensure(workspace) {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO state_workspaces (workspace, revision, state, task_index, updated_at) VALUES (?, 0, ?, ?, ?)")
      .run(workspace, encode(emptyState()), encode(emptyIndex(0)), now);
  }

  async get(workspace) {
    this.#ensure(workspace);
    return snapshot(this.db.prepare("SELECT workspace, revision, state, task_index, updated_at FROM state_workspaces WHERE workspace = ?").get(workspace));
  }

  async eventsSince(workspace, cursor = 0) {
    this.#ensure(workspace);
    return this.db.prepare("SELECT id, revision, command, recorded_at FROM state_events WHERE workspace = ? AND id > ? ORDER BY id ASC LIMIT 100").all(workspace, cursor)
      .map((row) => ({ cursor: row.id, revision: row.revision, command: parse(row.command), recordedAt: row.recorded_at }));
  }

  async apply(workspace, expectedRevision, idempotencyKey, command, clientProjectRoot, leadEpoch) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision must be a non-negative integer");
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    if (typeof clientProjectRoot !== "string" || !clientProjectRoot.trim() || !isAbsolute(clientProjectRoot)) throw new Error("clientProjectRoot must be an absolute path");
    const actionRoot = resolve(clientProjectRoot);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#ensure(workspace);
      if (leadEpoch !== undefined) {
        const fleetRow=this.db.prepare("SELECT fleet FROM fleet_workspaces WHERE workspace=?").get(workspace);
        verifyFence(fleetRow && parse(fleetRow.fleet),command.taskId,leadEpoch);
      }
      const stored = this.db.prepare("SELECT response FROM state_idempotency WHERE workspace = ? AND idempotency_key = ?").get(workspace, idempotencyKey);
      if (stored) { this.db.exec("COMMIT"); return parse(stored.response); }
      const current = snapshot(this.db.prepare("SELECT workspace, revision, state, task_index, updated_at FROM state_workspaces WHERE workspace = ?").get(workspace));
      if (current.revision !== expectedRevision) throw new RevisionConflict(current);
      const next = applyCommand(current, command);
      if(leadEpoch!==undefined) { rejectLeadApprovals(current.state,next.state); assertLeadTransitions(current.state,next.state); }
      const revision = current.revision + 1; const updatedAt = new Date().toISOString();
      next.index = { ...next.index, sourceRevision: revision, updatedAt };
      const nextActions = Object.fromEntries(next.touchedTaskIds.flatMap((taskId) => next.state.tasks?.[taskId] ? [[taskId, nextAction(next.state.tasks[taskId], actionRoot)]] : []));
      const response = { workspace, revision, state: next.state, index: next.index, nextActions, updatedAt };
      this.db.prepare("UPDATE state_workspaces SET revision = ?, state = ?, task_index = ?, updated_at = ? WHERE workspace = ?")
        .run(revision, encode(next.state), encode(next.index), updatedAt, workspace);
      this.db.prepare("INSERT INTO state_events (workspace, revision, idempotency_key, command, recorded_at) VALUES (?, ?, ?, ?, ?)")
        .run(workspace, revision, idempotencyKey, encode(command), updatedAt);
      this.db.prepare("INSERT INTO state_idempotency (workspace, idempotency_key, response) VALUES (?, ?, ?)")
        .run(workspace, idempotencyKey, encode(response));
      this.db.exec("COMMIT"); return response;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  async gateInbox(workspace) {
    const current = await this.get(workspace);
    return this.db.prepare("SELECT id,task_id AS taskId,gate,state_revision AS stateRevision,task_digest AS taskDigest,integration_commit AS integrationCommit,review_text AS reviewText,created_at AS createdAt FROM state_gate_snapshots WHERE workspace=? ORDER BY created_at DESC,id DESC LIMIT 100").all(workspace).filter((item) => current.state.tasks[item.taskId]?.status === "blocked_on_user" && item.taskDigest === taskDigest(current.state.tasks[item.taskId])).map((item)=>({...item,currentRevision:current.revision}));
  }

  async putGateSnapshot(workspace, expectedRevision, idempotencyKey, taskId, gate, reviewText, leadEpoch, integrationCommit) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#ensure(workspace);
      if (leadEpoch !== undefined) { const fleetRow=this.db.prepare("SELECT fleet FROM fleet_workspaces WHERE workspace=?").get(workspace); verifyFence(fleetRow && parse(fleetRow.fleet),taskId,leadEpoch); }
      const cached=this.db.prepare("SELECT response FROM state_idempotency WHERE workspace=? AND idempotency_key=?").get(workspace,idempotencyKey);
      if(cached){this.db.exec("COMMIT");return parse(cached.response);}
      const current=snapshot(this.db.prepare("SELECT * FROM state_workspaces WHERE workspace=?").get(workspace));
      if(current.revision!==expectedRevision) throw new RevisionConflict(current);
      const boundReviewText=reviewWithCommit(gate,reviewText,integrationCommit);
      validateGateSnapshot(current,taskId,gate,boundReviewText,integrationCommit);
      const item={ id:snapshotId(workspace,taskId,current.revision,gate,boundReviewText,integrationCommit), workspace,taskId,gate,stateRevision:current.revision,taskDigest:taskDigest(current.state.tasks[taskId]),integrationCommit:integrationCommit??null,reviewText:boundReviewText,createdAt:new Date().toISOString() };
      this.db.prepare("INSERT OR IGNORE INTO state_gate_snapshots VALUES (?,?,?,?,?,?,?,?,?)").run(item.id,workspace,taskId,gate,current.revision,item.taskDigest,item.integrationCommit,boundReviewText,item.createdAt);
      item.createdAt=this.db.prepare("SELECT created_at FROM state_gate_snapshots WHERE id=?").get(item.id).created_at;
      this.db.prepare("INSERT INTO state_idempotency VALUES (?,?,?)").run(workspace,idempotencyKey,encode(item));
      this.db.exec("COMMIT"); return item;
    } catch(error){try{this.db.exec("ROLLBACK");}catch{} throw error;}
  }

  async approveGate(workspace,expectedRevision,idempotencyKey,taskId,gateSnapshotId,source,clientProjectRoot,integrationCommit) {
    if(typeof idempotencyKey!=="string"||!idempotencyKey.trim()||typeof clientProjectRoot!=="string"||!isAbsolute(clientProjectRoot)) throw new Error("invalid approval precondition");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#ensure(workspace);
      const cached=this.db.prepare("SELECT response FROM state_idempotency WHERE workspace=? AND idempotency_key=?").get(workspace,idempotencyKey);
      if(cached){this.db.exec("COMMIT");return parse(cached.response);}
      const current=snapshot(this.db.prepare("SELECT * FROM state_workspaces WHERE workspace=?").get(workspace));
      if(current.revision!==expectedRevision) throw new RevisionConflict(current);
      const gateSnapshot=this.db.prepare("SELECT * FROM state_gate_snapshots WHERE workspace=? AND id=?").get(workspace,gateSnapshotId);
      const next=approveSnapshot(current,gateSnapshot,taskId,source,integrationCommit); const revision=current.revision+1; const updatedAt=new Date().toISOString(); next.index={...next.index,sourceRevision:revision,updatedAt};
      const response={workspace,revision,state:next.state,index:next.index,nextActions:{[taskId]:nextAction(next.state.tasks[taskId],resolve(clientProjectRoot))},updatedAt};
      this.db.prepare("UPDATE state_workspaces SET revision=?,state=?,task_index=?,updated_at=? WHERE workspace=?").run(revision,encode(next.state),encode(next.index),updatedAt,workspace);
      this.db.prepare("INSERT INTO state_events (workspace,revision,idempotency_key,command,recorded_at) VALUES (?,?,?,?,?)").run(workspace,revision,idempotencyKey,encode({type:"gate_approve",taskId,snapshotId:gateSnapshotId,integrationCommit:integrationCommit??null}),updatedAt);
      this.db.prepare("INSERT INTO state_idempotency VALUES (?,?,?)").run(workspace,idempotencyKey,encode(response));
      this.db.exec("COMMIT");return response;
    } catch(error){try{this.db.exec("ROLLBACK");}catch{} throw error;}
  }

  close() { this.db.close(); }
}

export class PostgresStateRepository {
  constructor(connectionString = process.env.MCP_STATE_POSTGRES_URL) { if (!connectionString) throw new Error("MCP_STATE_POSTGRES_URL is required for PostgreSQL"); this.pool = new pg.Pool({ connectionString }); }
  async #init(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS state_workspaces (workspace TEXT PRIMARY KEY, revision BIGINT NOT NULL, state JSONB NOT NULL, task_index JSONB NOT NULL, updated_at TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS state_events (id BIGSERIAL PRIMARY KEY, workspace TEXT NOT NULL, revision BIGINT NOT NULL, idempotency_key TEXT NOT NULL, command JSONB NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(workspace, revision))`);
    await client.query(`CREATE TABLE IF NOT EXISTS state_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response JSONB NOT NULL, PRIMARY KEY(workspace, idempotency_key))`);
    await client.query(`CREATE TABLE IF NOT EXISTS state_gate_snapshots (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT NOT NULL, gate TEXT NOT NULL, state_revision BIGINT NOT NULL, task_digest TEXT NOT NULL, integration_commit TEXT, review_text TEXT NOT NULL, created_at TEXT NOT NULL)`);
    await client.query(`ALTER TABLE state_gate_snapshots ADD COLUMN IF NOT EXISTS task_digest TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE state_gate_snapshots ADD COLUMN IF NOT EXISTS integration_commit TEXT`);
  }
  async get(workspace) {
    const client = await this.pool.connect();
    try { await this.#init(client); await client.query("INSERT INTO state_workspaces (workspace, revision, state, task_index, updated_at) VALUES ($1, 0, $2, $3, $4) ON CONFLICT DO NOTHING", [workspace, emptyState(), emptyIndex(0), new Date().toISOString()]); const row = (await client.query("SELECT workspace, revision, state, task_index, updated_at FROM state_workspaces WHERE workspace = $1", [workspace])).rows[0]; return { ...row, revision: Number(row.revision), state: upgradeStoredState(row.state), index: row.task_index }; } finally { client.release(); }
  }
  async eventsSince(workspace, cursor = 0) { const client = await this.pool.connect(); try { await this.#init(client); return (await client.query("SELECT id, revision, command, recorded_at FROM state_events WHERE workspace = $1 AND id > $2 ORDER BY id ASC LIMIT 100", [workspace, cursor])).rows.map((row) => ({ cursor: Number(row.id), revision: Number(row.revision), command: row.command, recordedAt: row.recorded_at })); } finally { client.release(); } }
  async apply(workspace, expectedRevision, idempotencyKey, command, clientProjectRoot, leadEpoch) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error("expectedRevision must be a non-negative integer");
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) throw new Error("idempotencyKey is required");
    if (typeof clientProjectRoot !== "string" || !clientProjectRoot.trim() || !isAbsolute(clientProjectRoot)) throw new Error("clientProjectRoot must be an absolute path");
    const actionRoot = resolve(clientProjectRoot);
    const client = await this.pool.connect();
    try {
      await this.#init(client); await client.query("BEGIN");
      if (leadEpoch !== undefined) { const fleetRow=(await client.query("SELECT fleet FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; verifyFence(fleetRow?.fleet,command.taskId,leadEpoch); }
      await client.query("INSERT INTO state_workspaces (workspace, revision, state, task_index, updated_at) VALUES ($1, 0, $2, $3, $4) ON CONFLICT DO NOTHING", [workspace, emptyState(), emptyIndex(0), new Date().toISOString()]);
      const row = (await client.query("SELECT workspace, revision, state, task_index, updated_at FROM state_workspaces WHERE workspace = $1 FOR UPDATE", [workspace])).rows[0]; const current = { workspace: row.workspace, revision: Number(row.revision), state: upgradeStoredState(row.state), index: row.task_index, updatedAt: row.updated_at };
      const stored = (await client.query("SELECT response FROM state_idempotency WHERE workspace = $1 AND idempotency_key = $2", [workspace, idempotencyKey])).rows[0]; if (stored) { await client.query("COMMIT"); return stored.response; }
      if (current.revision !== expectedRevision) throw new RevisionConflict(current);
      const next = applyCommand(current, command); const revision = current.revision + 1; const updatedAt = new Date().toISOString(); next.index = { ...next.index, sourceRevision: revision, updatedAt }; const nextActions = Object.fromEntries(next.touchedTaskIds.flatMap((taskId) => next.state.tasks?.[taskId] ? [[taskId, nextAction(next.state.tasks[taskId], actionRoot)]] : [])); const response = { workspace, revision, state: next.state, index: next.index, nextActions, updatedAt };
      if(leadEpoch!==undefined) { rejectLeadApprovals(current.state,next.state); assertLeadTransitions(current.state,next.state); }
      await client.query("UPDATE state_workspaces SET revision = $1, state = $2, task_index = $3, updated_at = $4 WHERE workspace = $5", [revision, next.state, next.index, updatedAt, workspace]);
      await client.query("INSERT INTO state_events (workspace, revision, idempotency_key, command, recorded_at) VALUES ($1, $2, $3, $4, $5)", [workspace, revision, idempotencyKey, command, updatedAt]);
      await client.query("INSERT INTO state_idempotency (workspace, idempotency_key, response) VALUES ($1, $2, $3)", [workspace, idempotencyKey, response]); await client.query("COMMIT"); return response;
    } catch (error) { try { await client.query("ROLLBACK"); } catch {} throw error; } finally { client.release(); }
  }
  async gateInbox(workspace) { const current=await this.get(workspace); const c=await this.pool.connect(); try { await this.#init(c); return (await c.query("SELECT id,task_id AS \"taskId\",gate,state_revision AS \"stateRevision\",task_digest AS \"taskDigest\",integration_commit AS \"integrationCommit\",review_text AS \"reviewText\",created_at AS \"createdAt\" FROM state_gate_snapshots WHERE workspace=$1 ORDER BY created_at DESC,id DESC LIMIT 100",[workspace])).rows.filter((item)=>current.state.tasks[item.taskId]?.status==="blocked_on_user"&&item.taskDigest===taskDigest(current.state.tasks[item.taskId])).map((item)=>({...item,currentRevision:current.revision})); } finally { c.release(); } }
  async putGateSnapshot(workspace,expectedRevision,idempotencyKey,taskId,gate,reviewText,leadEpoch,integrationCommit) { if(typeof idempotencyKey!=="string"||!idempotencyKey.trim()) throw new Error("idempotencyKey is required"); const c=await this.pool.connect(); try { await this.#init(c); await c.query("BEGIN"); if(leadEpoch!==undefined){const fleetRow=(await c.query("SELECT fleet FROM fleet_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0];verifyFence(fleetRow?.fleet,taskId,leadEpoch);} await c.query("INSERT INTO state_workspaces VALUES ($1,0,$2,$3,$4) ON CONFLICT DO NOTHING",[workspace,emptyState(),emptyIndex(0),new Date().toISOString()]); const row=(await c.query("SELECT * FROM state_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const cached=(await c.query("SELECT response FROM state_idempotency WHERE workspace=$1 AND idempotency_key=$2",[workspace,idempotencyKey])).rows[0]; if(cached){await c.query("COMMIT");return cached.response;} const current={workspace,revision:Number(row.revision),state:upgradeStoredState(row.state),index:row.task_index,updatedAt:row.updated_at}; if(current.revision!==expectedRevision) throw new RevisionConflict(current); const boundReviewText=reviewWithCommit(gate,reviewText,integrationCommit); validateGateSnapshot(current,taskId,gate,boundReviewText,integrationCommit); const item={id:snapshotId(workspace,taskId,current.revision,gate,boundReviewText,integrationCommit),workspace,taskId,gate,stateRevision:current.revision,taskDigest:taskDigest(current.state.tasks[taskId]),integrationCommit:integrationCommit??null,reviewText:boundReviewText,createdAt:new Date().toISOString()}; await c.query("INSERT INTO state_gate_snapshots VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",[item.id,workspace,taskId,gate,current.revision,item.taskDigest,item.integrationCommit,boundReviewText,item.createdAt]); item.createdAt=(await c.query("SELECT created_at FROM state_gate_snapshots WHERE id=$1",[item.id])).rows[0].created_at; await c.query("INSERT INTO state_idempotency VALUES ($1,$2,$3)",[workspace,idempotencyKey,item]); await c.query("COMMIT");return item; } catch(error){try{await c.query("ROLLBACK");}catch{} throw error;} finally{c.release();} }
  async approveGate(workspace,expectedRevision,idempotencyKey,taskId,gateSnapshotId,source,clientProjectRoot,integrationCommit) { if(typeof idempotencyKey!=="string"||!idempotencyKey.trim()||typeof clientProjectRoot!=="string"||!isAbsolute(clientProjectRoot)) throw new Error("invalid approval precondition"); const c=await this.pool.connect(); try { await this.#init(c); await c.query("BEGIN"); await c.query("INSERT INTO state_workspaces VALUES ($1,0,$2,$3,$4) ON CONFLICT DO NOTHING",[workspace,emptyState(),emptyIndex(0),new Date().toISOString()]); const row=(await c.query("SELECT * FROM state_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const cached=(await c.query("SELECT response FROM state_idempotency WHERE workspace=$1 AND idempotency_key=$2",[workspace,idempotencyKey])).rows[0]; if(cached){await c.query("COMMIT");return cached.response;} const current={workspace,revision:Number(row.revision),state:upgradeStoredState(row.state),index:row.task_index,updatedAt:row.updated_at}; if(current.revision!==expectedRevision) throw new RevisionConflict(current); const gateSnapshot=(await c.query("SELECT * FROM state_gate_snapshots WHERE workspace=$1 AND id=$2",[workspace,gateSnapshotId])).rows[0]; const next=approveSnapshot(current,gateSnapshot,taskId,source,integrationCommit); const revision=current.revision+1; const updatedAt=new Date().toISOString(); next.index={...next.index,sourceRevision:revision,updatedAt}; const response={workspace,revision,state:next.state,index:next.index,nextActions:{[taskId]:nextAction(next.state.tasks[taskId],resolve(clientProjectRoot))},updatedAt}; await c.query("UPDATE state_workspaces SET revision=$1,state=$2,task_index=$3,updated_at=$4 WHERE workspace=$5",[revision,next.state,next.index,updatedAt,workspace]); await c.query("INSERT INTO state_events (workspace,revision,idempotency_key,command,recorded_at) VALUES ($1,$2,$3,$4,$5)",[workspace,revision,idempotencyKey,{type:"gate_approve",taskId,snapshotId:gateSnapshotId,integrationCommit:integrationCommit??null},updatedAt]); await c.query("INSERT INTO state_idempotency VALUES ($1,$2,$3)",[workspace,idempotencyKey,response]); await c.query("COMMIT");return response; } catch(error){try{await c.query("ROLLBACK");}catch{} throw error;} finally{c.release();} }
  async close() { await this.pool.end(); }
}

export const createRepository = () => process.env.MCP_STATE_DATABASE === "postgres" ? new PostgresStateRepository() : new SqliteStateRepository();
