import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readyTaskItems, nextAction } from "../../src/state.js";
import type { TaskState, WorkflowState } from "../../src/model.js";
const featureStorePath = new URL("../../assets/.agents/aidlc/scripts/lib/feature-store.mjs", import.meta.url).href;

const task = (id: string): TaskState => ({
  id, title: id, type: "feature", phase: "build", gate: "G2_codereview", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {}, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
});

test("item DAG exposes only ready work and blocks premature completion", () => {
  const current = task("one");
  current.tasks = [{ id: "A", label: "A", status: "todo" }, { id: "B", label: "B", status: "todo", dependsOn: ["A"] }];
  assert.deepEqual(readyTaskItems(current), { ready: ["A"], blocked: [{ id: "B", waitingOn: ["A"] }] });
  assert.equal(nextAction(current).itemId, "A");
  current.tasks[1].status = "done";
  assert.throws(() => readyTaskItems(current), /incomplete prerequisites/);
  current.tasks[1].status = "todo";
  current.tasks[0].dependsOn = ["B"];
  assert.throws(() => readyTaskItems(current), /Cyclic execution dependency/);
});

test("feature manifest rejects missing/cyclic links and derives ready tasks", async () => {
  const { loadFeature, readyFeatureTasks, saveFeature } = await import(featureStorePath);
  const root = mkdtempSync(join(tmpdir(), "aidlc-feature-"));
  const first = task("first"); const second = task("second");
  const state: WorkflowState = { schemaVersion: 4, tasks: { first, second }, archive: {} };
  try {
    const feature = { schemaVersion: 1, id: "feature", integrationBranch: "feature/main", tasks: [{ id: "first", dependsOn: [] }, { id: "second", dependsOn: ["first"] }] };
    saveFeature(root, feature, state);
    assert.deepEqual(loadFeature(root, "feature", state), feature);
    assert.deepEqual(readyFeatureTasks(feature, state).ready.map((item: { id: string }) => item.id), ["first"]);
    first.phase = "done"; first.gate = "none"; first.status = "done";
    assert.deepEqual(readyFeatureTasks(feature, state).ready.map((item: { id: string }) => item.id), ["second"]);
    feature.tasks[0].dependsOn = ["second"];
    assert.throws(() => saveFeature(root, feature, state), /Cyclic feature dependency/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planner dispatches independent ready items and reconciles claims", async () => {
  const plannerPath = new URL("../../assets/.agents/aidlc/scripts/lib/loop-planner.mjs", import.meta.url).href;
  const { planLoop } = await import(plannerPath);
  const current = task("one");
  current.tasks = [
    { id: "A", label: "A", status: "todo", ownedPaths: ["src/a.ts"] },
    { id: "B", label: "B", status: "todo", ownedPaths: ["src/b.ts"] },
    { id: "C", label: "C", status: "todo", dependsOn: ["A", "B"] }
  ];
  const first = planLoop({ task: current });
  assert.equal(first.classification, "dispatch");
  assert.deepEqual(first.readyItems, ["A", "B"]);
  const busy = planLoop({ task: current, assignments: [
    { taskId: "one", itemId: "A", state: "leased" },
    { taskId: "one", itemId: "B", state: "uncertain" }
  ] });
  assert.equal(busy.classification, "reconcile");
  assert.deepEqual(busy.readyItems, []);
});

test("installed CLI creates a feature and reports dependency-ready items", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-feature-cli-"));
  const script = fileURLToPath(new URL("../../assets/.agents/aidlc/scripts/state.mjs", import.meta.url));
  mkdirSync(join(root, ".agents/aidlc"), { recursive: true });
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [script, ...args, "--root", root], { encoding: "utf8" }));
  try {
    run("feature", "create", "checkout", "--branch", "feature/checkout");
    run("task", "create", "api", "--title", "API", "--feature", "checkout");
    run("task", "create", "ui", "--title", "UI", "--feature", "checkout");
    run("task", "item", "api", "A", "--status", "todo", "--owns", "src/a.ts");
    run("task", "item", "api", "B", "--status", "todo", "--depends-on", "A", "--owns", "src/b.ts");
    assert.deepEqual(run("task", "ready", "api").result.ready, ["A"]);
    assert.deepEqual(run("feature", "ready", "checkout").result.ready.map((item: { id: string }) => item.id), ["api", "ui"]);
    const rejected = spawnSync(process.execPath, [script, "task", "item", "api", "B", "--status", "done", "--root", root], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /incomplete prerequisites/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet environment rejects local lifecycle commands", () => {
  const script = fileURLToPath(new URL("../../assets/.agents/aidlc/scripts/state.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "task", "list"], { encoding: "utf8", env: { ...process.env, AIDLC_FLEET_URL: "https://fleet.example/mcp" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Fleet authority is configured/);
});
