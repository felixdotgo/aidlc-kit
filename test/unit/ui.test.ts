import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { TaskState } from "../../src/model.js";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

const INTENT_CONTENT = [
  "## 📋 Problem",
  "restate the problem",
  "## 🗺️ Affected areas",
  "- root",
  "## 💭 Assumptions",
  "- none",
  "## ❓ Open questions",
  "1. q — *default:* d",
  "## 🎯 Scope",
  "**In:** x **🚫 Out:** y",
].join("\n");

const makeTask = (overrides: Partial<TaskState> = {}): TaskState => {
  const now = new Date().toISOString();
  return {
    id: "task-a", title: "Task A", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active",
    language: "vi", risk: "normal", areas: ["root"], branch: "—",
    artifacts: { intent: ".agents/data/tasks/task-a/intent.md", design: ".agents/data/tasks/task-a/design.md", workplan: ".agents/data/tasks/task-a/workplan.md" },
    decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now, ...overrides,
  };
};

const writeTaskDir = (root: string, taskId: string): void => {
  mkdirSync(join(root, ".agents", "data", "tasks", taskId), { recursive: true });
  writeFileSync(join(root, ".agents", "data", "tasks", taskId, "intent.md"), INTENT_CONTENT);
};

const startFixture = async (task: TaskState = makeTask(), withIntent = false): Promise<{ base: string; token: string; root: string; close: () => Promise<void> }> => {
  const { emptyState, saveState } = await import("../../src/state.js");
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-"));
  const state = emptyState();
  state.tasks[task.id] = task;
  saveState(root, state);
  if (withIntent) writeTaskDir(root, task.id);
  const { server, port, token } = await startUiServer({ root, host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const close = (): Promise<void> => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); rmSync(root, { recursive: true, force: true }); });
  return { base, token, root, close };
};

test("usage documents the ui command", () => {
  assert.match(source("src/cli/argv.ts"), /aidlc-kit ui \[path\] \[--port 4173\] \[--host 127\.0\.0\.1\]/);
});

test("runUi rejects a non-integer --port", () => {
  assert.match(source("src/cli/commands.ts"), /--port must be an integer between 1 and 65535/);
});

test("ui server serves the styled dashboard, vendored CSS, and read-only JSON endpoints", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const home = await fetch(`${fixture.base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /AI-DLC Loop/);
    assert.match(await (await fetch(`${fixture.base}/`)).text(), /bulma\.css/);

    const css = await fetch(`${fixture.base}/assets/bulma.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const tasks = await fetch(`${fixture.base}/api/tasks`);
    assert.equal(tasks.status, 200);
    const summaries = (await tasks.json()) as { items: Array<{ id: string }>; total: number };
    assert.equal(summaries.total, 1);
    assert.equal(summaries.items[0]?.id, "task-a");

    const detail = await fetch(`${fixture.base}/api/tasks/task-a`);
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { task: { id: string } }).task.id, "task-a");

    const missing = await fetch(`${fixture.base}/api/tasks/missing`);
    assert.equal(missing.status, 404);

    const missingStatus = await fetch(`${fixture.base}/api/loop/status`);
    assert.equal(missingStatus.status, 400);

    const badStart = await fetch(`${fixture.base}/api/loop/start`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": fixture.token }, body: JSON.stringify({ requirement: "  " }) });
    assert.equal(badStart.status, 400);

    const badResume = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": fixture.token }, body: JSON.stringify({ taskId: "" }) });
    assert.equal(badResume.status, 400);
  } finally {
    await fixture.close();
  }
});

test("mutating endpoints fail closed without the session token", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const start = await fetch(`${fixture.base}/api/loop/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requirement: "do the thing" }) });
    assert.equal(start.status, 401);

    const resume = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "task-a" }) });
    assert.equal(resume.status, 401);

    const approve = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "task-a", source: "ok" }) });
    assert.equal(approve.status, 401);
  } finally {
    await fixture.close();
  }
});

test("task detail route and artifact endpoint serve artifact content", async () => {
  const fixture = await startFixture(makeTask(), true);
  try {
    const page = await fetch(`${fixture.base}/tasks/task-a`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Task A/);

    const artifact = await fetch(`${fixture.base}/api/tasks/task-a/artifact/intent`);
    assert.equal(artifact.status, 200);
    assert.match(((await artifact.json()) as { content: string }).content, /## 📋 Problem/);

    const unknown = await fetch(`${fixture.base}/api/tasks/task-a/artifact/nope`);
    assert.equal(unknown.status, 404);

    const missingTask = await fetch(`${fixture.base}/api/tasks/missing/artifact/intent`);
    assert.equal(missingTask.status, 404);
  } finally {
    await fixture.close();
  }
});

test("gate view endpoint renders only a blocked task and rejects an active one", async () => {
  const active = await startFixture(makeTask(), true);
  try {
    const rejected = await fetch(`${active.base}/api/tasks/task-a/gate`);
    assert.equal(rejected.status, 409);
  } finally {
    await active.close();
  }

  const blocked = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const gate = await fetch(`${blocked.base}/api/tasks/task-a/gate`);
    assert.equal(gate.status, 200);
    const payload = (await gate.json()) as { gate: string; view: { gate: string; task: { id: string } } };
    assert.equal(payload.gate, "G0_confirm");
    assert.equal(payload.view.gate, "G0_confirm");
    assert.equal(payload.view.task.id, "task-a");
  } finally {
    await blocked.close();
  }
});

test("approve proxy validates inputs and rejects a non-blocked task", async () => {
  const fixture = await startFixture(makeTask(), true);
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    const missingSource = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers, body: JSON.stringify({ taskId: "task-a" }) });
    assert.equal(missingSource.status, 400);

    const missingTask = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers, body: JSON.stringify({ source: "ok" }) });
    assert.equal(missingTask.status, 400);

    const activeTask = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers, body: JSON.stringify({ taskId: "task-a", source: "ok" }) });
    assert.equal(activeTask.status, 409);
  } finally {
    await fixture.close();
  }
});

test("SSE endpoint streams the loop event-log sidecar", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const logPath = join(fixture.root, ".agents", "data", "loop", "ui-events.jsonl");
    mkdirSync(join(fixture.root, ".agents", "data", "loop"), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ type: "daemon_poll", actionable: [] })}\n`);
    appendFileSync(logPath, `${JSON.stringify({ type: "agent_text", text: "hello" })}\n`);

    const response = await fetch(`${fixture.base}/api/events`, { headers: { "last-event-id": "0" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const chunk = new TextDecoder().decode(first.value);
    assert.match(chunk, /data: .*daemon_poll/);
    assert.match(chunk, /data: .*agent_text/);
    await reader.cancel();
  } finally {
    await fixture.close();
  }
});

test("loop-stream sidecar appends JSONL when AIDLC_LOOP_EVENT_LOG is set", async () => {
  const logPath = join(mkdtempSync(join(tmpdir(), "aidlc-events-")), "events.jsonl");
  const previous = process.env.AIDLC_LOOP_EVENT_LOG;
  process.env.AIDLC_LOOP_EVENT_LOG = logPath;
  try {
    // @ts-ignore -- runtime conformance; assets are copied to dist by build-assets
    const { streamLog } = await import("../../assets/.agents/aidlc/scripts/lib/loop-stream.mjs");
    streamLog({ type: "daemon_poll", actionable: [] });
    streamLog({ type: "agent_text", text: "hello" });
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}"), { type: "daemon_poll", actionable: [] });
    assert.deepEqual(JSON.parse(lines[1] ?? "{}"), { type: "agent_text", text: "hello" });
  } finally {
    if (previous === undefined) delete process.env.AIDLC_LOOP_EVENT_LOG;
    else process.env.AIDLC_LOOP_EVENT_LOG = previous;
    rmSync(logPath, { force: true });
  }
});
