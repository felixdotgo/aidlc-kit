import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

test("isolated local facade requires workers and wires a build dispatcher into the runner", async () => {
  const { root } = await fixture();
  try {
    const { createIsolatedLocalSupervisor } = await load();
    assert.throws(() => createIsolatedLocalSupervisor({ root, taskId: "task-a", agent: "codex" }), /worker providers/);
    assert.throws(() => createIsolatedLocalSupervisor({ root, taskId: "task-a", agent: "codex", workers: { "worker-a": "gemini" } }), /invalid local worker/);
    let sawDispatcher = false;
    const instance = createIsolatedLocalSupervisor({ root, taskId: "task-a", agent: "codex", workers: { "worker-a": "codex" }, pollMs: 1, preflight: false,
      runner: async (args: any) => { sawDispatcher = typeof args.dispatchBuild === "function"; return { status: "blocked", taskId: "task-a", reason: "test stop" }; }
    });
    const result = await instance.start();
    assert.equal(result.status, "blocked"); assert.equal(sawDispatcher, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

type Item = { id: string; ownedPaths?: string[]; dependsOn?: string[]; status?: string };
const buildTask = (items: Item[]) => ({ id: "build-task", title: "Build", type: "infra", phase: "build", gate: "G2_codereview", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/build-task/intent.md", design: ".agents/data/tasks/build-task/design.md", workplan: ".agents/data/tasks/build-task/workplan.md" }, decisions: [], tasks: items.map((item) => ({ label: item.id, area: "root", status: "todo", ...item })), evidence: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" });
const buildFixture = async (items: Item[]) => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-local-dispatch-"));
  cpSync(resolve("dist/assets/.agents/aidlc"), join(root, ".agents/aidlc"), { recursive: true });
  const fixtureStore: any = await import(pathToFileURL(resolve("dist/assets/.agents/aidlc/scripts/lib/store.mjs")).href);
  mkdirSync(join(root, ".agents/data/state"), { recursive: true });
  const writeTask = (task: any) => { const state = fixtureStore.emptyState(); state.tasks = { [task.id]: task }; state.archive = {}; fixtureStore.saveState(root, state); };
  const readTask = () => fixtureStore.loadState(root).tasks["build-task"];
  writeTask(buildTask(items));
  return { root, taskId: "build-task", writeTask, readTask };
};
const loadAssignments = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/assignment-store.mjs"));
const dispatchHooks = (batches: any[][]) => ({
  worktreesRoot: join(tmpdir(), "aidlc-unused-worktrees"), credentials: {},
  prompt: (_root: string, _taskId: string, itemId: string) => `Implement ${itemId}`,
  ensureImage: ({ provider }: any) => `image-${provider}`,
  runBatch: async ({ jobs }: any) => { batches.push(jobs); return []; },
  markDone: () => { throw new Error("no item completes in these tests"); }
});

test("batch planner defers overlapping and excess ready items instead of throwing", async () => {
  const { planLocalBuildBatch } = await load();
  const overlapping = planLocalBuildBatch({ taskId: "build-task", task: buildTask([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src/a.ts"] }]), workers: { w1: "codex", w2: "claude" } });
  assert.deepEqual(overlapping.jobs.map((job: any) => [job.itemId, job.workerId]), [["a", "w1"]]);
  assert.deepEqual(overlapping.deferred, [{ id: "b", reason: "overlaps a" }]);
  const excess = planLocalBuildBatch({ taskId: "build-task", task: buildTask([{ id: "a", ownedPaths: ["src/a"] }, { id: "b", ownedPaths: ["src/b"] }, { id: "c", ownedPaths: ["docs"] }]), workers: { w1: "codex", w2: "claude" } });
  assert.deepEqual(excess.jobs.map((job: any) => [job.itemId, job.workerId, job.agent]), [["a", "w1", "codex"], ["b", "w2", "claude"]]);
  assert.deepEqual(excess.deferred, [{ id: "c", reason: "capacity" }]);
  assert.throws(() => planLocalBuildBatch({ taskId: "build-task", task: buildTask([{ id: "a" }]), workers: { w1: "codex" } }), /Build item a requires an owned path scope/);
  assert.deepEqual(planLocalBuildBatch({ taskId: "build-task", task: buildTask([{ id: "a", ownedPaths: ["src"], status: "done" }]), workers: { w1: "codex" } }), { jobs: [], deferred: [] });
});

test("batch planner keeps unresolved assignment paths busy and names the blocking assignment", async () => {
  const { planLocalBuildBatch } = await load();
  const task = buildTask([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src/b.ts"] }, { id: "c", ownedPaths: ["docs"] }]);
  const assignments = [{ id: "asg-a", itemId: "a", ownedPaths: ["src"], state: "uncertain" }, { id: "asg-old", itemId: "c", ownedPaths: ["docs"], state: "released" }];
  const plan = planLocalBuildBatch({ taskId: "build-task", task, workers: { w1: "codex", w2: "codex" }, assignments });
  assert.deepEqual(plan.jobs.map((job: any) => job.itemId), ["c"]);
  assert.deepEqual(plan.deferred, [{ id: "a", reason: "unresolved assignment" }, { id: "b", reason: "busy path held by an active assignment" }]);
  const blocked = buildTask([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src/b.ts"] }]);
  assert.throws(() => planLocalBuildBatch({ taskId: "build-task", task: blocked, workers: { w1: "codex" }, assignments }), (error: any) => /Unresolved assignment asg-a \(uncertain\) for a holds src/.test(error.message) && /assignment\.mjs reconcile build-task/.test(error.message) && /assignment\.mjs release build-task/.test(error.message));
});

test("local dispatch runs only the non-overlapping first item and emits build_deferred", async () => {
  const { root, taskId, readTask } = await buildFixture([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src/a.ts"] }]);
  try {
    const { dispatchLocalBuild } = await load();
    const batches: any[][] = [], events: any[] = [];
    await dispatchLocalBuild({ root, taskId, task: readTask(), workers: { w1: "codex", w2: "codex" }, onEvent: (event: any) => { events.push(event); }, ...dispatchHooks(batches) });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0]!.map((job: any) => [job.itemId, job.workerId, job.prompt]), [["a", "w1", "Implement a"]]);
    assert.deepEqual(events.filter((event) => event.type === "build_deferred"), [{ type: "build_deferred", taskId, itemId: "b", reason: "overlaps a" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local dispatch forwards its live-log event sink to the worker batch", async () => {
  const { root, taskId, readTask } = await buildFixture([{ id: "a", ownedPaths: ["src"] }]);
  try {
    const { dispatchLocalBuild } = await load();
    const events: any[] = [];
    const onEvent = (event: any) => { events.push(event); };
    let forwarded: unknown;
    await dispatchLocalBuild({ root, taskId, task: readTask(), workers: { w1: "codex" }, onEvent, ...dispatchHooks([]), runBatch: async (input: any) => { forwarded = input.onEvent; await input.onEvent({ type: "worker_turn_start", taskId, actor: "w1", itemId: "a" }); return []; } });
    assert.equal(forwarded, onEvent);
    assert.deepEqual(events.filter((event) => event.type === "worker_turn_start"), [{ type: "worker_turn_start", taskId, actor: "w1", itemId: "a" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local dispatch reconciles a done item's reported assignment so its dependent can claim the same path", async () => {
  const { root, taskId, readTask, writeTask } = await buildFixture([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src"], dependsOn: ["a"] }]);
  try {
    const { dispatchLocalBuild } = await load(), assignmentStore = await loadAssignments();
    const claim = assignmentStore.claimLocalAssignment(root, { taskId, itemId: "a", workerId: "w1", ownedPaths: ["src"] });
    assignmentStore.reportLocalAssignment(root, taskId, claim.id, { changedPaths: ["src/a.ts"] });
    const task = readTask(); task.tasks[0].status = "done"; writeTask(task);
    const batches: any[][] = [];
    await dispatchLocalBuild({ root, taskId, task: readTask(), workers: { w1: "codex" }, ...dispatchHooks(batches) });
    assert.deepEqual(batches.map((jobs) => jobs.map((job: any) => job.itemId)), [["b"]]);
    assert.equal(assignmentStore.showLocalAssignments(root, taskId).assignments[0].state, "integrated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local dispatch refuses to auto-release an uncertain assignment of an unfinished item", async () => {
  const { root, taskId, readTask } = await buildFixture([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["src/b.ts"] }]);
  try {
    const { dispatchLocalBuild } = await load(), assignmentStore = await loadAssignments();
    const claim = assignmentStore.claimLocalAssignment(root, { taskId, itemId: "a", workerId: "w1", ownedPaths: ["src"] });
    const path = assignmentStore.assignmentPath(root, taskId), record = JSON.parse(readFileSync(path, "utf8"));
    record.assignments[0].leaseExpiresAt = "2020-01-01T00:00:00.000Z"; writeFileSync(path, JSON.stringify(record));
    const batches: any[][] = [];
    await assert.rejects(dispatchLocalBuild({ root, taskId, task: readTask(), workers: { w1: "codex", w2: "codex" }, ...dispatchHooks(batches) }), new RegExp(`Unresolved assignment ${claim.id} \\(uncertain\\) for a holds src \\[worker w1, expired or outcome unknown; needs reconcile, claim expires [^\\]]+\\];.*assignment\\.mjs reconcile.*assignment\\.mjs release ${taskId} ${claim.id}`));
    assert.equal(batches.length, 0);
    assert.equal(assignmentStore.showLocalAssignments(root, taskId).assignments[0].state, "uncertain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("local dispatch marks only integrated results done when the batch is partial", async () => {
  const { root, taskId, readTask } = await buildFixture([{ id: "a", ownedPaths: ["src"] }, { id: "b", ownedPaths: ["docs"] }]);
  try {
    const { dispatchLocalBuild } = await load();
    const done: string[] = [];
    const integrated = { assignmentId: "asg-a", itemId: "a", workerId: "w1", agent: "codex", baseCommit: "base", branch: "branch-a", commit: "c1", changedPaths: ["src/a.ts"], workspace: "/tmp/ws", integrationCommit: "i1" };
    await dispatchLocalBuild({
      root, taskId, task: readTask(), workers: { w1: "codex", w2: "claude" }, credentials: {}, worktreesRoot: join(tmpdir(), "aidlc-unused-worktrees"),
      prompt: (_root: string, _taskId: string, itemId: string) => `Implement ${itemId}`,
      ensureImage: ({ provider }: any) => `image-${provider}`,
      runBatch: async ({ jobs }: any) => { assert.deepEqual(jobs.map((job: any) => job.itemId), ["a", "b"]); return [integrated]; },
      markDone: (_root: string, _taskId: string, itemId: string) => { done.push(itemId); },
    });
    assert.deepEqual(done, ["a"], "only the integrated result is marked done");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
