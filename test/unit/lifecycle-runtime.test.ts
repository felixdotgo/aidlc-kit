import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit, readManifest } from "../../src/installer.js";
import type { InitOptions } from "../../src/model.js";

const options = (root: string): InitOptions => ({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false });
const run = (root: string, script: string, args: string[], cwd = root): string => execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts", script), ...args], { cwd, encoding: "utf8" });
const runAsync = (root: string, script: string, args: string[]): Promise<void> => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, [join(root, ".agents/aidlc/scripts", script), ...args], { cwd: root });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.once("error", rejectRun);
  child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`state script exited ${code}: ${stderr}`)));
});

test("installed lifecycle scripts preserve every concurrent local mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-concurrent-"));
  try {
    applyPlan(root, planInit(options(root)));
    const ids = Array.from({ length: 16 }, (_, index) => `2026-lock-${String(index).padStart(2, "0")}`);
    for (const [index, id] of ids.entries()) {
      const priors = ids.slice(0, index);
      run(root, "state.mjs", ["task", "create", id, "--title", `Concurrent ${id}`, ...(priors.length ? ["--switch-from", priors.join(",")] : [])]);
    }
    await Promise.all(ids.map((id) => runAsync(root, "state.mjs", ["task", "item", id, "T1", "--status", "todo", "--label", `Concurrent item ${id}`])));
    const catalog = JSON.parse(run(root, "state.mjs", ["task", "list"]));
    assert.equal(catalog.result.total, ids.length);
    for (const id of ids) {
      const shown = JSON.parse(run(root, "state.mjs", ["task", "show", id])).result;
      assert.equal(shown.id, id);
      assert.equal(shown.tasks[0]?.id, "T1");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed lifecycle CLI parses strictly and resolves one canonical project root", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-argv-"));
  const outside = mkdtempSync(join(tmpdir(), "aidlc-runtime-outside-"));
  try {
    applyPlan(root, planInit(options(root)));
    const incompletePromotion = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "memory", "promote", "missing-provenance", "--summary", "x", "--guidance", "y"], { cwd: root, encoding: "utf8" });
    assert.notEqual(incompletePromotion.status, 0);
    assert.match(incompletePromotion.stderr, /--source-task/);
    const id = "2026-strict-argv";
    run(root, "state.mjs", ["--title=Strict argv", "--area=root", "task", "create", id]);
    const taskDir = join(root, ".agents/data/tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");

    assert.match(run(root, "gate-check.mjs", ["--gate=G0_confirm", id]), /GATE_OK/);
    run(root, "state.mjs", ["task", "status", id, "--status=blocked_on_user"]);
    assert.equal(JSON.parse(run(root, "gate-view.mjs", ["--format=json", id])).gate, "G0_confirm");
    assert.match(run(root, "context.mjs", ["--format=json", id]), /Strict argv/);
    run(root, "render.mjs", ["--all"]);
    assert.equal(existsSync(join(root, ".agents/data/state/.aidlc-state.lock")), false);

    run(root, "state.mjs", ["gate", "approve", id, "--gate=G0_confirm", "--source=human"]);
    run(root, "state.mjs", ["decision", "set", id, "D1", "--status=approved", "--resolution=keep me"]);
    run(root, "state.mjs", ["decision", "set", id, "D1", "--status", "approved"]);
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", id])).result.decisions[0].resolution, "keep me");
    run(root, "state.mjs", ["task", "item", id, "--status=todo", "item-one"]);
    run(root, "state.mjs", ["task", "item", id, "--status=done", "item-one"]);
    const parsedTask = JSON.parse(run(root, "state.mjs", ["task", "show", id]));
    assert.equal(parsedTask.result.tasks[0].id, "item-one");
    assert.equal(parsedTask.result.tasks[0].status, "done");

    const statePath = join(root, ".agents/data/state/aidlc-state.json");
    const before = readFileSync(statePath, "utf8");
    for (const args of [
      ["task", "create", "bad-unknown", "--title", "x", "--wat"],
      ["task", "create", "bad-missing", "--title", "--type", "bug"],
      ["task", "show", id, "surplus"],
      ["task", "show", id, "--status=active", "--status=done"]
    ]) {
      const invalid = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args], { cwd: root, encoding: "utf8" });
      assert.notEqual(invalid.status, 0);
      assert.equal(readFileSync(statePath, "utf8"), before);
    }

    const nested = join(root, "packages/example/src");
    mkdirSync(nested, { recursive: true });
    const nestedId = "2026-nested-root";
    const unacknowledged = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", nestedId, "--title", "Nested root"], { cwd: nested, encoding: "utf8" });
    assert.notEqual(unacknowledged.status, 0); assert.match(unacknowledged.stderr, /--switch-from 2026-strict-argv/);
    const wrongAcknowledgement = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", nestedId, "--title", "Nested root", "--switch-from", "missing-task"], { cwd: nested, encoding: "utf8" });
    assert.notEqual(wrongAcknowledgement.status, 0); assert.match(wrongAcknowledgement.stderr, /must name only actionable task/);
    run(root, "state.mjs", ["task", "create", nestedId, "--title", "Nested root", "--switch-from", id], nested);
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", nestedId])).result.id, nestedId);
    const marker = JSON.parse(run(root, "state.mjs", ["task", "show", id])).result.evidence.at(-1);
    assert.equal(marker.kind, "diagnostic");
    assert.match(marker.detail, new RegExp(`resume with task next ${id}`));
    assert.equal(existsSync(join(nested, ".agents")), false);

    const multiAreaId = "2026-multi-area";
    run(root, "state.mjs", ["task", "create", multiAreaId, "--title", "Multi area", "--area", "root,docs", "--switch-from", `${id},${nestedId}`]);
    const missingArea = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "evidence", "add", multiAreaId, "--kind", "test", "--result", "fail"], { cwd: root, encoding: "utf8" });
    assert.notEqual(missingArea.status, 0); assert.match(missingArea.stderr, /requires --area/);
    const unknownArea = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "evidence", "add", multiAreaId, "--kind", "test", "--area", "root-2", "--result", "fail"], { cwd: root, encoding: "utf8" });
    assert.notEqual(unknownArea.status, 0); assert.match(unknownArea.stderr, /must belong to task\.areas/);
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", multiAreaId])).result.evidence.length, 0);

    assert.match(run(root, "task-next.mjs", ["--root", root, id], outside), /run_phase|await_user/);
    const noMarker = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", "bad-root", "--title", "x"], { cwd: outside, encoding: "utf8" });
    assert.notEqual(noMarker.status, 0); assert.match(noMarker.stderr, /Project root not found/);
    const invalidRender = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/render.mjs")], { cwd: outside, encoding: "utf8" });
    assert.notEqual(invalidRender.status, 0); assert.match(invalidRender.stderr, /either <task-id> or --all/);
    assert.equal(existsSync(join(outside, ".agents")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("installed local scripts drive the lifecycle without an aidlc executable or BOARD", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-"));
  try {
    applyPlan(root, planInit(options(root)));
    const id = "2026-0001-runtime";
    run(root, "state.mjs", ["task", "create", id, "--title", "Runtime smoke", "--type", "bug", "--language", "en", "--area", "root"]);
    const taskDir = join(root, ".agents/data/tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    writeFileSync(join(taskDir, "design.md"), "# Design\n\n## 🧩 Solution per affected area\nx\n## 📌 Spec traceability\nx\n## 🔗 Cross-service contracts\nnone\n## ⚠️ Risks / edge cases\nnone\n");

    assert.match(run(root, "gate-check.mjs", [id, "--gate", "G0_confirm"]), /GATE_OK/);
    run(root, "state.mjs", ["task", "status", id, "--status", "blocked_on_user"]);
    const g0View = run(root, "gate-view.mjs", [id]);
    assert.match(g0View, /^> \[!IMPORTANT\]/); assert.equal(g0View.match(/ACTION REQUIRED/g)?.length, 1);
    const g0 = JSON.parse(run(root, "state.mjs", ["gate", "approve", id, "--gate", "G0_confirm", "--source", "human approval"]));
    assert.equal(g0.nextAction.classification, "run_phase");
    const g0Retry = JSON.parse(run(root, "state.mjs", ["gate", "approve", id, "--gate", "G0_confirm", "--source", "retry"]));
    assert.equal(g0Retry.result.idempotent, true);
    run(root, "state.mjs", ["decision", "set", id, "D1", "--status", "approved", "--label", "Use local scripts", "--resolution", "approved choice"]);
    run(root, "state.mjs", ["task", "item", id, "T1", "--status", "todo", "--label", "Implement runtime"]);
    run(root, "state.mjs", ["task", "item", id, "T2", "--status", "todo", "--label", "Verify continuation"]);
    run(root, "state.mjs", ["task", "status", id, "--status", "blocked_on_user"]);
    const g1 = JSON.parse(run(root, "state.mjs", ["gate", "approve", id, "--gate", "G1_review", "--source", "human approval"]));
    assert.equal(g1.result.task.phase, "build");
    const forgedApproval = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "evidence", "add", id, "--kind", "approval", "--gate", "G2_codereview", "--result", "pass"], { cwd: root, encoding: "utf8" });
    assert.notEqual(forgedApproval.status, 0); assert.match(forgedApproval.stderr, /approvals use gate approve/);
    const rawTransition = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "transition", id, "--to", "build"], { cwd: root, encoding: "utf8" });
    assert.notEqual(rawTransition.status, 0); assert.match(rawTransition.stderr, /--mode audited/);

    const blocked = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/gate-check.mjs"), id, "--gate", "G2_codereview"], { cwd: root, encoding: "utf8" });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /TASKS_OPEN/);
    const prematureItems = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "blocked_on_user"], { cwd: root, encoding: "utf8" });
    assert.notEqual(prematureItems.status, 0); assert.match(prematureItems.stderr, /TASKS_OPEN/);
    const firstItem = JSON.parse(run(root, "state.mjs", ["task", "item", id, "T1", "--status", "done"]));
    assert.equal(firstItem.nextAction.itemId, "T2"); assert.equal(firstItem.nextAction.remainingItems, 1);
    const secondItem = JSON.parse(run(root, "state.mjs", ["task", "item", id, "T2", "--status", "done"]));
    assert.equal(secondItem.nextAction.classification, "run_phase"); assert.equal(secondItem.nextAction.remainingItems, 0);
    const prematureEvidence = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "blocked_on_user"], { cwd: root, encoding: "utf8" });
    assert.notEqual(prematureEvidence.status, 0); assert.match(prematureEvidence.stderr, /VERIFY_EVIDENCE/);
    const evidence = JSON.parse(run(root, "state.mjs", ["evidence", "add", id, "--kind", "test", "--area", "root", "--result", "pass", "--source", "runtime smoke", "--detail", "label with spaces"]));
    assert.equal(evidence.nextAction.classification, "run_phase");
    run(root, "state.mjs", ["evidence", "add", id, "--kind", "review", "--result", "pass", "--source", "adversarial review"]);

    const barePause = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "paused"], { cwd: root, encoding: "utf8" });
    assert.notEqual(barePause.status, 0); assert.match(barePause.stderr, /Pausing an active task requires --mode audited/);
    const activePause = JSON.parse(run(root, "state.mjs", ["task", "status", id, "--status", "paused", "--mode", "audited", "--reason", "waiting on other work", "--source", "user pause request"]));
    assert.equal(activePause.nextAction.classification, "blocked");
    assert.match(run(root, "state.mjs", ["task", "show", id]), /Paused while active: waiting on other work/);
    run(root, "state.mjs", ["task", "status", id, "--status", "paused"]);
    run(root, "state.mjs", ["task", "status", id, "--status", "active"]);

    assert.match(run(root, "gate-check.mjs", [id, "--gate", "G2_codereview"]), /GATE_OK/);
    run(root, "state.mjs", ["evidence", "add", id, "--kind", "test", "--area", "root", "--result", "fail", "--source", "new regression"]);
    const latestFail = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/gate-check.mjs"), id, "--gate", "G2_codereview"], { cwd: root, encoding: "utf8" });
    assert.equal(latestFail.status, 1); assert.match(latestFail.stdout, /root/);
    run(root, "state.mjs", ["evidence", "add", id, "--kind", "lint", "--area", "root", "--result", "pass", "--source", "repaired"]);
    const independentFailure = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "blocked_on_user"], { cwd: root, encoding: "utf8" });
    assert.notEqual(independentFailure.status, 0); assert.match(independentFailure.stderr, /VERIFY_EVIDENCE/);
    run(root, "state.mjs", ["evidence", "add", id, "--kind", "test", "--area", "root", "--result", "pass", "--source", "repaired test"]);
    const prepared = JSON.parse(run(root, "state.mjs", ["task", "status", id, "--status", "blocked_on_user"]));
    assert.equal(prepared.nextAction.classification, "await_user");
    const pauseWait = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "paused"], { cwd: root, encoding: "utf8" });
    assert.notEqual(pauseWait.status, 0); assert.match(pauseWait.stderr, /--mode audited/);
    const auditedPause = JSON.parse(run(root, "state.mjs", ["task", "status", id, "--status", "paused", "--mode", "audited", "--reason", "pause for user changes", "--source", "user pause request"]));
    assert.equal(auditedPause.nextAction.classification, "blocked");
    assert.match(run(root, "state.mjs", ["task", "show", id]), /Cancelled gate wait at G2_codereview: pause for user changes/);
    run(root, "state.mjs", ["task", "status", id, "--status", "active"]);
    run(root, "state.mjs", ["task", "status", id, "--status", "blocked_on_user"]);
    const cancelWait = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "active"], { cwd: root, encoding: "utf8" });
    assert.notEqual(cancelWait.status, 0); assert.match(cancelWait.stderr, /--mode audited/);
    const auditedCancel = JSON.parse(run(root, "state.mjs", ["task", "status", id, "--status", "active", "--mode", "audited", "--reason", "user requested changes", "--source", "user rejection message"]));
    assert.equal(auditedCancel.nextAction.classification, "run_phase");
    assert.match(run(root, "state.mjs", ["task", "show", id]), /Cancelled gate wait at G2_codereview/);
    const reblocked = JSON.parse(run(root, "state.mjs", ["task", "status", id, "--status", "blocked_on_user"]));
    assert.equal(reblocked.nextAction.classification, "await_user");
    const next = JSON.parse(run(root, "state.mjs", ["task", "next", id]));
    assert.equal(next.nextAction.classification, "await_user");
    assert.match(run(root, "gate-view.mjs", [id, "--format", "plain"]), /^\[IMPORTANT\].*Review step · Review implementation/);
    assert.equal(JSON.parse(run(root, "gate-view.mjs", [id, "--format", "json"])).gate, "G2_codereview");
    assert.match(run(root, "context.mjs", [id, "--phase", "build", "--format", "json"]), /Runtime smoke/);
    assert.match(run(root, "state.mjs", ["task", "show", id]), /label with spaces/);
    assert.match(run(root, "state.mjs", ["task", "show", id]), /blocked_on_user/);
    assert.equal(existsSync(join(root, ".agents/data/state/BOARD.md")), false);
    assert.ok(readManifest(root)?.files[".agents/aidlc/scripts/state.mjs"]);
    assert.doesNotMatch(readFileSync(join(root, "AGENTS.md"), "utf8"), /aidlc context/);

    const g2 = JSON.parse(run(root, "state.mjs", ["gate", "approve", id, "--gate", "G2_codereview", "--source", "human approval"]));
    assert.equal(g2.result.task.phase, "wrap"); assert.equal(g2.nextAction.classification, "run_phase");
    const wrapWait = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", id, "--status", "blocked_on_user"], { cwd: root, encoding: "utf8" });
    assert.notEqual(wrapWait.status, 0); assert.match(wrapWait.stderr, /no human gate/);
    run(root, "state.mjs", ["lesson", "record", id, "L1", "--area", "root", "--summary", "Use installed lifecycle commands", "--prevention", "Do not hand-edit state", "--example", "state.mjs task show", "--promotion", "orchestrator", "--source", "runtime smoke"]);
    assert.equal(JSON.parse(run(root, "state.mjs", ["lesson", "search", "--query", "lifecycle", "--area", "root"])).result.length, 1);
    const bareArchive = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "archive", id], { cwd: root, encoding: "utf8" });
    assert.notEqual(bareArchive.status, 0); assert.match(bareArchive.stderr, /--reason is required/);
    run(root, "state.mjs", ["task", "archive", id, "--reason", "runtime smoke complete", "--source", "human wrap"]);
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "next", id])).nextAction.classification, "complete");
    assert.match(run(root, "state.mjs", ["task", "show", id]), /Archive to done: runtime smoke complete/);
    const compact = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    assert.equal(compact.schemaVersion, 4); assert.equal(compact.tasks[id], undefined); assert.equal(compact.archive[id].lessonCount, 1);
    assert.ok(existsSync(join(root, ".agents/data/state/archive", `${id}.json`)));
    assert.match(run(root, "state.mjs", ["task", "show", id]), /Use installed lifecycle commands/);
    const catalog = JSON.parse(run(root, "state.mjs", ["task", "show", "--include-archive"]));
    assert.equal(catalog.result.items.length, 1); assert.equal(catalog.result.items[0].source, "archive");

    const oldCli = spawnSync(process.execPath, [resolve("dist/src/cli.js"), "task", "show"], { encoding: "utf8" });
    assert.equal(oldCli.status, 1);
    assert.match(oldCli.stderr, /Unknown command: task/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed runtime supports audited handoff, reopen, close, and atomic supersede", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-handoff-"));
  try {
    applyPlan(root, planInit(options(root)));
    const predecessor = "2026-0002-predecessor"; const successor = "2026-0003-successor";
    run(root, "state.mjs", ["task", "create", predecessor, "--title", "Blocked release", "--type", "bug", "--language", "en", "--area", "root"]);
    const taskDir = join(root, ".agents/data/tasks", predecessor); mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    writeFileSync(join(taskDir, "design.md"), "# Design\n\n## 🧩 Solution per affected area\nx\n## 📌 Spec traceability\nx\n## 🔗 Cross-service contracts\nnone\n## ⚠️ Risks / edge cases\nnone\n");
    run(root, "state.mjs", ["task", "status", predecessor, "--status", "blocked_on_user"]);
    run(root, "state.mjs", ["gate", "approve", predecessor, "--gate", "G0_confirm", "--source", "human"]);
    run(root, "state.mjs", ["decision", "set", predecessor, "D1", "--status", "approved", "--label", "Lifecycle"]);
    run(root, "state.mjs", ["task", "item", predecessor, "T1", "--status", "todo", "--label", "Rebuild after reopen"]);
    run(root, "state.mjs", ["task", "status", predecessor, "--status", "blocked_on_user"]);
    run(root, "state.mjs", ["gate", "approve", predecessor, "--gate", "G1_review", "--source", "human"]);
    run(root, "state.mjs", ["task", "item", predecessor, "T1", "--status", "done"]);

    const handoff = JSON.parse(run(root, "state.mjs", ["task", "handoff", predecessor, "--kind", "release_failed", "--reason", "provider evidence failed", "--source", "human"]));
    assert.equal(handoff.nextAction.classification, "blocked"); assert.equal(handoff.nextAction.actions.some((item: { id: string }) => item.id === "reopen_g1"), true);
    const reopened = JSON.parse(run(root, "state.mjs", ["task", "reopen", predecessor, "--to", "plan", "--reason", "new design", "--source", "human"]));
    assert.equal(reopened.result.task.phase, "plan"); assert.equal(reopened.result.task.evidence.at(-1).result, "fail");
    assert.equal(reopened.result.task.tasks.find((item: { id: string }) => item.id === "T1").status, "todo");

    run(root, "state.mjs", ["task", "handoff", predecessor, "--kind", "structural_change", "--reason", "use successor", "--source", "human"]);
    run(root, "state.mjs", ["task", "create", successor, "--title", "Release successor", "--type", "bug", "--language", "en", "--area", "root"]);
    const superseded = JSON.parse(run(root, "state.mjs", ["task", "supersede", predecessor, "--successor", successor, "--reason", "separate release work", "--source", "human"]));
    assert.equal(superseded.nextAction.classification, "terminal"); assert.equal(superseded.nextAction.outcome, "superseded");
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", successor])).result.predecessorTaskId, predecessor);
    const compact = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    assert.equal(compact.schemaVersion, 4); assert.equal(compact.tasks[predecessor], undefined); assert.equal(compact.archive[predecessor].status, "superseded");

    const closedId = "2026-0004-closed"; run(root, "state.mjs", ["task", "create", closedId, "--title", "Abandoned", "--area", "root", "--switch-from", successor]);
    const closed = JSON.parse(run(root, "state.mjs", ["task", "close", closedId, "--reason", "no longer needed", "--source", "human"]));
    assert.equal(closed.nextAction.classification, "terminal"); assert.equal(closed.nextAction.outcome, "closed");
    const invalid = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "supersede", successor, "--successor", successor, "--reason", "bad", "--source", "human"], { cwd: root, encoding: "utf8" });
    assert.notEqual(invalid.status, 0); assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", successor])).result.status, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persisted mutations degrade derived-step failures to warnings instead of false errors", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-warnings-"));
  try {
    applyPlan(root, planInit(options(root)));
    const first = "2026-0005-first";
    run(root, "state.mjs", ["task", "create", first, "--title", "First archived", "--type", "bug", "--language", "en", "--area", "root"]);
    const taskDir = join(root, ".agents/data/tasks", first); mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    writeFileSync(join(taskDir, "design.md"), "# Design\n\n## 🧩 Solution per affected area\nx\n## 📌 Spec traceability\nx\n## 🔗 Cross-service contracts\nnone\n## ⚠️ Risks / edge cases\nnone\n");
    run(root, "state.mjs", ["task", "status", first, "--status", "blocked_on_user"]);
    run(root, "state.mjs", ["gate", "approve", first, "--gate", "G0_confirm", "--source", "human"]);
    run(root, "state.mjs", ["task", "item", first, "T1", "--status", "todo", "--label", "Only item"]);
    run(root, "state.mjs", ["task", "status", first, "--status", "blocked_on_user"]);
    run(root, "state.mjs", ["gate", "approve", first, "--gate", "G1_review", "--source", "human"]);
    run(root, "state.mjs", ["task", "item", first, "T1", "--status", "done"]);
    run(root, "state.mjs", ["evidence", "add", first, "--kind", "test", "--area", "root", "--result", "pass", "--source", "smoke"]);
    run(root, "state.mjs", ["evidence", "add", first, "--kind", "review", "--result", "pass", "--source", "review"]);
    run(root, "state.mjs", ["task", "status", first, "--status", "blocked_on_user"]);
    run(root, "state.mjs", ["gate", "approve", first, "--gate", "G2_codereview", "--source", "human"]);
    run(root, "state.mjs", ["lesson", "none", first, "--reason", "none", "--source", "smoke"]);
    run(root, "state.mjs", ["task", "archive", first, "--reason", "done", "--source", "smoke"]);

    const recordPath = join(root, ".agents/data/state/archive", `${first}.json`);
    writeFileSync(recordPath, readFileSync(recordPath, "utf8").replace("First archived", "TAMPERED"));
    const second = "2026-0006-second";
    const created = JSON.parse(run(root, "state.mjs", ["task", "create", second, "--title", "Second", "--area", "root"]));
    assert.equal(created.warnings, undefined);
    const closed = JSON.parse(run(root, "state.mjs", ["task", "close", second, "--reason", "not needed", "--source", "human"]));
    assert.equal(closed.nextAction.classification, "terminal");
    assert.equal(closed.warnings.length, 1); assert.equal(closed.warnings[0].code, "LESSON_INDEX_STALE");
    assert.match(closed.warnings[0].message, /digest mismatch/); assert.match(closed.warnings[0].hint, /lesson rebuild/);
    assert.ok(existsSync(join(root, ".agents/data/state/archive", `${second}.json`)));
    assert.equal(JSON.parse(run(root, "state.mjs", ["task", "show", second])).result.status, "closed");
    const loudRebuild = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "lesson", "rebuild"], { cwd: root, encoding: "utf8" });
    assert.equal(loudRebuild.status, 1); assert.match(loudRebuild.stderr, /digest mismatch/);

    const third = "2026-0007-third";
    run(root, "state.mjs", ["task", "create", third, "--title", "Third", "--area", "root"]);
    const workplan = join(root, ".agents/data/tasks", third, "workplan.md");
    writeFileSync(join(root, "outside.md"), "outside\n");
    rmSync(workplan); symlinkSync(join(root, "outside.md"), workplan);
    const item = JSON.parse(run(root, "state.mjs", ["task", "item", third, "T1", "--status", "todo", "--label", "After symlink"]));
    assert.equal(item.warnings.some((entry: { code: string }) => entry.code === "RENDER_FAILED"), true);
    assert.match(run(root, "state.mjs", ["task", "show", third]), /After symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installed entry scripts fail with a one-line JSON envelope and typed exit codes", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runtime-envelope-"));
  try {
    applyPlan(root, planInit(options(root)));
    const script = (name: string) => join(root, ".agents/aidlc/scripts", name);
    const unknown = spawnSync(process.execPath, [script("task-next.mjs"), "missing-task"], { cwd: root, encoding: "utf8" });
    assert.equal(unknown.status, 1);
    const envelope = JSON.parse(unknown.stderr.trim());
    assert.equal(envelope.ok, false);
    assert.match(envelope.error.message, /Unknown task/);
    assert.doesNotMatch(unknown.stderr, /at file:/);

    const badGate = spawnSync(process.execPath, [script("gate-check.mjs"), "missing-task"], { cwd: root, encoding: "utf8" });
    assert.equal(badGate.status, 1);
    assert.match(JSON.parse(badGate.stderr.trim()).error.message, /Unknown task: missing-task/);

    run(root, "state.mjs", ["task", "create", "case-task", "--title", "Case"]);
    const caseCollision = spawnSync(process.execPath, [script("state.mjs"), "task", "create", "Case-Task", "--title", "Duplicate"], { cwd: root, encoding: "utf8" });
    assert.notEqual(caseCollision.status, 0); assert.match(caseCollision.stderr, /collides case-insensitively/);
    const doneStatus = spawnSync(process.execPath, [script("state.mjs"), "task", "status", "case-task", "--status", "done"], { cwd: root, encoding: "utf8" });
    assert.notEqual(doneStatus.status, 0); assert.match(doneStatus.stderr, /task transition --to done/);

    const traversal = spawnSync(process.execPath, [script("context.mjs"), "case-task", "--phase", "../../../../../../tmp/secret-phase"], { cwd: root, encoding: "utf8" });
    assert.equal(traversal.status, 1); assert.match(traversal.stderr, /Unsupported phase/); assert.doesNotMatch(traversal.stderr, /secret-phase\.md|\.agents\/aidlc\/\.\./);

    const configPath = join(root, ".agents/config.json");
    const validConfig = readFileSync(configPath, "utf8");
    writeFileSync(configPath, "{broken");
    const badConfig = spawnSync(process.execPath, [script("context.mjs"), "case-task", "--phase", "clarify"], { cwd: root, encoding: "utf8" });
    assert.equal(badConfig.status, 1); assert.match(JSON.parse(badConfig.stderr.trim()).error.message, /Project config is corrupted or unreadable/);
    writeFileSync(configPath, validConfig);

    mkdirSync(join(root, ".agents/project/profiles/bad"), { recursive: true });
    writeFileSync(join(root, ".agents/project/profiles/bad/profile.json"), "{broken");
    const configured = JSON.parse(validConfig); configured.extends = ["bad"]; writeFileSync(configPath, JSON.stringify(configured));
    const badProfile = spawnSync(process.execPath, [script("context.mjs"), "case-task", "--phase", "clarify"], { cwd: root, encoding: "utf8" });
    assert.equal(badProfile.status, 1); assert.match(JSON.parse(badProfile.stderr.trim()).error.message, /Profile bad is corrupted or unreadable/);
    writeFileSync(configPath, validConfig);

    mkdirSync(join(root, ".agents/data/lessons"), { recursive: true });
    writeFileSync(join(root, ".agents/data/lessons/index.json"), "{broken");
    const badLessonIndex = spawnSync(process.execPath, [script("state.mjs"), "lesson", "search", "--query", "x"], { cwd: root, encoding: "utf8" });
    assert.equal(badLessonIndex.status, 1); assert.match(JSON.parse(badLessonIndex.stderr.trim()).error.message, /Lesson index is corrupted or unreadable/);

    writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), "{broken");
    const corrupted = spawnSync(process.execPath, [script("state.mjs"), "task", "list"], { cwd: root, encoding: "utf8" });
    assert.equal(corrupted.status, 1);
    assert.match(JSON.parse(corrupted.stderr.trim()).error.message, /corrupted or unreadable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
