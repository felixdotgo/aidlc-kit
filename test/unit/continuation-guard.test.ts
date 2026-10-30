import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("task-next guard rejects final responses across multi-item and premature G2 states", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-continuation-"));
  try {
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    const task = { id: "continue-task", title: "Continue", type: "infra", phase: "build", gate: "G2_codereview", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {}, decisions: [], tasks: [{ id: "T1", label: "First", status: "done" }, { id: "T2", label: "Second", status: "todo" }], evidence: [] as Array<Record<string, string>>, createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" };
    const statePath = join(root, ".agents/data/state/aidlc-state.json");
    mkdirSync(join(root, ".agents/aidlc"), { recursive: true });
    const run = () => spawnSync(process.execPath, [resolve("dist/assets/.agents/aidlc/scripts/task-next.mjs"), task.id, "--root", root, "--require-stop"], { encoding: "utf8" });
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 3, tasks: { [task.id]: task }, archive: {} })}\n`);
    const active = run(); assert.equal(active.status, 2); assert.match(active.stdout, /--item T2/);
    assert.match(active.stderr, /expected pause, not a failure/);
    const envelope = JSON.parse(active.stdout);
    const command = envelope.nextAction.command;
    assert.ok(command.includes(`node ${JSON.stringify(join(root, ".agents/aidlc/scripts/context.mjs"))}`));
    assert.ok(command.includes(`--root ${JSON.stringify(root)}`));
    assert.equal(envelope.continuation.required, true);
    assert.equal(envelope.continuation.code, "CONTINUATION_REQUIRED");
    assert.equal(envelope.continuation.taskId, task.id);
    assert.equal(envelope.continuation.command, command);
    assert.equal(envelope.continuation.itemId, "T2");
    assert.equal(envelope.continuation.remainingItems, 1);
    const stderrRecord = JSON.parse((active.stderr.split("\n")[0] ?? "").replace(/^CONTINUATION_REQUIRED: /, ""));
    assert.deepEqual({ taskId: stderrRecord.taskId, command: stderrRecord.command }, { taskId: task.id, command });
    assert.ok(stderrRecord.reason.length > 0);

    task.status = "blocked_on_user";
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 3, tasks: { [task.id]: task }, archive: {} })}\n`);
    const premature = run(); assert.equal(premature.status, 2); assert.match(premature.stdout, /premature G2/);

    task.tasks[1]!.status = "done";
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 3, tasks: { [task.id]: task }, archive: {} })}\n`);
    const unverified = run(); assert.equal(unverified.status, 2); assert.match(unverified.stdout, /verification and adversarial review/);

    task.evidence = [
      { kind: "approval", gate: "G1_review", source: "human", result: "pass", recordedAt: "2026-08-14T00:00:01.000Z" },
      { kind: "test", area: "root", source: "test", result: "pass", recordedAt: "2026-08-14T00:00:02.000Z" },
      { kind: "review", source: "review", result: "pass", recordedAt: "2026-08-14T00:00:03.000Z" }
    ];
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 3, tasks: { [task.id]: task }, archive: {} })}\n`);
    const waiting = run(); assert.equal(waiting.status, 0);
    const stopAllowed = JSON.parse(waiting.stdout).continuation;
    assert.deepEqual(stopAllowed, { required: false, code: "STOP_ALLOWED", taskId: task.id, classification: "await_user" });
    assert.equal(waiting.stderr.includes("CONTINUATION_REQUIRED"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
