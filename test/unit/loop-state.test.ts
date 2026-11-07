import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const scripts = resolve("dist/assets/.agents/aidlc/scripts");
const runtime = await import(pathToFileURL(join(scripts, "lib/loop-runtime.mjs")).href);
const lease = await import(pathToFileURL(join(scripts, "lib/loop-lease.mjs")).href);

function fixture(status = "active") {
  const root = mkdtempSync(join(tmpdir(), "aidlc-loop-"));
  cpSync(resolve("dist/assets/.agents/aidlc"), join(root, ".agents/aidlc"), { recursive: true });
  mkdirSync(join(root, ".agents/data/state"), { recursive: true });
  const taskId = "loop-test";
  const task = { id: taskId, title: "Loop fixture", type: "infra", phase: "clarify", gate: "G0_confirm", status, language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: `.agents/data/tasks/${taskId}/intent.md`, design: `.agents/data/tasks/${taskId}/design.md`, workplan: `.agents/data/tasks/${taskId}/workplan.md` }, decisions: [], tasks: [], evidence: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" };
  writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), JSON.stringify({ schemaVersion: 4, tasks: { [taskId]: task }, archive: {} }));
  mkdirSync(join(root, ".agents/data/tasks", taskId), { recursive: true });
  writeFileSync(join(root, task.artifacts.intent), "## 📋 Problem\nA\n## 🗺️ Affected areas\nroot\n## 💭 Assumptions\nA\n## ❓ Open questions\nNone\n## 🎯 Scope\nA\n");
  return { root, taskId };
}

test("loop stops at a gate without approving it", async () => {
  const { root, taskId } = fixture();
  try {
    let turns = 0;
    const result = await runtime.runLoop({ root, taskId, agent: "codex", driver: async ({ onSessionId, sessionId }: { onSessionId: (id: string) => void, sessionId?: string }) => {
      turns++;
      assert.equal(sessionId, undefined);
      onSessionId("thread-123");
      execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", taskId, "--status", "blocked_on_user", "--root", root]);
      return { sessionId: "thread-123", resultText: "ready", diagnostics: [] };
    } });
    assert.equal(turns, 1);
    assert.equal(result.status, "gate");
    assert.match(result.gateView, /Confirm requirements/);
    const state = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    assert.equal(state.tasks[taskId].evidence.filter((e: { kind: string }) => e.kind === "approval").length, 0);
    assert.equal(lease.readLiveLease(root, taskId), null);
    assert.equal(runtime.readLoopRecord(root, taskId).sessionId, "thread-123");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("two no-progress turns create an audited resumable pause", async () => {
  const { root, taskId } = fixture();
  try {
    let turns = 0;
    const result = await runtime.runLoop({ root, taskId, agent: "claude", driver: async ({ onSessionId }: { onSessionId: (id: string) => void }) => { turns++; onSessionId("session-123"); return { sessionId: "session-123", resultText: "", diagnostics: [] }; } });
    assert.equal(turns, 2);
    assert.equal(result.status, "paused");
    assert.match(result.stopReason, /without observable progress/);
    assert.equal(runtime.readLoopRecord(root, taskId).pausedByLoop, true);
    const state = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    assert.equal(state.tasks[taskId].status, "paused");
    assert.ok(state.tasks[taskId].evidence.some((e: { kind: string, detail?: string }) => e.kind === "diagnostic" && e.detail?.includes("Paused while active")));
    assert.equal(lease.readLiveLease(root, taskId), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live lease blocks a duplicate runner and dead owner can be reclaimed", () => {
  const { root, taskId } = fixture();
  try {
    const release = lease.acquireLoopLease(root, taskId, "run-a");
    assert.equal(lease.readLiveLease(root, taskId).purpose, "loop run run-a");
    assert.equal(lease.readLiveLease(root, taskId).activity, "turn");
    assert.throws(() => lease.acquireLoopLease(root, taskId, "run-b"), /live loop runner/);
    release();
    const path = lease.loopLeasePath(root, taskId);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, taskId, runId: "dead", pid: 2147483647, token: "dead", createdAt: new Date().toISOString() }));
    const releaseReclaimed = lease.acquireLoopLease(root, taskId, "run-c");
    assert.equal(lease.readLiveLease(root, taskId).purpose, "loop run run-c");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 2);
    releaseReclaimed();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task lease activity gates approval: waiting allows it, turn (supervised or manual) refuses it", () => {
  const { root, taskId } = fixture("blocked_on_user");
  const approve = () => spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "gate", "approve", taskId, "--gate", "G0_confirm", "--source", "yes", "--root", root], { encoding: "utf8" });
  try {
    const supervisor = lease.acquireTaskLease(root, taskId, { activity: "waiting", label: "supervisor" });
    assert.equal(lease.readLiveLease(root, taskId), null);
    supervisor.setActivity("turn");
    assert.equal(lease.readLiveLease(root, taskId).activity, "turn");
    let result = approve();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Gate approval is unavailable while loop runner owns loop-test; .*task lease held by pid \d+ on .*activity turn.*loop-entry\.mjs leases loop-test/);
    supervisor.release();
    const manual = lease.acquireLoopLease(root, taskId, "manual");
    result = approve();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /loop runner owns/);
    manual();
    const waiting = lease.acquireTaskLease(root, taskId, { activity: "waiting", label: "supervisor" });
    result = approve();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    waiting.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a supervised runLoop shares the supervisor's task lease and returns it to waiting", async () => {
  const { root, taskId } = fixture();
  try {
    const supervisor = lease.acquireTaskLease(root, taskId, { activity: "waiting", label: "supervisor" });
    const seen: any[] = [];
    const result = await runtime.runLoop({ root, taskId, agent: "codex", driver: async ({ onSessionId }: { onSessionId: (id: string) => void }) => {
      seen.push(lease.readLiveLease(root, taskId));
      onSessionId("thread-1");
      execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "status", taskId, "--status", "blocked_on_user", "--root", root]);
      return { sessionId: "thread-1", resultText: "", diagnostics: [] };
    } });
    assert.equal(result.status, "gate");
    assert.equal(seen[0]?.token, supervisor.token);
    assert.equal(seen[0]?.activity, "turn");
    const onDisk = JSON.parse(readFileSync(lease.loopLeasePath(root, taskId), "utf8"));
    assert.equal(onDisk.token, supervisor.token);
    assert.equal(onDisk.activity, "waiting");
    assert.equal(lease.readLiveLease(root, taskId), null);
    const status = runtime.loopStatus(root, taskId);
    assert.equal(status.liveLease, null);
    assert.equal(status.lease.state, "live");
    assert.equal(status.lease.holder.activity, "waiting");
    supervisor.release();
    assert.equal(runtime.loopStatus(root, taskId).lease.state, "absent");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a legacy supervisor lease: a live one refuses with an upgrade hint, a dead one is cleaned up", () => {
  const { root, taskId } = fixture();
  try {
    const legacy = join(root, ".agents/data/loop", `${taskId}.supervisor.lease`);
    mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ taskId, pid: process.pid, token: "old" }));
    assert.throws(() => lease.acquireTaskLease(root, taskId, { label: "supervisor" }), /previous aidlc-kit version is still running .*stop the loop daemon/);
    writeFileSync(legacy, JSON.stringify({ taskId, pid: 2147483647, token: "old" }));
    writeFileSync(join(root, ".agents/data/loop", `${taskId}.supervisor.guard`), JSON.stringify({ taskId, pid: 2147483647, token: "g" }));
    const old = (Date.now() - 60000) / 1000;
    utimesSync(join(root, ".agents/data/loop", `${taskId}.supervisor.guard`), old, old);
    const handle = lease.acquireTaskLease(root, taskId, { label: "supervisor" });
    assert.equal(existsSync(legacy), false);
    assert.equal(existsSync(join(root, ".agents/data/loop", `${taskId}.supervisor.guard`)), false);
    handle.release();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt record and dangling symlink fail closed", () => {
  const { root, taskId } = fixture();
  try {
    const path = runtime.loopRecordPath(root, taskId);
    mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
    writeFileSync(path, "{");
    assert.throws(() => runtime.readLoopRecord(root, taskId), /Corrupt loop run record/);
    rmSync(path);
    symlinkSync(join(root, "missing-target"), path);
    assert.throws(() => runtime.readLoopRecord(root, taskId), /symlink/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI validates the configurable stall threshold before starting an agent", () => {
  const { root, taskId } = fixture();
  try {
    const result = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/loop.mjs"), "run", taskId, "--agent", "codex", "--max-stall-turns", "0", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /maxStallTurns must be an integer/);
    assert.equal(runtime.readLoopRecord(root, taskId), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
