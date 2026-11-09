/**
 * AI-DLC unified SQLite state store — embedded backend (canonical persistence).
 *
 * One local SQLite database per project (`.agents/data/state/aidlc.db`),
 * JSON-in-SQLite: a single row per workspace holding the full validated
 * `WorkflowState` JSON, mirroring the coordination service repository
 * (`state_workspaces`). WAL + `busy_timeout` let multiple processes read
 * concurrently while the existing state lock serializes writes.
 *
 * The JSON files under `.agents/data/state/` remain as commit-friendly
 * checkpoint projections for git recovery (see `store.mjs`); this module is
 * pure persistence and performs no lifecycle validation.
 *
 * Requires Node.js >= 24 (`node:sqlite` DatabaseSync, stable, no stderr
 * warnings — the workflow command output contract requires a clean stderr).
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const dbPathRelative = ".agents/data/state/aidlc.db";
export const workspaceKey = "local";

export const sqliteDbPath = (root) => join(resolve(root), dbPathRelative);

const schema = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state_workspaces (
    workspace TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archive_records (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    digest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS features (
    id TEXT PRIMARY KEY,
    manifest TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const parseRow = (content, label) => {
  try { return JSON.parse(content); }
  catch { throw new Error(`${label} is corrupted or unreadable: restore it from git history or the archive records`); }
};

const connections = new Map();

/** Opens (creating if needed) the project state database with WAL + busy timeout. */
export const openStateDb = (root) => {
  const path = sqliteDbPath(root);
  const existing = connections.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout must be set before any statement that can contend with other
  // processes (including journal_mode on a fresh or mid-checkpoint database).
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schema);
  connections.set(path, db);
  return db;
};

export const dbMeta = (db, key) => db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;

export const setDbMeta = (db, key, value) => {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

export const dbHasState = (db, workspace = workspaceKey) => Boolean(db.prepare("SELECT 1 FROM state_workspaces WHERE workspace = ?").get(workspace));

/** Returns the stored raw state value, or `undefined` when no row exists yet. */
export const loadStateFromDb = (db, workspace = workspaceKey) => {
  const row = db.prepare("SELECT state FROM state_workspaces WHERE workspace = ?").get(workspace);
  return row ? parseRow(row.state, "AI-DLC state database row") : undefined;
};

export const saveStateToDb = (db, state, workspace = workspaceKey) => {
  db.prepare("INSERT INTO state_workspaces (workspace, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
    .run(workspace, JSON.stringify(state), new Date().toISOString());
};

/** Digest-verified archive record read; `undefined` when the record is absent. */
export const loadArchiveFromDb = (db, id, expectedDigest) => {
  const row = db.prepare("SELECT content, digest FROM archive_records WHERE id = ?").get(id);
  if (!row) return undefined;
  if (row.digest !== expectedDigest) throw new Error(`Archived task digest mismatch: ${id}`);
  return row.content;
};

export const saveArchiveToDb = (db, id, content, digest) => {
  db.prepare("INSERT INTO archive_records (id, content, digest, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, digest = excluded.digest, updated_at = excluded.updated_at")
    .run(id, content, digest, new Date().toISOString());
};

export const loadFeatureFromDb = (db, id) => {
  const row = db.prepare("SELECT manifest FROM features WHERE id = ?").get(id);
  return row ? parseRow(row.manifest, `Feature manifest database row ${id}`) : undefined;
};

export const saveFeatureToDb = (db, id, manifest) => {
  db.prepare("INSERT INTO features (id, manifest, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET manifest = excluded.manifest, updated_at = excluded.updated_at")
    .run(id, JSON.stringify(manifest), new Date().toISOString());
};

export const listFeaturesFromDb = (db) => db.prepare("SELECT id, manifest FROM features ORDER BY id").all().map((row) => ({ id: row.id, manifest: parseRow(row.manifest, `Feature manifest database row ${row.id}`) }));
