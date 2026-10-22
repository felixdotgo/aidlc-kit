import Database from "better-sqlite3";
import pg from "pg";

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const encode = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const statuses = new Set(["backlog", "ready", "in_progress", "blocked", "done", "cancelled"]);
const intents = new Set(["question", "status", "handoff", "decision"]);
const roles = new Set(["reader", "commenter", "writer", "admin"]);
const text = (value, limit = 4096) => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;
const forbidden = /(?:api[_-]?key|authorization|bearer\s+|password|secret)/i;
const denySensitive = (value, label) => { if (!text(value) || forbidden.test(value)) throw new Error(`${label} is required, bounded, and must not contain credentials`); };

export class CoordinationConflict extends Error {
  constructor(current) { super(`expected a newer coordination revision than ${current.revision}`); this.current = current; }
}

export class SqliteCoordinationRepository {
  constructor(filename = process.env.MCP_STATE_SQLITE_PATH ?? "./data/mcp-state.db") {
    this.db = new Database(filename); this.db.pragma("journal_mode = WAL"); this.db.pragma("busy_timeout = 5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS coordination_workspaces (workspace TEXT PRIMARY KEY, revision INTEGER NOT NULL, board TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL, revision INTEGER NOT NULL, actor TEXT NOT NULL, digest TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coordination_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(workspace, idempotency_key));`);
  }
  #ensure(workspace) { this.db.prepare("INSERT OR IGNORE INTO coordination_workspaces VALUES (?, 0, ?, ?)").run(workspace, encode({ tasks: {}, comments: {} }), now()); }
  #current(workspace) { this.#ensure(workspace); const row = this.db.prepare("SELECT * FROM coordination_workspaces WHERE workspace = ?").get(workspace); return { workspace, revision: Number(row.revision), board: parse(row.board), updatedAt: row.updated_at }; }
  async get(workspace, filters = {}) { const current = this.#current(workspace); const tasks = Object.values(current.board.tasks).filter((task) => (!filters.assignee || task.assignees.includes(filters.assignee)) && (!filters.watch || filters.watch.includes(task.id))).slice(0, Math.min(filters.limit ?? 50, 100)); return { ...current, board: { tasks }, cursor: Number(this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM coordination_events WHERE workspace = ?").get(workspace).id) }; }
  async thread(workspace, taskId, cursor = 0, limit = 50) { const current = this.#current(workspace); if (!current.board.tasks[taskId]) throw new Error("task not found"); return { revision: current.revision, task: current.board.tasks[taskId], comments: (current.board.comments[taskId] ?? []).filter((item) => item.id > cursor).slice(0, Math.min(limit, 100)) }; }
  async eventsSince(workspace, cursor = 0, filters = {}) { this.#ensure(workspace); return this.db.prepare("SELECT * FROM coordination_events WHERE workspace = ? AND id > ? ORDER BY id ASC LIMIT 100").all(workspace, cursor).filter((event) => !filters.actor || event.actor === filters.actor || event.type === "mention" || event.type === "claim_expired").map((event) => ({ cursor: event.id, taskId: event.task_id, type: event.type, revision: event.revision, actor: event.actor, timestamp: event.recorded_at, digest: event.digest })); }
  async apply(workspace, expectedRevision, idempotencyKey, actor, role, command) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !text(idempotencyKey, 256) || !text(actor, 128) || !roles.has(role)) throw new Error("invalid coordination mutation precondition");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const cached = this.db.prepare("SELECT response FROM coordination_idempotency WHERE workspace = ? AND idempotency_key = ?").get(workspace, idempotencyKey); if (cached) { this.db.exec("COMMIT"); return parse(cached.response); }
      const current = this.#current(workspace); if (current.revision !== expectedRevision) throw new CoordinationConflict(current);
      const board = clone(current.board); const at = now(); let taskId; let type;
      if (command.type === "upsert_task") {
        if (!roles.has(role) || !["writer", "admin"].includes(role) || !text(command.task?.id, 128) || !text(command.task?.title, 256) || !statuses.has(command.task?.status)) throw new Error("board write is not permitted or invalid");
        taskId = command.task.id; const previous = board.tasks[taskId]; if (previous?.revision !== undefined && command.task.revision !== previous.revision) throw new CoordinationConflict(current);
        board.tasks[taskId] = { id: taskId, title: command.task.title, description: command.task.description ?? "", status: command.task.status, priority: command.task.priority ?? "normal", labels: Array.isArray(command.task.labels) ? command.task.labels.slice(0, 20) : [], assignees: Array.isArray(command.task.assignees) ? command.task.assignees.slice(0, 10) : [], lifecycleTaskId: command.task.lifecycleTaskId, artifactLinks: Array.isArray(command.task.artifactLinks) ? command.task.artifactLinks.slice(0, 10) : [], claim: previous?.claim, revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? at, updatedAt: at }; type = "task";
      } else if (command.type === "add_comment") {
        if (!["commenter", "writer", "admin"].includes(role) || !board.tasks[command.taskId] || !intents.has(command.intent) || !text(command.body, 2000)) throw new Error("comment is not permitted or invalid"); denySensitive(command.body, "comment body"); taskId = command.taskId; const comments = board.comments[taskId] ?? []; const comment = { id: comments.length ? comments.at(-1).id + 1 : 1, author: actor, authorType: command.authorType === "human" ? "human" : "agent", intent: command.intent, mentions: Array.isArray(command.mentions) ? command.mentions.slice(0, 20) : [], body: command.body, createdAt: at }; comments.push(comment); board.comments[taskId] = comments; type = comment.mentions.length ? "mention" : "comment";
      } else if (command.type === "claim") {
        if (!["writer", "admin"].includes(role) || !board.tasks[command.taskId] || !Number.isInteger(command.leaseMs) || command.leaseMs < 60000 || command.leaseMs > 3600000) throw new Error("claim is not permitted or invalid"); taskId = command.taskId; const task = board.tasks[taskId]; if (task.claim && Date.parse(task.claim.expiresAt) > Date.now() && task.claim.actor !== actor) throw new Error("claim is held by another actor"); task.claim = { actor, expiresAt: new Date(Date.now() + command.leaseMs).toISOString() }; task.revision += 1; task.updatedAt = at; type = "claim";
      } else throw new Error("unsupported coordination command");
      const revision = current.revision + 1; const response = { workspace, revision, board: { tasks: Object.values(board.tasks) }, updatedAt: at };
      this.db.prepare("UPDATE coordination_workspaces SET revision = ?, board = ?, updated_at = ? WHERE workspace = ?").run(revision, encode(board), at, workspace);
      this.db.prepare("INSERT INTO coordination_events (workspace, task_id, type, revision, actor, digest, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(workspace, taskId, type, revision, actor, `${type}:${taskId}:${revision}`, at);
      this.db.prepare("INSERT INTO coordination_idempotency VALUES (?, ?, ?)").run(workspace, idempotencyKey, encode(response)); this.db.exec("COMMIT"); return response;
    } catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }
  close() { this.db.close(); }
}

// PostgreSQL keeps the same projection contract.  Coordination writes lock one
// workspace row, matching SQLite's BEGIN IMMEDIATE semantics.
export class PostgresCoordinationRepository {
  constructor(connectionString = process.env.MCP_STATE_POSTGRES_URL) { if (!connectionString) throw new Error("MCP_STATE_POSTGRES_URL is required for PostgreSQL"); this.pool = new pg.Pool({ connectionString }); }
  async #init(client) { await client.query("CREATE TABLE IF NOT EXISTS coordination_workspaces (workspace TEXT PRIMARY KEY, revision BIGINT NOT NULL, board JSONB NOT NULL, updated_at TEXT NOT NULL)"); await client.query("CREATE TABLE IF NOT EXISTS coordination_events (id BIGSERIAL PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL, revision BIGINT NOT NULL, actor TEXT NOT NULL, digest TEXT NOT NULL, recorded_at TEXT NOT NULL)"); await client.query("CREATE TABLE IF NOT EXISTS coordination_idempotency (workspace TEXT NOT NULL, idempotency_key TEXT NOT NULL, response JSONB NOT NULL, PRIMARY KEY(workspace,idempotency_key))"); }
  async get(workspace, filters = {}) { const c = await this.pool.connect(); try { await this.#init(c); await c.query("INSERT INTO coordination_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING", [workspace,{tasks:{},comments:{}},now()]); const row=(await c.query("SELECT * FROM coordination_workspaces WHERE workspace=$1",[workspace])).rows[0]; return { workspace, revision:Number(row.revision), board:{tasks:Object.values(row.board.tasks).filter((t)=>!filters.assignee||t.assignees.includes(filters.assignee)).slice(0,Math.min(filters.limit??50,100))}, updatedAt:row.updated_at }; } finally { c.release(); } }
  async eventsSince(workspace,cursor=0,filters={}) { const c=await this.pool.connect(); try { await this.#init(c); return (await c.query("SELECT * FROM coordination_events WHERE workspace=$1 AND id>$2 ORDER BY id LIMIT 100",[workspace,cursor])).rows.filter((e)=>!filters.actor||e.actor===filters.actor||e.type==="mention").map((e)=>({cursor:Number(e.id),taskId:e.task_id,type:e.type,revision:Number(e.revision),actor:e.actor,timestamp:e.recorded_at,digest:e.digest})); } finally { c.release(); } }
  async thread(workspace,taskId,cursor=0,limit=50) { const state=await this.get(workspace); const c=await this.pool.connect(); try { const row=(await c.query("SELECT board FROM coordination_workspaces WHERE workspace=$1",[workspace])).rows[0]; if(!row.board.tasks[taskId]) throw new Error("task not found"); return {revision:state.revision,task:row.board.tasks[taskId],comments:(row.board.comments[taskId]??[]).filter((x)=>x.id>cursor).slice(0,Math.min(limit,100))}; } finally { c.release(); } }
  async apply(workspace,expectedRevision,idempotencyKey,actor,role,command) { if(!Number.isInteger(expectedRevision)||!text(idempotencyKey,256)||!text(actor,128)||!roles.has(role)) throw new Error("invalid coordination mutation precondition"); const c=await this.pool.connect(); try { await this.#init(c); await c.query("BEGIN"); await c.query("INSERT INTO coordination_workspaces VALUES ($1,0,$2,$3) ON CONFLICT DO NOTHING",[workspace,{tasks:{},comments:{}},now()]); const cached=(await c.query("SELECT response FROM coordination_idempotency WHERE workspace=$1 AND idempotency_key=$2",[workspace,idempotencyKey])).rows[0]; if(cached){await c.query("COMMIT");return cached.response;} const row=(await c.query("SELECT * FROM coordination_workspaces WHERE workspace=$1 FOR UPDATE",[workspace])).rows[0]; const current={workspace,revision:Number(row.revision),board:row.board}; if(current.revision!==expectedRevision) throw new CoordinationConflict(current); const bridge=new SqliteCoordinationRepository(":memory:"); try { await bridge.get(workspace); bridge.db.prepare("UPDATE coordination_workspaces SET revision=?,board=? WHERE workspace=?").run(current.revision,encode(current.board),workspace); const response=await bridge.apply(workspace,expectedRevision,idempotencyKey,actor,role,command); const next=parse(bridge.db.prepare("SELECT board FROM coordination_workspaces WHERE workspace=?").get(workspace).board); const event=(await bridge.eventsSince(workspace,0)).at(-1); await c.query("UPDATE coordination_workspaces SET revision=$1,board=$2,updated_at=$3 WHERE workspace=$4",[response.revision,next,response.updatedAt,workspace]); await c.query("INSERT INTO coordination_events (workspace,task_id,type,revision,actor,digest,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",[workspace,event.taskId,event.type,response.revision,actor,event.digest,response.updatedAt]); await c.query("INSERT INTO coordination_idempotency VALUES ($1,$2,$3)",[workspace,idempotencyKey,response]); await c.query("COMMIT"); return response; } finally { bridge.close(); } } catch(error){try{await c.query("ROLLBACK");}catch{} throw error;} finally{c.release();} }
  async close(){await this.pool.end();}
}

export const createCoordinationRepository = () => process.env.MCP_STATE_DATABASE === "postgres" ? new PostgresCoordinationRepository() : new SqliteCoordinationRepository();
