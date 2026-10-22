import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";
import type { InitOptions } from "../../src/model.js";

test("a live loop lease rejects local gate approval until the runner releases it", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-loop-gate-"));
  const options: InitOptions = { root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false };
  const script = join(root, ".agents/aidlc/scripts/state.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  try {
    applyPlan(root, planInit(options));
    const id = "loop-gate-fixture";
    assert.equal(run("task", "create", id, "--title", "Loop gate fixture").status, 0);
    const taskDir = join(root, ".agents/data/tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), "# Intent\n\n## 📋 Problem\nx\n## 🗺️ Affected areas\nx\n## 💭 Assumptions\nx\n## ❓ Open questions\nnone\n## 🎯 Scope\nx\n");
    assert.equal(run("task", "status", id, "--status", "blocked_on_user").status, 0);

    const leasePath = join(root, ".agents/data/loop", `${id}.lease`);
    mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
    writeFileSync(leasePath, JSON.stringify({ schemaVersion: 1, taskId: id, runId: "fixture", pid: process.pid, token: "fixture-token", createdAt: new Date().toISOString() }));
    const blocked = run("gate", "approve", id, "--gate", "G0_confirm", "--source", "forged loop approval");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /loop runner owns/);
    const stateBefore = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    assert.equal(stateBefore.tasks[id].phase, "clarify");
    assert.equal(stateBefore.tasks[id].evidence.filter((entry: { kind: string }) => entry.kind === "approval").length, 0);

    unlinkSync(leasePath);
    const approved = run("gate", "approve", id, "--gate", "G0_confirm", "--source", "explicit human approval");
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(JSON.parse(approved.stdout).result.task.phase, "plan");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
