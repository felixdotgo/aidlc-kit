import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approveAndAdvance, checkGate, gateView } from "../../src/gate.js";
import type { TaskState, WorkflowState } from "../../src/model.js";
import { acquireStateLock, closeTask, handoffTask, legacyG2WaitSource, nextAction, recordNoLessons, reopenTask, renderWorkplan, stampLegacyG2Waits, stateLockPath, supersedeTask, transitionTask, validateState } from "../../src/state.js";

const task = (): TaskState => ({
  id: "2026-0001-test", title: "Test task", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal",
  areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/2026-0001-test/intent.md", design: ".agents/data/tasks/2026-0001-test/design.md", workplan: ".agents/data/tasks/2026-0001-test/workplan.md" },
  decisions: [{ id: "D1", label: "Shape", status: "unresolved" }], tasks: [{ id: "T1", label: "Implement", status: "todo" }], evidence: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
});

test("state machine enforces approvals, decisions, verification, and review", () => {
  const current = task(); const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
  assert.throws(() => recordNoLessons(current, "too early", "unit test"), /active wrap/);
  assert.throws(() => transitionTask(state, current.id, "plan"), /G0 approval/);
  current.evidence.push({ kind: "approval", gate: "G0_confirm", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" });
  transitionTask(state, current.id, "plan");
  current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:02.000Z" });
  assert.throws(() => transitionTask(state, current.id, "build"), /unresolved/);
  current.decisions[0]!.status = "approved";
  transitionTask(state, current.id, "build");
  current.tasks[0]!.status = "done";
  assert.throws(() => transitionTask(state, current.id, "wrap"), /current-build verification/);
  current.evidence.push({ kind: "test", source: "npm test", result: "pass", recordedAt: "2026-01-01T00:00:03.000Z" });
  current.evidence.push({ kind: "review", source: "diff review", result: "pass", recordedAt: "2026-01-01T00:00:04.000Z" });
  current.evidence.push({ kind: "approval", gate: "G2_codereview", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:05.000Z" });
  transitionTask(state, current.id, "wrap");
  recordNoLessons(current, "No durable lesson", "unit test", "2026-01-01T00:00:06.000Z");
  transitionTask(state, current.id, "done");
  assert.equal(current.status, "done");
});

test("a gateless wrap wait routes back to run_phase instead of an unapprovable gate", () => {
  const current = task(); current.phase = "wrap"; current.gate = "none"; current.status = "blocked_on_user"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
  const action = nextAction(current);
  assert.equal(action.classification, "run_phase");
  assert.match(action.reason, /gateless/);
});

test("rendered workplans are deterministic and gate checks require artifacts/evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-state-"));
  try {
    const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
    current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" });
    for (const path of Object.values(current.artifacts)) {
      mkdirSync(join(root, path!, ".."), { recursive: true });
      writeFileSync(join(root, path!), "artifact\n");
    }
    const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
    assert.throws(() => gateView(current, checkGate(root, state, current.id, "G2_codereview")), /blocked_on_user/);
    assert.match(renderWorkplan(current), /D1 — Shape/);
    assert.ok(checkGate(root, state, current.id, "G2_codereview").some((item) => item.code === "VERIFY_EVIDENCE"));
    current.evidence.push({ kind: "test", source: "test", result: "pass", recordedAt: new Date().toISOString() });
    current.evidence.push({ kind: "review", source: "review", result: "pass", recordedAt: new Date().toISOString() });
    assert.equal(checkGate(root, state, current.id, "G2_codereview").some((item) => item.level === "ERROR"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G2 requires verification evidence for every affected area", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-areas-"));
  try {
    const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.areas = ["api", "web"]; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
    current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" });
    for (const path of Object.values(current.artifacts)) { mkdirSync(join(root, path!, ".."), { recursive: true }); writeFileSync(join(root, path!), "artifact\n"); }
    current.evidence.push({ kind: "test", area: "api", source: "api test", result: "pass", recordedAt: new Date().toISOString() });
    current.evidence.push({ kind: "review", source: "review", result: "pass", recordedAt: new Date().toISOString() });
    const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
    assert.match(checkGate(root, state, current.id, "G2_codereview").find((item) => item.code === "VERIFY_EVIDENCE")?.message ?? "", /web/);
    current.evidence.push({ kind: "lint", area: "web", source: "web lint", result: "pass", recordedAt: new Date().toISOString() });
    assert.equal(checkGate(root, state, current.id, "G2_codereview").some((item) => item.level === "ERROR"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("current-build verification uses append order and evaluates test and lint independently", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-latest-"));
  try {
    const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
    for (const path of Object.values(current.artifacts)) { mkdirSync(join(root, path!, ".."), { recursive: true }); writeFileSync(join(root, path!), "artifact\n"); }
    current.evidence.push(
      { kind: "test", area: "root", source: "old pass", result: "pass", recordedAt: "2026-01-01T00:00:00.000Z" },
      { kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" },
      { kind: "test", area: "root", source: "new pass", result: "pass", recordedAt: "2026-01-01T00:00:02.000Z" },
      { kind: "test", area: "root", source: "newer fail", result: "fail", recordedAt: "2026-01-01T00:00:03.000Z" },
      { kind: "review", source: "review", result: "pass", recordedAt: "2026-01-01T00:00:04.000Z" }
    );
    const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
    assert.match(checkGate(root, state, current.id, "G2_codereview").find((item) => item.code === "VERIFY_EVIDENCE")?.message ?? "", /root/);
    current.evidence.push({ kind: "lint", area: "root", source: "latest lint pass", result: "pass", recordedAt: "2026-01-01T00:00:05.000Z" });
    current.evidence.push({ kind: "test", area: "root", source: "late append with old timestamp", result: "fail", recordedAt: "2026-01-01T00:00:04.500Z" });
    assert.equal(checkGate(root, state, current.id, "G2_codereview").some((item) => item.code === "VERIFY_EVIDENCE"), true);
    current.evidence.push({ kind: "test", area: "root", source: "latest appended test pass", result: "pass", recordedAt: "2026-01-01T00:00:04.250Z" });
    assert.equal(checkGate(root, state, current.id, "G2_codereview").some((item) => item.level === "ERROR"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("atomic gate approval is idempotent and exposes the next action", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-atomic-"));
  try {
    const current = task(); current.status = "blocked_on_user";
    mkdirSync(join(root, ".agents/data/tasks", current.id), { recursive: true });
    writeFileSync(join(root, current.artifacts.intent!), "## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
    assert.equal(nextAction(current).classification, "await_user");
    const first = approveAndAdvance(root, state, current.id, "G0_confirm", "explicit user approval", "2026-01-01T00:00:01.000Z");
    assert.equal(first.idempotent, false);
    assert.equal(first.task.phase, "plan");
    assert.equal(first.nextAction.classification, "run_phase");
    const second = approveAndAdvance(root, state, current.id, "G0_confirm", "retry", "2026-01-01T00:00:02.000Z");
    assert.equal(second.idempotent, true);
    assert.equal(current.evidence.filter((item) => item.gate === "G0_confirm").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("build nextAction routes deterministically through every actionable item", () => {
  const current = task();
  current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved";
  current.tasks = [
    { id: "T1", label: "First", status: "done" },
    { id: "T2", label: "Second", status: "todo" },
    { id: "T3", label: "Third", status: "in_progress" }
  ];
  const inProgress = nextAction(current);
  assert.equal(inProgress.classification, "run_phase");
  assert.equal(inProgress.itemId, "T3"); assert.equal(inProgress.remainingItems, 2);
  assert.match(inProgress.command ?? "", /--item T3$/);

  current.tasks[2]!.status = "done";
  const todo = nextAction(current);
  assert.equal(todo.itemId, "T2"); assert.equal(todo.remainingItems, 1);
  assert.match(todo.reason, /1 actionable item/);

  current.tasks[1]!.status = "deferred";
  const verify = nextAction(current);
  assert.equal(verify.classification, "run_phase"); assert.equal(verify.itemId, undefined); assert.equal(verify.remainingItems, 0);
  assert.match(verify.reason, /verification, adversarial review, and G2/);
});

test("state lock serializes local writers and only reclaims a stale dead owner", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-state-lock-"));
  try {
    const release = acquireStateLock(root);
    assert.throws(() => acquireStateLock(root, { timeoutMs: 5, retryMs: 1 }), /Timed out waiting for AI-DLC state lock/);
    const guardPath = join(root, ".agents/data/state/.aidlc-state.lock.guard");
    writeFileSync(guardPath, JSON.stringify({ token: "live-guard", pid: process.pid, createdAt: Date.now() }));
    release();
    assert.equal(existsSync(stateLockPath(root)), false);
    assert.equal(JSON.parse(readFileSync(guardPath, "utf8")).token, "live-guard");
    rmSync(guardPath);

    const path = stateLockPath(root);
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    writeFileSync(path, JSON.stringify({ token: "dead-owner", pid: 999_999, createdAt: 0 }));
    const releaseStale = acquireStateLock(root, { timeoutMs: 20, retryMs: 1, staleMs: 0 });
    releaseStale();
    assert.equal(existsSync(path), false);

    writeFileSync(path, JSON.stringify({ token: "live-owner", pid: process.pid, createdAt: 0 }));
    assert.throws(() => acquireStateLock(root, { timeoutMs: 5, retryMs: 1, staleMs: 0 }), /Timed out waiting for AI-DLC state lock/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "live-owner");
    rmSync(path);

    const releaseReplaced = acquireStateLock(root);
    writeFileSync(path, JSON.stringify({ token: "replacement-owner", pid: process.pid, createdAt: Date.now() }));
    releaseReplaced();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "replacement-owner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state validation rejects phase-gate and done-status drift", () => {
  const current = task(); const state: WorkflowState = { schemaVersion: 1, tasks: { [current.id]: current } };
  assert.doesNotThrow(() => validateState(state));
  current.gate = "G1_review";
  assert.throws(() => validateState(state), /Invalid task state/);
  current.gate = "G0_confirm"; current.status = "done";
  assert.throws(() => validateState(state), /Invalid task fields/);
  current.status = "active"; current.evidence.push({ kind: "test", source: "bad time", result: "pass", recordedAt: "2026-01-01" });
  assert.throws(() => validateState(state), /Invalid evidence/);
});

test("durable handoff blocks invalid G2 approval guidance and close is terminal without claiming completion", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved";
  const state: WorkflowState = { schemaVersion: 2, tasks: { [current.id]: current } };
  current.status = "blocked_on_user";
  assert.equal(nextAction(current).classification, "run_phase");
  assert.equal(nextAction(current).itemId, "T1");
  current.status = "active";
  handoffTask(state, current.id, "release_failed", "Claude release evidence failed", "user", "2026-01-01T00:00:01.000Z");
  const blocked = nextAction(current);
  assert.equal(blocked.classification, "blocked"); assert.equal(blocked.actions?.some((item) => item.id === "reopen_g1"), true); assert.equal(blocked.command, undefined);
  closeTask(state, current.id, "Stop bounded remediation", "user", "2026-01-01T00:00:02.000Z");
  const closed = nextAction(current);
  assert.equal(closed.classification, "terminal"); assert.equal(closed.outcome, "closed"); assert.equal(current.phase, "build");
  assert.equal(checkGate(".", state, current.id, "G2_codereview").some((item) => item.code === "TASK_TERMINAL"), true);
  assert.throws(() => approveAndAdvance(".", state, current.id, "G1_review", "retry"), /Terminal or handed-off/);
  assert.throws(() => transitionTask(state, current.id, "wrap"), /Terminal task/);
  assert.match(renderWorkplan(current), /Closure: Stop bounded remediation/);
});

test("supersede links a fresh successor atomically and rejects invalid or conflicting links", () => {
  const predecessor = task(); predecessor.phase = "build"; predecessor.gate = "G2_codereview"; predecessor.decisions[0]!.status = "approved";
  const successor = task(); successor.id = "2026-0002-successor"; successor.title = "Successor"; successor.artifacts = { intent: `.agents/data/tasks/${successor.id}/intent.md`, design: `.agents/data/tasks/${successor.id}/design.md`, workplan: `.agents/data/tasks/${successor.id}/workplan.md` };
  const state: WorkflowState = { schemaVersion: 2, tasks: { [predecessor.id]: predecessor, [successor.id]: successor } };
  supersedeTask(state, predecessor.id, successor.id, "Move release blocker", "user", "2026-01-01T00:00:01.000Z");
  assert.equal(predecessor.status, "superseded"); assert.equal(predecessor.successorTaskId, successor.id); assert.equal(successor.predecessorTaskId, predecessor.id);
  assert.equal(nextAction(predecessor).classification, "terminal"); assert.doesNotThrow(() => validateState(state));
  assert.equal(supersedeTask(state, predecessor.id, successor.id, "Move release blocker", "user"), predecessor);
  assert.throws(() => supersedeTask(state, predecessor.id, successor.id, "different", "user"), /different metadata/);
  successor.evidence.push({ kind: "approval", gate: "G0_confirm", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:02.000Z" }); successor.phase = "plan"; successor.gate = "G1_review";
  assert.doesNotThrow(() => validateState(state));
  const self = task(); const selfState: WorkflowState = { schemaVersion: 2, tasks: { [self.id]: self } };
  assert.throws(() => supersedeTask(selfState, self.id, self.id, "bad", "user"), /cannot be superseded/);
});

test("reopen G1 invalidates the prior approval before returning to plan", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved";
  current.tasks = [{ id: "T1", label: "Rebuild", status: "done" }, { id: "T2", label: "Deferred", status: "deferred" }];
  current.evidence.push(
    { kind: "approval", gate: "G1_review", source: "old approval", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" },
    { kind: "approval", gate: "G2_codereview", source: "old approval", result: "pass", recordedAt: "2026-01-01T00:00:02.000Z" }
  );
  const state: WorkflowState = { schemaVersion: 2, tasks: { [current.id]: current } };
  handoffTask(state, current.id, "structural_change", "Lifecycle contract changed", "review", "2026-01-01T00:00:03.000Z");
  reopenTask(state, current.id, "plan", "Review new lifecycle", "user", "2026-01-01T00:00:04.000Z");
  assert.equal(current.phase, "plan"); assert.equal(current.gate, "G1_review"); assert.equal(current.status, "active"); assert.equal(current.handoff, undefined);
  assert.equal(current.evidence.at(-1)?.result, "fail");
  assert.deepEqual(current.tasks.map((item) => item.status), ["todo", "deferred"]);
  assert.throws(() => transitionTask(state, current.id, "build"), /G1 approval/);
  current.evidence.push({ kind: "approval", gate: "G1_review", source: "new approval after clock rollback", result: "pass", recordedAt: "2026-01-01T00:00:00.500Z" });
  transitionTask(state, current.id, "build"); current.tasks[0]!.status = "done";
  current.evidence.push(
    { kind: "test", area: "root", source: "new test", result: "pass", recordedAt: "2026-01-01T00:00:06.000Z" },
    { kind: "review", source: "new review", result: "pass", recordedAt: "2026-01-01T00:00:07.000Z" }
  );
  assert.throws(() => transitionTask(state, current.id, "wrap"), /Current-build G2 approval/);
  current.evidence.push({ kind: "approval", gate: "G2_codereview", source: "new approval", result: "pass", recordedAt: "2026-01-01T00:00:08.000Z" });
  assert.doesNotThrow(() => transitionTask(state, current.id, "wrap"));
});

test("self-transition is rejected without clearing a validated gate wait", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.status = "blocked_on_user";
  const state: WorkflowState = { schemaVersion: 3, tasks: { [current.id]: current }, archive: {} };
  assert.throws(() => transitionTask(state, current.id, "build"), /Cannot transition build → build/);
  assert.equal(current.status, "blocked_on_user"); assert.equal(current.phase, "build");
});

test("repair bounds force a durable handoff instead of endless repair loops", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
  current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" });
  current.evidence.push({ kind: "test", area: "root", source: "npm test", result: "fail", recordedAt: "2026-01-01T00:00:02.000Z" });
  current.evidence.push({ kind: "test", area: "root", source: "npm test", result: "fail", recordedAt: "2026-01-01T00:00:03.000Z" });
  assert.equal(nextAction(current).classification, "run_phase");
  current.evidence.push({ kind: "lint", area: "root", source: "npm run lint", result: "fail", recordedAt: "2026-01-01T00:00:04.000Z" });
  const blocked = nextAction(current);
  assert.equal(blocked.classification, "blocked");
  assert.match(blocked.actions?.[0]!.command ?? "", /--kind repair_exhausted/);
  const diagnostics = checkGate("/nonexistent-root", { schemaVersion: 1, tasks: { [current.id]: current } }, current.id, "G2_codereview");
  assert.ok(diagnostics.some((item) => item.code === "REPAIR_BOUND"));
  current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:05.000Z" });
  assert.equal(nextAction(current).classification, "run_phase");
});

test("only a migration-stamped legacy G2 wait bypasses the repair bound, and the stamp is consumed on exit", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-legacy-g2-"));
  try {
    const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.status = "blocked_on_user"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
    current.evidence.push(
      { kind: "approval", gate: "G1_review", source: "human", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" },
      { kind: "test", area: "root", source: "test", result: "fail", recordedAt: "2026-01-01T00:00:02.000Z" },
      { kind: "test", area: "root", source: "test", result: "fail", recordedAt: "2026-01-01T00:00:03.000Z" },
      { kind: "lint", area: "root", source: "lint", result: "fail", recordedAt: "2026-01-01T00:00:04.000Z" },
      { kind: "test", area: "root", source: "test", result: "pass", recordedAt: "2026-01-01T00:00:05.000Z" },
      { kind: "lint", area: "root", source: "lint", result: "pass", recordedAt: "2026-01-01T00:00:06.000Z" },
      { kind: "review", source: "review", result: "pass", recordedAt: "2026-01-01T00:00:07.000Z" }
    );
    for (const path of Object.values(current.artifacts)) { const target = join(root, path!); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, "review artifact"); }
    const active = structuredClone(current); active.status = "active";
    assert.equal(nextAction(active).classification, "blocked");
    assert.ok(checkGate(root, { schemaVersion: 3, tasks: { [active.id]: active }, archive: {} }, active.id, "G2_codereview").some((item) => item.code === "REPAIR_BOUND"));

    // An exhausted wait without a migration stamp is no longer exempt: the bound blocks it.
    const state: WorkflowState = { schemaVersion: 4, tasks: { [current.id]: current }, archive: {} };
    assert.equal(nextAction(current).classification, "blocked");
    assert.ok(checkGate(root, state, current.id, "G2_codereview").some((item) => item.code === "REPAIR_BOUND"));

    // The migration stamps only qualifying pre-existing ready waits, deterministically from updatedAt.
    assert.deepEqual(stampLegacyG2Waits(state), [current.id]);
    assert.deepEqual(current.legacyG2Wait, { migratedAt: current.updatedAt, source: legacyG2WaitSource });
    assert.deepEqual(stampLegacyG2Waits(state), []);
    assert.doesNotThrow(() => validateState(state));
    assert.equal(nextAction(current).classification, "await_user");
    assert.doesNotMatch(checkGate(root, state, current.id, "G2_codereview").map((item) => item.code).join(","), /REPAIR_BOUND/);
    assert.equal(approveAndAdvance(root, state, current.id, "G2_codereview", "legacy human approval").task.phase, "wrap");
    assert.equal(current.legacyG2Wait, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy G2 wait markers are schema-v4-only and valid only on a ready G2 wait", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.status = "blocked_on_user"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
  current.evidence.push(
    { kind: "approval", gate: "G1_review", source: "human", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" },
    { kind: "test", area: "root", source: "test", result: "pass", recordedAt: "2026-01-01T00:00:02.000Z" },
    { kind: "review", source: "review", result: "pass", recordedAt: "2026-01-01T00:00:03.000Z" }
  );
  current.legacyG2Wait = { migratedAt: current.updatedAt, source: legacyG2WaitSource };
  assert.doesNotThrow(() => validateState({ schemaVersion: 4, tasks: { [current.id]: current }, archive: {} }));
  assert.throws(() => validateState({ schemaVersion: 3, tasks: { [current.id]: current }, archive: {} }), /require schema v4/);
  const drifted = structuredClone(current); drifted.status = "active";
  assert.throws(() => validateState({ schemaVersion: 4, tasks: { [drifted.id]: drifted }, archive: {} }), /Invalid legacy G2 wait marker/);
  const malformed = structuredClone(current); malformed.legacyG2Wait = { migratedAt: "not-a-date", source: legacyG2WaitSource };
  assert.throws(() => validateState({ schemaVersion: 4, tasks: { [malformed.id]: malformed }, archive: {} }), /Invalid legacy G2 wait marker/);
  const state: WorkflowState = { schemaVersion: 4, tasks: { [current.id]: current }, archive: {} };
  handoffTask(state, current.id, "other", "operator pulled the wait", "user", "2026-01-01T00:00:04.000Z");
  assert.equal(current.legacyG2Wait, undefined);
});

test("two failed review passes exhaust the review bound", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.decisions[0]!.status = "approved"; current.tasks[0]!.status = "done";
  current.evidence.push({ kind: "approval", gate: "G1_review", source: "user", result: "pass", recordedAt: "2026-01-01T00:00:01.000Z" });
  current.evidence.push({ kind: "review", source: "diff review", result: "fail", recordedAt: "2026-01-01T00:00:02.000Z" });
  assert.equal(nextAction(current).classification, "run_phase");
  current.evidence.push({ kind: "review", source: "diff review", result: "fail", recordedAt: "2026-01-01T00:00:03.000Z" });
  const blocked = nextAction(current);
  assert.equal(blocked.classification, "blocked");
  assert.match(blocked.actions?.[0]!.command ?? "", /--kind review_exhausted/);
});

test("paused and handed-off tasks expose structured recovery actions", () => {
  const current = task(); current.phase = "build"; current.gate = "G2_codereview"; current.status = "paused";
  const paused = nextAction(current);
  assert.equal(paused.classification, "blocked");
  assert.deepEqual(paused.actions?.map((item) => item.id), ["resume", "record_handoff"]);
  current.handoff = { kind: "structural_change", reason: "replan", source: "human", recordedAt: "2026-01-01T00:00:01.000Z" };
  const handedOff = nextAction(current);
  assert.deepEqual(handedOff.actions?.map((item) => item.id), ["reopen_g1", "create_successor", "supersede", "close"]);
});
