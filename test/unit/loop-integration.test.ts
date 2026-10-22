import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";
import type { InitOptions } from "../../src/model.js";

const loadRuntime = async (): Promise<{ runLoop: (options: Record<string, unknown>) => Promise<any> }> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-runtime.mjs"));
const runState = (root: string, ...args: string[]): any => JSON.parse(execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args], { cwd: root, encoding: "utf8" }));
const intent = "# Intent\n\n## 📋 Problem\nLoop fixture\n## 🗺️ Affected areas\nroot\n## 💭 Assumptions\nnone\n## ❓ Open questions\nnone\n## 🎯 Scope\nImplement fixture\n";
const design = "# Design\n\n## 🧩 Solution per affected area\nroot\n## 📌 Spec traceability\nfixture\n## 🔗 Cross-service contracts\nnone\n## ⚠️ Risks / edge cases\nnone\n";

const fixture = async (name: string, run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), `aidlc-loop-${name}-`));
  const priorPath = process.env.PATH;
  try {
    const options: InitOptions = { root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false };
    applyPlan(root, planInit(options));
    const fakeCodex = join(root, "codex");
    writeFileSync(fakeCodex, "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('codex-fixture'); process.exit(0); }\nprocess.exit(3);\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${root}${delimiter}${priorPath ?? ""}`;
    await run(root);
  } finally {
    process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
};

test("supervised task stops at all three human gates and resumes through completion", { skip: process.platform === "win32" }, async () => {
  await fixture("gates", async (root) => {
    const id = "loop-gates";
    runState(root, "task", "create", id, "--title", "Loop gates");
    const taskDir = join(root, ".agents/data/tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), intent);
    const { runLoop } = await loadRuntime();
    const driver = async ({ onSessionId, onEvent }: { onSessionId: (id: string) => void; onEvent: (event: unknown) => void }) => {
      onSessionId("loop-session");
      const phase = runState(root, "task", "show", id).result.phase;
      if (phase === "clarify") {
        runState(root, "task", "status", id, "--status", "blocked_on_user");
        onEvent({ type: "lifecycle_command", command: "task status", exitCode: 0, status: "completed" });
        throw new Error("transport dropped after committed gate wait");
      }
      if (phase === "plan") {
        writeFileSync(join(taskDir, "design.md"), design);
        runState(root, "task", "item", id, "T1", "--status", "todo");
        runState(root, "task", "status", id, "--status", "blocked_on_user");
      } else if (phase === "build") {
        runState(root, "task", "item", id, "T1", "--status", "done");
        runState(root, "evidence", "add", id, "--kind", "test", "--result", "pass", "--source", "fixture test");
        runState(root, "evidence", "add", id, "--kind", "review", "--result", "pass", "--source", "fixture review");
        runState(root, "task", "status", id, "--status", "blocked_on_user");
      } else if (phase === "wrap") {
        runState(root, "lesson", "none", id, "--reason", "none", "--source", "fixture");
        runState(root, "task", "archive", id, "--reason", "complete", "--source", "fixture");
      } else throw new Error(`Unexpected phase: ${phase}`);
      onEvent({ type: "lifecycle_command", command: "fixture mutation", exitCode: 0, status: "completed" });
      return { sessionId: "loop-session", resultText: "done", diagnostics: [] };
    };
    const first = await runLoop({ root, taskId: id, agent: "codex", driver });
    assert.equal(first.status, "gate"); assert.equal(first.nextAction.gate, "G0_confirm");
    assert.match(first.gateView, /Confirm requirements/);
    assert.equal(runState(root, "task", "show", id).result.evidence.filter((entry: { kind: string }) => entry.kind === "approval").length, 0);

    runState(root, "gate", "approve", id, "--gate", "G0_confirm", "--source", "human confirms");
    const notices: unknown[] = [];
    const second = await runLoop({ root, taskId: id, mode: "resume", driver, onEvent: (event: unknown) => notices.push(event) });
    assert.ok(notices.some((event: any) => event.type === "context_changed"));
    assert.equal(second.status, "gate"); assert.equal(second.nextAction.gate, "G1_review");
    runState(root, "gate", "approve", id, "--gate", "G1_review", "--source", "human approves plan");
    const third = await runLoop({ root, taskId: id, mode: "resume", driver });
    assert.equal(third.status, "gate"); assert.equal(third.nextAction.gate, "G2_codereview");
    runState(root, "gate", "approve", id, "--gate", "G2_codereview", "--source", "human approves code");
    const fourth = await runLoop({ root, taskId: id, mode: "resume", driver });
    assert.equal(fourth.status, "complete"); assert.equal(fourth.nextAction.classification, "complete");
  });
});

test("two no-progress turns pause without inventing completion and resume from canonical state", { skip: process.platform === "win32" }, async () => {
  await fixture("stall", async (root) => {
    const id = "loop-stall";
    runState(root, "task", "create", id, "--title", "Loop stall");
    const taskDir = join(root, ".agents/data/tasks", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "intent.md"), intent);
    const { runLoop } = await loadRuntime();
    const noProgress = async ({ onSessionId }: { onSessionId: (id: string) => void }) => { onSessionId("stall-session"); return { sessionId: "stall-session", resultText: "", diagnostics: [] }; };
    const stopped = await runLoop({ root, taskId: id, agent: "codex", driver: noProgress, limits: { maxTurns: 3, maxStallTurns: 2 } });
    assert.equal(stopped.status, "paused");
    assert.match(stopped.stopReason, /without observable progress/);
    assert.equal(runState(root, "task", "show", id).result.status, "paused");
    const record = JSON.parse(readFileSync(join(root, ".agents/data/loop", `${id}.json`), "utf8"));
    assert.equal(record.iteration, 2);
    const progress = async ({ onSessionId }: { onSessionId: (id: string) => void }) => {
      onSessionId("stall-session");
      runState(root, "task", "status", id, "--status", "blocked_on_user");
      return { sessionId: "stall-session", resultText: "ready", diagnostics: [] };
    };
    const resumed = await runLoop({ root, taskId: id, mode: "resume", driver: progress });
    assert.equal(resumed.status, "gate"); assert.equal(resumed.nextAction.gate, "G0_confirm");
  });
});
