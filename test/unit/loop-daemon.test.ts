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
    const onEvent = (event: any) => { events.push(event); };
    // `daemon_poll` is emitted only on change, so count polls at the ownership probe (once per poll for t1).
    const isOwned = () => {
      polls += 1;
      if (polls === 3) clock = 1000; // past the 10ms backoff window
      if (polls === 4) stop.abort();
      return true;
    };
    const result = await daemonLoop({ root, agent: "codex", workers: { w: "codex" }, poll: 10, signal: stop.signal, cancelSignal: cancel.signal, onEvent, now: () => clock, turn, isOwned });
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

/** Mirror of the dashboard's `daemonHealth` reduction (src/task-ui.ts): a turn
 * error stays open until a `daemon_turn` for the task or a `daemon_poll` that no
 * longer lists it; a poll error stays open until the next `daemon_poll`. */
const health = (events: any[]) => {
  const turnErrors = new Map<string, any>();
  let pollError: any = null;
  for (const event of events) {
    switch (event.type) {
      case "daemon_start": turnErrors.clear(); pollError = null; break;
      case "daemon_poll_error": pollError = event; break;
      case "daemon_poll": pollError = null; for (const id of [...turnErrors.keys()]) if (!(event.actionable ?? []).includes(id)) turnErrors.delete(id); break;
      case "daemon_turn": turnErrors.delete(event.taskId); break;
      case "daemon_turn_error": turnErrors.set(event.taskId, event); break;
      default: break;
    }
  }
  return [...(pollError ? ["poll"] : []), ...turnErrors.keys()];
};

test("daemonLoop emits daemon_poll only on change and keeps the dashboard health semantics", async () => {
  const { daemonLoop } = await load();
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-poll-"));
  try {
    const stop = new AbortController();
    const events: any[] = [];
    const marks: number[] = [];
    let polls = 0;
    const lists: Record<number, string[] | Error> = {
      1: new Error("service unreachable"), 2: ["a", "b"], 3: ["a", "b"], 4: ["a", "b"],
      5: ["b"], 6: ["b"], 7: new Error("service unreachable"), 8: ["b"], 9: ["b"],
    };
    const listActionable = async () => {
      polls += 1;
      marks[polls] = events.length;
      if (polls >= 9) stop.abort();
      const value = lists[polls] ?? ["b"];
      if (value instanceof Error) throw value;
      return value.map((id) => ({ id }));
    };
    const turn = async ({ taskId }: any) => {
      if (taskId === "a") throw new Error("a keeps failing");
      return { status: "stopped" };
    };
    const result = await daemonLoop({ root, poll: 1, signal: stop.signal, onEvent: (event: any) => events.push(event), now: () => 0, turn, listActionable });
    assert.equal(result.status, "stopped");
    const emitted = events.filter((event) => event.type === "daemon_poll");
    // poll 2: first after an error; 3: `a` starts backing off; 4: unchanged (skipped);
    // 5: `a` left the actionable set; 6: unchanged; 7: error; 8: first after the error; 9: unchanged.
    assert.deepEqual(emitted.map((event) => [event.actionable, event.backingOff ?? []]), [
      [["a", "b"], []],
      [["a", "b"], ["a"]],
      [["b"], []],
      [["b"], []],
    ]);
    assert.equal(events.filter((event) => event.type === "daemon_poll_error").length, 2);
    assert.deepEqual(health(events.slice(0, marks[2])), ["poll"], "a poll error is open before the next poll");
    assert.deepEqual(health(events.slice(0, marks[3])), ["a"], "the first successful poll after an error clears it; the turn error opens");
    assert.deepEqual(health(events.slice(0, marks[5])), ["a"], "an unchanged poll is not emitted and leaves the turn error open");
    assert.deepEqual(health(events.slice(0, marks[6])), [], "a poll that no longer lists the task clears its turn error");
    assert.deepEqual(health(events.slice(0, marks[8])), ["poll"], "a poll error after a quiet stretch is open");
    assert.deepEqual(health(events), [], "the first poll after the error is emitted even with an unchanged set");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const loadAuthority = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-authority.mjs"));

test("runLoopDaemon drives any loop authority: shared lock, gate-event dedupe, backoff on blocked runs, and poll errors", async () => {
  const { runLoopDaemon, daemonLockPath } = await load();
  const { existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "aidlc-daemon-shared-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const stop = new AbortController();
    const events: any[] = []; const runs: string[] = [];
    let polls = 0;
    const authority = {
      mode: "fleet",
      async listActionable() {
        polls += 1;
        if (polls === 1) throw new Error("service unreachable");
        if (polls >= 4) stop.abort();
        return [{ id: "parked", updatedAt: "1" }, { id: "stuck", updatedAt: "2" }];
      },
      async runTask({ taskId, onEvent }: any) {
        runs.push(taskId);
        assert.ok(existsSync(daemonLockPath(root)), "the singleton lock is held while runs execute");
        if (taskId === "parked") { onEvent({ type: "gate", gate: "G0_confirm" }); return { status: "gate", gate: "G0_confirm", gateEmitted: true }; }
        return { status: "blocked", reason: "Pending checkpoint does not match canonical gate" };
      }
    };
    const result = await runLoopDaemon({ root, authority, pollMs: 1000, signal: stop.signal, onEvent: (event: any) => events.push(event), now: () => 0 });
    assert.equal(result.status, "stopped");
    assert.equal(existsSync(daemonLockPath(root)), false, "the lock is released on stop");
    assert.equal(events[0].type, "daemon_start");
    assert.equal(events[0].authority, "fleet");
    assert.ok(events.some((event) => event.type === "daemon_poll_error" && /unreachable/.test(event.message)));
    assert.equal(events.filter((event) => event.type === "gate").length, 2, "one gate event per parked run; the daemon does not duplicate an emitted gate");
    assert.ok(events.filter((event) => event.type === "gate").every((event) => event.taskId === "parked"));
    // `stuck` returns blocked once, then backs off (the clock never advances) instead of re-running every poll.
    assert.deepEqual(runs.filter((id) => id === "stuck").length, 1);
    assert.ok(events.some((event) => event.type === "daemon_turn" && event.taskId === "stuck" && event.status === "blocked" && /checkpoint/.test(event.reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet lead env validates the remote authority, maps loop limits, and strips reviewer credentials", async () => {
  const { fleetLeadEnv } = await loadAuthority();
  const base = { AIDLC_FLEET_URL: "https://fleet.example/mcp", AIDLC_FLEET_WORKSPACE: "ws", AIDLC_FLEET_TOKEN: "lead", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_REVIEWER_TOKEN: "r".repeat(32), AIDLC_UI_TOKEN: "ui", AIDLC_FLEET_MAX_TURNS: "7" };
  const env = fleetLeadEnv({ root: "/repo", agent: "codex", workers: { w1: "codex", w2: "opencode" }, limits: { maxTurns: 30, turnTimeoutMs: 900000, maxStallTurns: 3 }, pollMs: 2000, env: base });
  assert.equal(env.AIDLC_FLEET_REVIEWER_TOKEN, undefined);
  assert.equal(env.AIDLC_UI_TOKEN, undefined);
  assert.equal(env.AIDLC_FLEET_MAX_TURNS, "7", "explicit env wins over loop.limits");
  assert.equal(env.AIDLC_FLEET_TURN_TIMEOUT_MS, "900000");
  assert.equal(env.AIDLC_FLEET_MAX_STALL_TURNS, "3");
  assert.equal(env.AIDLC_FLEET_POLL_MS, "2000");
  assert.equal(env.AIDLC_FLEET_PROJECT_ROOT, "/repo");
  assert.equal(env.AIDLC_FLEET_WORKER_IDS, "w1,w2");
  assert.equal(env.AIDLC_FLEET_WORKER_PROVIDERS, JSON.stringify({ w1: "codex", w2: "opencode" }));
  assert.throws(() => fleetLeadEnv({ root: "/repo", agent: "codex", workers: { w1: "codex" }, env: { ...base, AIDLC_FLEET_URL: "" } }), /AIDLC_FLEET_URL/);
  assert.doesNotThrow(() => fleetLeadEnv({ root: "/repo", agent: "codex", workers: { w1: "codex", w2: "opencode" }, env: { ...base, AIDLC_FLEET_WORKER_PROVIDERS: '{ "w2": "opencode", "w1": "codex" }' } }), "key order and spacing do not matter");
  assert.throws(() => fleetLeadEnv({ root: "/repo", agent: "codex", workers: { w1: "codex" }, env: { ...base, AIDLC_FLEET_WORKER_PROVIDERS: '{"w1":"claude"}' } }), /does not match/);
  assert.throws(() => fleetLeadEnv({ root: "/repo", agent: "codex", workers: { w1: "codex" }, env: { ...base, AIDLC_FLEET_PROJECT_ROOT: "/other" } }), /does not match the loop root/);
});

test("fleet authority lists only actionable fleet-owned tasks and runs bounded supervisors", async () => {
  const { createFleetAuthority } = await loadAuthority();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-authority-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const own = (id: string, authority: string) => { mkdirSync(join(root, ".agents/data/tasks", id), { recursive: true }); writeFileSync(join(root, ".agents/data/tasks", id, "loop-intake.json"), JSON.stringify({ schemaVersion: 1, taskId: id, authority, requirementHash: "x" })); };
    own("fleet-a", "fleet"); own("fleet-b", "fleet"); own("local-c", "local"); own("fleet-paused", "fleet");
    const mk = (id: string, status: string, updatedAt: string) => ({ id, title: id, type: "infra", phase: "clarify", gate: "G0_confirm", status, language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {}, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt });
    const tasks = { "fleet-a": mk("fleet-a", "active", "2026-01-02T00:00:00.000Z"), "fleet-b": mk("fleet-b", "active", "2026-01-01T00:00:00.000Z"), "local-c": mk("local-c", "active", "2026-01-01T00:00:00.000Z"), "fleet-paused": mk("fleet-paused", "paused", "2026-01-01T00:00:00.000Z"), foreign: mk("foreign", "active", "2026-01-01T00:00:00.000Z") };
    const calls: any[] = [];
    const callTool = async ({ name, args }: any) => { calls.push({ name, args }); if (name === "state_get") return { revision: 1, state: { tasks } }; throw new Error(`unexpected ${name}`); };
    const cli: any[] = [];
    const runCli = async (argv: string[], options: any) => { cli.push({ argv, options }); return { status: "gate", gate: "G0_confirm", snapshotId: "s1" }; };
    const env = { AIDLC_FLEET_URL: "https://fleet.example/mcp", AIDLC_FLEET_WORKSPACE: "ws", AIDLC_FLEET_TOKEN: "lead", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_REVIEWER_TOKEN: "r".repeat(32) };
    const authority = await createFleetAuthority({ root, agent: "codex", workers: { w1: "codex" }, env, callTool, runCli });
    assert.equal(authority.mode, "fleet");
    assert.deepEqual((await authority.listActionable()).map((task: any) => task.id), ["fleet-b", "fleet-a"]);
    const stop = new AbortController(), cancel = new AbortController();
    const result = await authority.runTask({ taskId: "fleet-a", signal: stop.signal, cancelSignal: cancel.signal, onEvent: () => {} });
    assert.deepEqual(result, { status: "gate", gate: "G0_confirm", snapshotId: "s1", gateEmitted: true });
    assert.deepEqual(cli[0].argv, ["supervisor", "fleet-a"]);
    assert.equal(cli[0].options.untilStop, true);
    assert.equal(cli[0].options.signal, stop.signal);
    assert.equal(cli[0].options.cancelSignal, cancel.signal);
    assert.equal(cli[0].options.env.AIDLC_FLEET_REVIEWER_TOKEN, undefined, "the lead never receives the reviewer credential");
    await assert.rejects(() => authority.approve({ taskId: "fleet-a", source: "ok", reviewerToken: undefined }), /reviewer credential/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet authority feedback re-activates a gated task under a lead claim without the reviewer credential", async () => {
  const { createFleetAuthority } = await loadAuthority();
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-feedback-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    mkdirSync(join(root, ".agents/data/tasks/fleet-a"), { recursive: true });
    writeFileSync(join(root, ".agents/data/tasks/fleet-a/loop-intake.json"), JSON.stringify({ schemaVersion: 1, taskId: "fleet-a", authority: "fleet", requirementHash: "x" }));
    // Record what the lead-side lifecycle CLI receives instead of talking to a coordination service.
    const record = join(root, "remote-state-calls.json");
    writeFileSync(join(root, ".agents/aidlc/scripts/remote-state.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env })); console.log(JSON.stringify({ ok: true, result: { id: "fleet-a", status: "active" } }));\n`);
    const mk = (id: string, status: string, gate: string) => ({ id, title: id, type: "infra", phase: "clarify", gate, status, language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {}, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    const tasks: Record<string, any> = { "fleet-a": mk("fleet-a", "blocked_on_user", "G0_confirm"), "fleet-active": mk("fleet-active", "active", "G0_confirm"), "fleet-wrap": mk("fleet-wrap", "blocked_on_user", "none") };
    const calls: any[] = [];
    const callTool = async ({ name, args }: any) => {
      calls.push({ name, args });
      if (name === "fleet_get") return { revision: 1, fleet: { leads: {}, supervisors: {}, jobs: {}, features: {} } };
      if (name === "task_get") { if (!tasks[args.taskId]) throw new Error("task not found"); return { task: tasks[args.taskId], nextAction: null, revision: 1 }; }
      if (name === "run_claim") return { revision: 2, fleet: { leads: { [args.taskId]: { epoch: 3, ownerToken: args.ownerToken } } } };
      if (name === "run_release") return { revision: 3, fleet: { leads: {} } };
      throw new Error(`unexpected ${name}`);
    };
    const env = { AIDLC_FLEET_URL: "https://fleet.example/mcp", AIDLC_FLEET_WORKSPACE: "ws", AIDLC_FLEET_TOKEN: "lead", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_REVIEWER_TOKEN: "r".repeat(32), AIDLC_UI_TOKEN: "ui" };
    const authority = await createFleetAuthority({ root, agent: "codex", workers: { w1: "codex" }, env, callTool, runCli: async () => ({}) });
    const result = await authority.feedback({ taskId: "fleet-a", reason: "Tighten the scope to the API only", source: "dashboard: felix" });
    assert.deepEqual(result, { ok: true, result: { id: "fleet-a", status: "active" } });
    const recorded = JSON.parse(readFileSync(record, "utf8"));
    assert.deepEqual(recorded.argv, ["task", "status", "fleet-a", "--status", "active", "--mode", "audited", "--reason", "Tighten the scope to the API only", "--source", "dashboard: felix"]);
    assert.equal(recorded.env.AIDLC_FLEET_LEAD_EPOCH, "3", "runs under the lead claim");
    assert.ok(recorded.env.AIDLC_FLEET_LEAD_OWNER_TOKEN, "carries the lead owner token");
    assert.equal(recorded.env.AIDLC_FLEET_REVIEWER_TOKEN, undefined, "feedback never receives the reviewer credential");
    assert.equal(recorded.env.AIDLC_UI_TOKEN, undefined);
    assert.deepEqual(calls.filter((call) => ["run_claim", "run_release"].includes(call.name)).map((call) => call.name), ["run_claim", "run_release"], "claims and releases the lead around the command");
    assert.equal(calls.find((call) => call.name === "run_release")?.args.epoch, 3);
    await assert.rejects(() => authority.feedback({ taskId: "fleet-active", reason: "why", source: "who" }), /not waiting at a human gate/);
    await assert.rejects(() => authority.feedback({ taskId: "fleet-wrap", reason: "why", source: "who" }), /not waiting at a human gate/);
    await assert.rejects(() => authority.feedback({ taskId: "missing", reason: "why", source: "who" }), /Unknown task/);
    await assert.rejects(() => authority.feedback({ taskId: "fleet-a", reason: "  ", source: "who" }), /reason is required/);
    await assert.rejects(() => authority.feedback({ taskId: "fleet-a", reason: "why", source: "" }), /source is required/);
    assert.equal(calls.filter((call) => call.name === "run_claim").length, 1, "rejected feedback never claims the lead");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createLoopAuthority fails fast on a bad roster or limits and never falls back between modes", async () => {
  const { createLoopAuthority } = await loadAuthority();
  const root = mkdtempSync(join(tmpdir(), "aidlc-authority-config-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const agents = { lead: "codex", workers: { w: "codex" } };
    await assert.rejects(() => createLoopAuthority({ root, config: { loop: { mode: "off", agents } } }), /Loop mode is off/);
    await assert.rejects(() => createLoopAuthority({ root, config: { loop: { mode: "local", agents: { lead: "codex", workers: {} } } } }), /lead and worker providers/);
    await assert.rejects(() => createLoopAuthority({ root, config: { loop: { mode: "local", agents, limits: { maxTurns: 0 } } } }), /maxTurns/);
    await assert.rejects(() => createLoopAuthority({ root, config: { loop: { mode: "fleet", agents } }, env: {} }), /AIDLC_FLEET_URL/, "fleet without its remote authority fails closed instead of running locally");
    assert.equal((await createLoopAuthority({ root, config: { loop: { mode: "local", agents } } })).mode, "local");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
