import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-daemon.mjs"));

const task = (id: string, phase: string, status: string, gate: string, updatedAt: string) => ({
  id, title: id, phase, status, gate, updatedAt,
});

test("actionableTasks selects only run_phase tasks and skips wait/blocked/terminal/complete", async () => {
  const { actionableTasks } = await load();
  const state = {
    tasks: {
      "active-clarify": task("active-clarify", "clarify", "active", "G0_confirm", "2026-01-01T00:00:00.000Z"),
      "active-plan": task("active-plan", "plan", "active", "G1_review", "2026-01-01T00:00:01.000Z"),
      "waiting": task("waiting", "clarify", "blocked_on_user", "G0_confirm", "2026-01-02T00:00:00.000Z"),
      "paused": task("paused", "clarify", "paused", "G0_confirm", "2026-01-03T00:00:00.000Z"),
      "done": task("done", "done", "active", "none", "2026-01-04T00:00:00.000Z"),
      "closed": task("closed", "clarify", "closed", "G0_confirm", "2026-01-05T00:00:00.000Z"),
    },
  };
  const result = actionableTasks(state, ".", { isOwned: () => true });
  // Sorted by updatedAt then id: active-clarify before active-plan.
  assert.deepEqual(result.map((entry: any) => entry.id), ["active-clarify", "active-plan"]);
});

test("actionableTasks returns an empty list when nothing is actionable", async () => {
  const { actionableTasks } = await load();
  const state = {
    tasks: {
      "waiting": task("waiting", "clarify", "blocked_on_user", "G0_confirm", "2026-01-02T00:00:00.000Z"),
      "closed": task("closed", "clarify", "closed", "G0_confirm", "2026-01-05T00:00:00.000Z"),
    },
  };
  assert.deepEqual(actionableTasks(state, ".", { isOwned: () => true }), []);
});

test("validateDaemonPollMs enforces the 1000..300000 bound", async () => {
  const { validateDaemonPollMs, DEFAULT_DAEMON_POLL_MS } = await load();
  assert.equal(validateDaemonPollMs(5000), 5000);
  assert.equal(DEFAULT_DAEMON_POLL_MS, 5000);
  assert.throws(() => validateDaemonPollMs(999), /pollMs/);
  assert.throws(() => validateDaemonPollMs(300001), /pollMs/);
  assert.throws(() => validateDaemonPollMs("fast"), /pollMs/);
  assert.throws(() => validateDaemonPollMs(undefined), /pollMs/);
});

test("runLocalDaemon stops immediately on an aborted signal", async () => {
  const { runLocalDaemon } = await load();
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalDaemon({ root, agent: "codex", workers: { "worker-a": "codex" }, signal: controller.signal });
    assert.equal(result.status, "stopped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("daemon lock is a singleton: a live owner fails closed, a dead owner is reclaimed", async () => {
  const { acquireDaemonLock, readDaemonLock, daemonLockPath } = await load();
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-lock-"));
  try {
    assert.equal(readDaemonLock(root), null);
    const release = acquireDaemonLock(root);
    assert.equal(readDaemonLock(root).pid, process.pid);
    assert.equal(readDaemonLock(root).alive, true);
    assert.throws(() => acquireDaemonLock(root), /already running \(pid \d+\)/);
    release();
    assert.equal(existsSync(daemonLockPath(root)), false);

    mkdirSync(join(root, ".agents", "data", "loop"), { recursive: true });
    writeFileSync(daemonLockPath(root), JSON.stringify({ schemaVersion: 1, pid: 2147483646, token: "stale", startedAt: "2026-01-01T00:00:00.000Z" }));
    assert.equal(readDaemonLock(root).alive, false);
    const reclaimed = acquireDaemonLock(root);
    assert.equal(readDaemonLock(root).pid, process.pid);
    reclaimed();

    writeFileSync(daemonLockPath(root), "{corrupt");
    const fromCorrupt = acquireDaemonLock(root);
    assert.equal(readDaemonLock(root).pid, process.pid);
    assert.equal(existsSync(`${daemonLockPath(root)}.guard`), false);
    fromCorrupt();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runLocalDaemon refuses to start while another live daemon holds the lock", async () => {
  const { runLocalDaemon, acquireDaemonLock } = await load();
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-single-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const release = acquireDaemonLock(root);
    try {
      await assert.rejects(() => runLocalDaemon({ root, agent: "codex", workers: { "worker-a": "codex" } }), /already running/);
    } finally { release(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actionableTasks only picks loop-owned tasks (intake marker or loop record) by default", async () => {
  const { actionableTasks, isLoopOwned } = await load();
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-owned-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    mkdirSync(join(root, ".agents/data/tasks/from-intake"), { recursive: true });
    writeFileSync(join(root, ".agents/data/tasks/from-intake/loop-intake.json"), "{}");
    const state = { tasks: {
      "from-intake": task("from-intake", "clarify", "active", "G0_confirm", "2026-01-01T00:00:00.000Z"),
      "interactive": task("interactive", "clarify", "active", "G0_confirm", "2026-01-01T00:00:01.000Z"),
    } };
    assert.equal(isLoopOwned(root, "from-intake"), true);
    assert.equal(isLoopOwned(root, "interactive"), false);
    assert.equal(isLoopOwned(root, "../escape"), false);
    assert.deepEqual(actionableTasks(state, root).map((entry: any) => entry.id), ["from-intake"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("backoffDelay doubles from the poll interval and caps at 10 minutes", async () => {
  const { backoffDelay, DAEMON_BACKOFF_MAX_MS } = await load();
  assert.equal(backoffDelay(5000, 0), 0);
  assert.equal(backoffDelay(5000, 1), 5000);
  assert.equal(backoffDelay(5000, 2), 10000);
  assert.equal(backoffDelay(5000, 4), 40000);
  assert.equal(backoffDelay(5000, 50), DAEMON_BACKOFF_MAX_MS);
  assert.equal(DAEMON_BACKOFF_MAX_MS, 600000);
});

test("daemonLoop backs off a failing task, stamps task ids on run events, and forwards stop signals", async () => {
  const { daemonLoop } = await load();
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-loop-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", "t1", "--title", "T1", "--root", root]);
    const stop = new AbortController();
    const cancel = new AbortController();
    let clock = 0;
    let polls = 0;
    const calls: any[] = [];
    const events: any[] = [];
    const turn = async (input: any) => {
      calls.push(input);
      input.onEvent({ type: "agent_text", text: "working" });
      if (calls.length === 1) throw new Error("transient failure");
      return { status: "gate", gate: "G0_confirm" };
    };
    const onEvent = (event: any) => {
      events.push(event);
      if (event.type !== "daemon_poll") return;
      polls += 1;
      if (polls === 3) clock = 1000; // past the 10ms backoff window
      if (polls === 4) stop.abort();
    };
    const result = await daemonLoop({ root, agent: "codex", workers: { w: "codex" }, poll: 10, signal: stop.signal, cancelSignal: cancel.signal, onEvent, now: () => clock, turn, isOwned: () => true });
    assert.equal(result.status, "stopped");
    // poll 1: fails; poll 2: skipped (backing off); poll 3: retried and succeeds.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal, stop.signal);
    assert.equal(calls[0].cancelSignal, cancel.signal);
    const error = events.find((event) => event.type === "daemon_turn_error");
    assert.deepEqual({ taskId: error.taskId, failures: error.failures, retryInMs: error.retryInMs }, { taskId: "t1", failures: 1, retryInMs: 10 });
    assert.deepEqual(events.filter((event) => event.type === "daemon_poll")[1].backingOff, ["t1"]);
    assert.ok(events.filter((event) => event.type === "agent_text").every((event) => event.taskId === "t1"));
    assert.ok(events.some((event) => event.type === "daemon_turn" && event.status === "gate" && event.taskId === "t1"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
