import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-supervisor-run-local.mjs"));
const fixture = async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-local-supervised-"));
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
  const store: any = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/store.mjs"));
  const now = new Date().toISOString(), task = { id: "task-a", title: "Task A", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "vi", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/task-a/intent.md", design: ".agents/data/tasks/task-a/design.md", workplan: ".agents/data/tasks/task-a/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now };
  const state = store.emptyState(); state.tasks["task-a"] = task; store.saveState(root, state);
  const dir = join(root, ".agents/data/tasks/task-a"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
  return { root, store };
};

test("local facade uses verified preconditions, waits for human approval, and then resumes", async () => {
  const { root, store } = await fixture();
  try {
    const { createLocalLoopSupervisor } = await load();
    const calls: any[] = [], events: string[] = [];
    const instance = createLocalLoopSupervisor({ root, taskId: "task-a", agent: "codex", pollMs: 1, preflight: false,
      runner: async (args: any) => {
        calls.push(args);
        if (calls.length === 1) { const state = store.loadState(root); state.tasks["task-a"].status = "blocked_on_user"; store.saveState(root, state); return { status: "gate", taskId: "task-a", nextAction: { gate: "G0_confirm" }, gateView: "review" }; }
        return { status: "blocked", taskId: "task-a", reason: "test stop" };
      },
      onEvent: async (event: any) => {
        if (event.type !== "gate") return;
        events.push(event.type);
        const state = store.loadState(root); store.approveAndAdvance(root, state, "task-a", "G0_confirm", "human approved"); store.saveState(root, state);
      }
    });
    const result = await instance.start();
    assert.equal(result.status, "blocked"); assert.equal(calls.length, 2); assert.deepEqual(events, ["gate"]);
    assert.equal(calls[0].mode, "run"); assert.equal(calls[0].precondition.phase, "clarify");
    assert.equal(calls[1].mode, "resume"); assert.equal(calls[1].precondition.gate, "G0_confirm"); assert.equal(calls[1].precondition.phase, "plan");
    const status = await instance.status(); assert.equal(status.nextAction.classification, "run_phase");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("facade rejects remote authority and resume without an existing record", async () => {
  const { root } = await fixture();
  const prior = process.env.AIDLC_FLEET_URL;
  try {
    const { createLocalLoopSupervisor } = await load();
    process.env.AIDLC_FLEET_URL = "https://example.invalid/mcp";
    assert.throws(() => createLocalLoopSupervisor({ root, taskId: "task-a", agent: "codex" }), /Fleet authority/);
    delete process.env.AIDLC_FLEET_URL;
    const instance = createLocalLoopSupervisor({ root, taskId: "task-a", agent: "codex" });
    await assert.rejects(instance.resume(), /record missing/);
  } finally { if (prior === undefined) delete process.env.AIDLC_FLEET_URL; else process.env.AIDLC_FLEET_URL = prior; rmSync(root, { recursive: true, force: true }); }
});
