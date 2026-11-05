import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TaskState } from "../../src/model.js";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

test("usage documents the ui command", () => {
  assert.match(source("src/cli/argv.ts"), /aidlc-kit ui \[path\] \[--port 4173\] \[--host 127\.0\.0\.1\]/);
});

test("runUi rejects a non-integer --port", () => {
  assert.match(source("src/cli/commands.ts"), /--port must be an integer between 1 and 65535/);
});

test("ui server serves the dashboard and read-only JSON endpoints", async () => {
  const { emptyState, saveState } = await import("../../src/state.js");
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-"));
  const now = new Date().toISOString();
  const task: TaskState = {
    id: "task-a", title: "Task A", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active",
    language: "vi", risk: "normal", areas: ["root"], branch: "—",
    artifacts: { intent: ".agents/data/tasks/task-a/intent.md", design: ".agents/data/tasks/task-a/design.md", workplan: ".agents/data/tasks/task-a/workplan.md" },
    decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now,
  };
  const state = emptyState();
  state.tasks["task-a"] = task;
  saveState(root, state);
  const { server, port } = await startUiServer({ root, host: "127.0.0.1", port: 0 });
  try {
    const base = `http://127.0.0.1:${port}`;

    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /AI-DLC Loop/);

    const tasks = await fetch(`${base}/api/tasks`);
    assert.equal(tasks.status, 200);
    const summaries = (await tasks.json()) as { items: Array<{ id: string }>; total: number };
    assert.equal(summaries.total, 1);
    assert.equal(summaries.items[0]?.id, "task-a");

    const detail = await fetch(`${base}/api/tasks/task-a`);
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { task: { id: string } }).task.id, "task-a");

    const missing = await fetch(`${base}/api/tasks/missing`);
    assert.equal(missing.status, 404);

    const missingStatus = await fetch(`${base}/api/loop/status`);
    assert.equal(missingStatus.status, 400);

    const badStart = await fetch(`${base}/api/loop/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requirement: "  " }) });
    assert.equal(badStart.status, 400);

    const badResume = await fetch(`${base}/api/loop/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "" }) });
    assert.equal(badResume.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
