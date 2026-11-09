import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TaskState } from "../../src/model.js";
import { loadState, loadTask, saveState, statePath } from "../../src/state.js";

const seed = (): TaskState => {
  const now = new Date().toISOString();
  return { id: "sqlite-task", title: "SQLite task", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "vi", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/sqlite-task/intent.md" }, decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now };
};
const fixture = (withJson = true) => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-sqlite-store-"));
  mkdirSync(join(root, ".agents/data/state"), { recursive: true });
  if (withJson) {
    const task = seed();
    writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), `${JSON.stringify({ schemaVersion: 4, tasks: { [task.id]: task }, archive: {} }, null, 2)}\n`);
  }
  return root;
};

test("lazy one-time JSON import seeds the database and DB-first reads ignore a missing checkpoint", () => {
  const root = fixture();
  try {
    const state = loadState(root);
    assert.equal(state.tasks["sqlite-task"]!.id, "sqlite-task");
    const dbPath = join(root, ".agents/data/state/aidlc.db");
    assert.ok(existsSync(dbPath));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'json_import'").get() !== undefined, true);
    assert.equal(db.prepare("SELECT 1 FROM state_workspaces WHERE workspace = 'local'").get() !== undefined, true);
    db.close();
    // DB-first: removing the checkpoint projection changes nothing.
    rmSync(statePath(root));
    const again = loadState(root);
    assert.equal(again.tasks["sqlite-task"]!.id, "sqlite-task");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("saveState persists to the DB and regenerates the committed checkpoint projection", () => {
  const root = fixture();
  try {
    const state = loadState(root);
    state.tasks["sqlite-task"]!.title = "Renamed via DB";
    saveState(root, state);
    assert.ok(existsSync(statePath(root)));
    assert.equal(JSON.parse(readFileSync(statePath(root), "utf8")).tasks["sqlite-task"].title, "Renamed via DB");
    assert.equal(loadState(root).tasks["sqlite-task"]!.title, "Renamed via DB");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("archive records live in the DB, stay digest-verified, and survive checkpoint removal", () => {
  const root = fixture();
  try {
    const state = loadState(root);
    const done: TaskState = { ...seed(), id: "sqlite-done", phase: "done", gate: "none", status: "done", updatedAt: "2026-11-08T00:00:01.000Z" };
    state.tasks["sqlite-done"] = done;
    const archived = saveState(root, state);
    assert.deepEqual(archived, ["sqlite-done"]);
    const after = loadState(root);
    assert.equal(after.tasks["sqlite-done"], undefined);
    assert.ok(after.archive!["sqlite-done"]);
    rmSync(join(root, ".agents/data/state/archive/sqlite-done.json"));
    const loaded = loadTask(root, "sqlite-done", after);
    assert.equal(loaded!.id, "sqlite-done");
    assert.equal(loaded!.status, "done");
    // Content-level digest verification still protects the DB row.
    const db = new DatabaseSync(join(root, ".agents/data/state/aidlc.db"));
    db.prepare("UPDATE archive_records SET content = ? WHERE id = ?").run(JSON.stringify({ tampered: true }), "sqlite-done");
    db.close();
    assert.throws(() => loadTask(root, "sqlite-done", after), /digest mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an empty project starts empty without a database", () => {
  const root = fixture(false);
  try {
    const state = loadState(root);
    assert.equal(state.schemaVersion, 4);
    assert.deepEqual(state.tasks, {});
    assert.ok(!existsSync(join(root, ".agents/data/state/aidlc.db")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
