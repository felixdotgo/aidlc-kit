import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-supervisor-local.mjs"));
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-supervisor-local-"));
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
  const store: any = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/store.mjs"));
  const date = new Date().toISOString();
  const task = { id: "task-a", title: "Task A", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "vi", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/task-a/intent.md", design: ".agents/data/tasks/task-a/design.md", workplan: ".agents/data/tasks/task-a/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: date, updatedAt: date };
  const state = store.emptyState(); state.tasks["task-a"] = task; store.saveState(root, state);
  return { root, store };
};

test("local supervisor owns separate lock, performs CAS, and cannot block human approval", async () => {
  const { root, store } = await fixture();
  try {
    const { createLocalSupervisorAdapter } = await load();
    const adapter = createLocalSupervisorAdapter({ root, taskId: "task-a" });
    const scope = { taskId: "task-a", authority: "local" };
    const ownership = await adapter.acquireSupervisor(scope);
    const rival = createLocalSupervisorAdapter({ root, taskId: "task-a" });
    await assert.rejects(rival.acquireSupervisor(scope), /live supervisor/);
    const before = await adapter.readTask(scope); assert.equal(before.task.id, "task-a"); assert.equal(before.nextAction.classification, "run_phase");
    const value = { version: 1, taskId: "task-a", authority: "local", gate: "G0_confirm" };
    assert.equal(await adapter.loadCheckpoint(scope), null);
    await adapter.saveCheckpoint({ ...scope, checkpoint: value, previous: null });
    assert.deepEqual(await adapter.loadCheckpoint(scope), value);
    await assert.rejects(adapter.saveCheckpoint({ ...scope, checkpoint: value, previous: null }), /conflict/);
    await assert.rejects(adapter.clearCheckpoint({ ...scope, checkpoint: { ...value, gate: "G1_review" } }), /conflict/);
    const intentDir = join(root, ".agents/data/tasks/task-a"); mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    const lease: any = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lease.mjs"));
    assert.equal(lease.readLiveLease(root, "task-a"), null);
    const state = store.loadState(root); state.tasks["task-a"].status = "blocked_on_user";
    store.approveAndAdvance(root, state, "task-a", "G0_confirm", "human yes"); store.saveState(root, state);
    assert.equal((await adapter.readTask(scope)).task.phase, "plan");
    assert.match(readFileSync(join(root, ".agents/data/loop/task-a.supervisor.json"), "utf8"), /task-a/);
    await adapter.clearCheckpoint({ ...scope, checkpoint: value });
    await ownership.release();
    await assert.rejects(adapter.loadCheckpoint(scope), /ownership lost/);
    const nextOwner = await rival.acquireSupervisor(scope); await nextOwner.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local adapter rejects unsafe checkpoint links, foreign authority and replaced lock", async () => {
  const { root } = await fixture();
  try {
    const { createLocalSupervisorAdapter } = await load();
    const adapter = createLocalSupervisorAdapter({ root, taskId: "task-a" });
    const scope = { taskId: "task-a", authority: "local" };
    await assert.rejects(adapter.acquireSupervisor({ ...scope, authority: "fleet" }), /local authority/);
    const ownership = await adapter.acquireSupervisor(scope);
    const path = join(root, ".agents/data/loop/task-a.supervisor.json");
    symlinkSync(join(root, "outside"), path);
    await assert.rejects(adapter.loadCheckpoint(scope), /symlink/);
    const lease = join(root, ".agents/data/loop/task-a.supervisor.lease");
    writeFileSync(lease, JSON.stringify({ taskId: "task-a", pid: process.pid, token: "other" }));
    await assert.rejects(ownership.assertOwned(), /ownership lost/);
    await ownership.release();
    assert.equal(JSON.parse(readFileSync(lease, "utf8")).token, "other");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
