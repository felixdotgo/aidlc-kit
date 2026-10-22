import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    assert.equal(lease.readLiveLease(root, taskId).runId, "run-a");
    assert.throws(() => lease.acquireLoopLease(root, taskId, "run-b"), /live loop runner/);
    release();
    const path = lease.loopLeasePath(root, taskId);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, taskId, runId: "dead", pid: 2147483647, token: "dead", createdAt: new Date().toISOString() }));
    const releaseReclaimed = lease.acquireLoopLease(root, taskId, "run-c");
    assert.equal(lease.readLiveLease(root, taskId).runId, "run-c");
    releaseReclaimed();
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
