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
  const result = actionableTasks(state, ".");
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
  assert.deepEqual(actionableTasks(state, "."), []);
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
