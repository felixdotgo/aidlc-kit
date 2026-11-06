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
    const homeHtml = await home.text();
    assert.match(homeHtml, /<title>Loop<\/title>/);
    assert.match(homeHtml, /<span class="ad-logo" aria-hidden="true">L<\/span>Loop<\/a>/);
    assert.doesNotMatch(homeHtml, /AI-DLC Loop/);
    assert.match(homeHtml, /href="\/assets\/bulma\.css"[\s\S]*href="\/assets\/dashboard\.css"/, "theme layer loads after Bulma");
    assert.match(homeHtml, /<meta name="color-scheme" content="light dark">/);

    const css = await fetch(`${fixture.base}/assets/bulma.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const theme = await fetch(`${fixture.base}/assets/dashboard.css`);
    assert.equal(theme.status, 200);
    assert.match(theme.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await theme.text(), /prefers-color-scheme: dark/);

    assert.equal((await fetch(`${fixture.base}/assets/missing.css`)).status, 404);

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
    const strip = (line: string | undefined): Record<string, unknown> => { const { at, ...rest } = JSON.parse(line ?? "{}"); assert.match(String(at), /^\d{4}-\d{2}-\d{2}T/); return rest; };
    assert.deepEqual(strip(lines[0]), { type: "daemon_poll", actionable: [] });
    assert.deepEqual(strip(lines[1]), { type: "agent_text", text: "hello" });
  } finally {
    if (previous === undefined) delete process.env.AIDLC_LOOP_EVENT_LOG;
    else process.env.AIDLC_LOOP_EVENT_LOG = previous;
    rmSync(logPath, { force: true });
  }
});

test("markdownToHtml renders a minimal subset and escapes HTML", async () => {
  const { markdownToHtml } = await import("../../src/task-ui.js");
  assert.match(markdownToHtml("## Heading\n\n- a\n- b"), /<h2>Heading<\/h2>/);
  assert.match(markdownToHtml("## Heading\n\n- a\n- b"), /<ul>/);
  assert.match(markdownToHtml("**bold** and `code`"), /<strong>bold<\/strong>/);
  assert.match(markdownToHtml("**bold** and `code`"), /<code>code<\/code>/);
  assert.match(markdownToHtml("| a | b |\n| - | - |\n| 1 | 2 |"), /<table/);
  assert.match(markdownToHtml("```\ncode\n```"), /<pre><code>/);
  assert.equal(markdownToHtml("<script>alert(1)</script>").includes("<script>"), false);
  assert.match(markdownToHtml("<script>alert(1)</script>"), /&lt;script&gt;/);
  assert.equal(markdownToHtml("[x](javascript:alert(1))").includes("javascript:"), false);
});

test("dashboard renders kanban as the default view with phase columns, modals, and the task side panel", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /id="kanban-view"/);
    assert.match(html, /<div id="task-drawer" class="ad-drawer" role="dialog" aria-modal="true"[^>]*hidden>/);
    assert.match(html, /id="task-drawer-open"/);
    assert.doesNotMatch(html, /id="task-modal"/);
    assert.match(html, /openTaskDrawer/);
    assert.match(html, /history\.pushState/);
    const containers = html.match(/class="container[^"]*"/g) ?? [];
    assert.ok(containers.length >= 2);
    assert.ok(containers.every((value) => value.includes("is-fluid")), "every dashboard container is full-width");
    assert.match(html, /id="list-view" style="display:none"/);
    assert.match(html, /New task/);
    assert.match(html, /Settings/);
    assert.match(html, />clarify</);
  } finally {
    await fixture.close();
  }
});

test("task detail renders artifacts and gate view as structured HTML, not raw JSON", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const page = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.match(page, /Review step · Confirm requirements/);
    assert.doesNotMatch(page, /schemaVersion/);
    assert.match(page, /<h2>📋 Problem<\/h2>/);
  } finally {
    await fixture.close();
  }
});

test("partial task detail fragment serves side-panel content without a full page", async () => {
  const fixture = await startFixture(makeTask(), true);
  try {
    const res = await fetch(`${fixture.base}/partial/tasks/task-a`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Task A/);
    assert.doesNotMatch(html, /<html/);
    assert.match(html, /class="ad-stepper"/);
    assert.ok(html.indexOf('class="ad-stepper"') < html.indexOf("<h2>Artifacts</h2>"), "progress renders before artifacts");
    assert.doesNotMatch(html, /Loop status/);
  } finally {
    await fixture.close();
  }
});

test("task detail page declares `post` exactly once so the approve handler is not shadowed by a redeclaration", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const html = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    // The shared script and the detail script are both inlined on the detail
    // page. A second top-level `const post` in the detail script would throw
    // "Identifier 'post' has already been declared" at parse time, silently
    // disabling the approve-button handler (regression guard for the UI bug).
    assert.equal((html.match(/const post\s*=/g) ?? []).length, 1);
    assert.match(html, /approve-button/);
    assert.match(html, /\/api\/gate\/approve/);
  } finally {
    await fixture.close();
  }
});

/* Installed-workflow fixture: real state.mjs/loop-entry.mjs with a local loop config. */
const startInstalledFixture = async (): Promise<{ base: string; token: string; root: string; close: () => Promise<void>; state: (...args: string[]) => any }> => {
  const { applyPlan, planInit } = await import("../../src/installer.js");
  const { startUiServer } = await import("../../src/task-ui.js");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-installed-"));
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
  const configPath = join(root, ".agents", "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.loop = { mode: "local", agents: { lead: "codex", workers: { "worker-a": "codex" } } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  // A live lock owned by this test process keeps ensureDaemon from spawning a real daemon.
  mkdirSync(join(root, ".agents", "data", "loop"), { recursive: true });
  writeFileSync(join(root, ".agents", "data", "loop", "daemon.lock"), JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "test", startedAt: new Date().toISOString() }));
  const state = (...args: string[]): any => JSON.parse(execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args, "--root", root], { encoding: "utf8" }));
  const { server, port, token } = await startUiServer({ root, host: "127.0.0.1", port: 0 });
  const close = (): Promise<void> => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, token, root, close, state };
};

test("new task creates a loop-owned task through intake and reuses the live daemon", { skip: process.platform === "win32" }, async () => {
  const fixture = await startInstalledFixture();
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    const first = await fetch(`${fixture.base}/api/loop/start`, { method: "POST", headers, body: JSON.stringify({ requirement: "Add login retry\nwith backoff" }) });
    assert.equal(first.status, 201);
    const created = (await first.json()) as { taskId: string; title: string; daemon: { pid: number; started: boolean } };
    assert.equal(created.taskId, "add-login-retry");
    assert.equal(created.title, "Add login retry");
    assert.deepEqual(created.daemon, { pid: process.pid, started: false });
    assert.equal(fixture.state("task", "show", "add-login-retry").result.status, "active");
    assert.ok(readFileSync(join(fixture.root, ".agents/data/tasks/add-login-retry/loop-intake.json"), "utf8").includes("\"authority\":\"local\""));

    // A second loop task is allowed while the first (loop-owned) one is actionable, with a de-duplicated id.
    const second = await fetch(`${fixture.base}/api/loop/start`, { method: "POST", headers, body: JSON.stringify({ requirement: "Add login retry" }) });
    assert.equal(second.status, 201);
    assert.equal(((await second.json()) as { taskId: string }).taskId, "add-login-retry-2");

    // An actionable interactive (non-loop) task blocks intake instead of being silently switched away from.
    fixture.state("task", "create", "manual-work", "--title", "Manual", "--switch-from", "add-login-retry,add-login-retry-2");
    const blocked = await fetch(`${fixture.base}/api/loop/start`, { method: "POST", headers, body: JSON.stringify({ requirement: "Another thing" }) });
    assert.equal(blocked.status, 409);
    assert.match(((await blocked.json()) as { error: string }).error, /interactive work is actionable: manual-work/);
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(join(fixture.root, ".agents/data/tasks/another-thing")), false);

    // A create failure after intake files are written rolls them back (no orphan loop-intake.json).
    const { execFileSync } = await import("node:child_process");
    fixture.state("task", "status", "manual-work", "--status", "paused", "--mode", "audited", "--reason", "test", "--source", "test");
    assert.throws(() => execFileSync(process.execPath, [join(fixture.root, ".agents/aidlc/scripts/loop-entry.mjs"), "intake", "Manual-Work", fixture.root], { input: "Collides by case", stdio: ["pipe", "pipe", "pipe"] }), /collides case-insensitively/);
    assert.equal(existsSync(join(fixture.root, ".agents/data/tasks/Manual-Work/loop-intake.json")), false);
  } finally {
    await fixture.close();
  }
});

test("resume re-activates only a paused task and points gate waits to approval", { skip: process.platform === "win32" }, async () => {
  const fixture = await startInstalledFixture();
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    fixture.state("task", "create", "paused-task", "--title", "Paused");
    const active = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers, body: JSON.stringify({ taskId: "paused-task" }) });
    assert.equal(active.status, 409);

    fixture.state("task", "status", "paused-task", "--status", "paused", "--mode", "audited", "--reason", "test", "--source", "test");
    const home = await (await fetch(`${fixture.base}/`)).text();
    assert.match(home, /data-resume="paused-task"/);
    assert.match(home, /daemon running · pid/);

    const resumed = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers, body: JSON.stringify({ taskId: "paused-task" }) });
    assert.equal(resumed.status, 200);
    assert.equal(fixture.state("task", "show", "paused-task").result.status, "active");

    const missing = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers, body: JSON.stringify({ taskId: "nope" }) });
    assert.equal(missing.status, 404);

    fixture.state("task", "create", "handed-off", "--title", "Handed off", "--switch-from", "paused-task");
    fixture.state("task", "handoff", "handed-off", "--kind", "other", "--reason", "test", "--source", "test");
    const handoff = await fetch(`${fixture.base}/api/loop/resume`, { method: "POST", headers, body: JSON.stringify({ taskId: "handed-off" }) });
    assert.equal(handoff.status, 409);
    assert.match(((await handoff.json()) as { error: string }).error, /handed off/);
    assert.match(await (await fetch(`${fixture.base}/`)).text(), /href="\/tasks\/handed-off"[^>]*>handoff<\/a>/);
  } finally {
    await fixture.close();
  }

  const gated = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const res = await fetch(`${gated.base}/api/loop/resume`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": gated.token }, body: JSON.stringify({ taskId: "task-a" }) });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /approve it on the task detail page/);
    const home = await (await fetch(`${gated.base}/`)).text();
    assert.match(home, /href="\/tasks\/task-a">approve<\/a>/);
    assert.doesNotMatch(home, /data-resume="task-a"/);
  } finally {
    await gated.close();
  }
});

/** Reads an SSE response until `done(text)` holds or the timeout elapses. */
const readSse = async (url: string, done: (text: string) => boolean, headers: Record<string, string> = {}, timeoutMs = 3000): Promise<string> => {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!done(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), new Promise<null>((resolveWait) => setTimeout(() => resolveWait(null), Math.max(1, deadline - Date.now())))]);
      if (!next || next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally { controller.abort(); }
  return text;
};
// Only complete events (terminated by a blank line) count; a chunk may end mid-event.
const sseData = (text: string): any[] => text.split("\n\n").slice(0, -1).flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))));

test("SSE replays only the last lines, filters by task, and waits for complete lines", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const dir = join(fixture.root, ".agents", "data", "loop");
    const logPath = join(dir, "ui-events.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, Array.from({ length: 250 }, (_x, n) => JSON.stringify({ type: "agent_text", taskId: n % 2 ? "odd" : "even", n })).join("\n") + "\n");

    const all = sseData(await readSse(`${fixture.base}/api/events`, (text) => sseData(text).length >= 200));
    assert.equal(all.length, 200);
    assert.equal(all[0].n, 50);
    assert.equal(all[199].n, 249);

    const odd = sseData(await readSse(`${fixture.base}/api/events?task-id=odd`, (text) => sseData(text).length >= 125));
    assert.equal(odd.length, 125);
    assert.ok(odd.every((event) => event.taskId === "odd"));

    // A half-written line is held back until its newline arrives.
    const controller = new AbortController();
    const response = await fetch(`${fixture.base}/api/events?task-id=live`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const pump = (async () => { try { for (;;) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); } } catch { /* aborted */ } })();
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    appendFileSync(logPath, '{"type":"agent_text","taskId":"live","text":"par');
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.equal(sseData(text).length, 0);
    appendFileSync(logPath, 'tial"}\n');
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.deepEqual(sseData(text).map((event) => event.text), ["partial"]);

    // Rotation (new inode) restarts from the beginning of the new file.
    const { renameSync } = await import("node:fs");
    renameSync(logPath, `${logPath}.1`);
    writeFileSync(logPath, `${JSON.stringify({ type: "agent_text", taskId: "live", text: "rotated" })}\n`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    assert.deepEqual(sseData(text).map((event) => event.text), ["partial", "rotated"]);
    controller.abort();
    await pump;
  } finally {
    await fixture.close();
  }
});

test("SSE resumes from a Last-Event-ID offset and restarts after truncation", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const dir = join(fixture.root, ".agents", "data", "loop");
    const logPath = join(dir, "ui-events.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(logPath, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2 })}\n`);
    const first = await readSse(`${fixture.base}/api/events`, (text) => sseData(text).length >= 2);
    const lastId = first.split("\n").filter((line) => line.startsWith("id: ")).pop()!.slice(4);
    appendFileSync(logPath, `${JSON.stringify({ n: 3 })}\n`);
    const resumed = sseData(await readSse(`${fixture.base}/api/events`, (text) => sseData(text).length >= 1, { "last-event-id": lastId }));
    assert.deepEqual(resumed.map((event) => event.n), [3]);

    // A Last-Event-ID from a rotated-away file (other inode) replays the tail instead of the whole file.
    const stale = sseData(await readSse(`${fixture.base}/api/events`, (text) => sseData(text).length >= 3, { "last-event-id": "1:999999" }));
    assert.deepEqual(stale.map((event) => event.n), [1, 2, 3]);

    // Truncated in place (same inode, smaller size): restart at 0.
    writeFileSync(logPath, `${JSON.stringify({ n: 9 })}\n`);
    const afterTruncate = sseData(await readSse(`${fixture.base}/api/events`, (text) => sseData(text).length >= 1, { "last-event-id": lastId }));
    assert.deepEqual(afterTruncate.map((event) => event.n), [9]);
  } finally {
    await fixture.close();
  }
});

test("loop-stream sidecar creates its directory and rotates at the size cap", async () => {
  const base = mkdtempSync(join(tmpdir(), "aidlc-events-rotate-"));
  const logPath = join(base, "nested", "dir", "events.jsonl");
  const previous = process.env.AIDLC_LOOP_EVENT_LOG;
  process.env.AIDLC_LOOP_EVENT_LOG = logPath;
  try {
    // @ts-ignore -- runtime conformance; assets are copied to dist by build-assets
    const { streamLog, EVENT_LOG_MAX_BYTES } = await import("../../assets/.agents/aidlc/scripts/lib/loop-stream.mjs");
    streamLog({ type: "daemon_poll", actionable: [] });
    assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 1);
    writeFileSync(logPath, "x".repeat(EVENT_LOG_MAX_BYTES));
    streamLog({ type: "daemon_poll", actionable: ["t"] });
    assert.equal(readFileSync(`${logPath}.1`, "utf8").length, EVENT_LOG_MAX_BYTES);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0] ?? "{}").actionable, ["t"]);
  } finally {
    if (previous === undefined) delete process.env.AIDLC_LOOP_EVENT_LOG;
    else process.env.AIDLC_LOOP_EVENT_LOG = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test("malformed or non-object JSON bodies are client errors, and a failing loop status is a gateway error", async () => {
  const fixture = await startFixture(makeTask());
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    for (const body of ["{not json", "null", "[1,2]", "\"text\""]) {
      const res = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers, body });
      assert.equal(res.status, 400, body);
    }
    const badPath = await fetch(`${fixture.base}/tasks/%E0%A4%A`);
    assert.equal(badPath.status, 400);
    // No installed loop-entry in this fixture: the async status call fails and is reported, not thrown.
    const status = await fetch(`${fixture.base}/api/loop/status?task-id=task-a`);
    assert.equal(status.status, 502);
  } finally {
    await fixture.close();
  }
});

test("dashboard shows stats, the review queue, filters, and phase steppers", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user", phase: "plan", gate: "G1_review" }));
  try {
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /class="ad-stats"/);
    assert.match(html, /data-stat-filter="blocked_on_user"/);
    assert.match(html, /Needs your review/);
    assert.match(html, /href="\/tasks\/task-a">Open review →<\/a>/);
    assert.match(html, /id="task-search"/);
    assert.match(html, /id="filter-status"/);
    assert.match(html, /aria-label="Phase 2 of 5: plan"/);
    assert.match(html, /data-status="blocked_on_user"/);
    assert.match(html, /id="toasts"/);
  } finally {
    await fixture.close();
  }

  const quiet = await startFixture(makeTask());
  try {
    assert.doesNotMatch(await (await fetch(`${quiet.base}/`)).text(), /Needs your review/);
  } finally {
    await quiet.close();
  }
});

test("dashboard escapes task data in card markup and search attributes", async () => {
  const fixture = await startFixture(makeTask({ title: "<img src=x onerror=alert(1)> \"quoted\"" }));
  try {
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot;/);
    assert.match(html, /data-search="task-a &lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot;/);
  } finally {
    await fixture.close();
  }
});

test("task detail renders a horizontal progress stepper before artifacts, no loop status, and survives a failing gate check", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const page = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.match(page, /<ol class="ad-stepper" aria-label="Progress">/);
    assert.match(page, /<li class="is-current" aria-current="step">/);
    assert.ok(page.indexOf('class="ad-stepper"') < page.indexOf("<h2>Artifacts</h2>"), "progress renders before artifacts");
    assert.doesNotMatch(page, /<h2>Progress<\/h2>/);
    assert.doesNotMatch(page, /Loop status/);
    assert.match(page, /<title>Task A · Loop<\/title>/);
    assert.ok((page.match(/class="container[^"]*"/g) ?? []).every((value) => value.includes("is-fluid")));
    assert.match(page, /waiting at Confirm requirements/);
    assert.match(page, /<h2>Details<\/h2>/);
    assert.match(page, /<details class="ad-artifact" open><summary>intent/, "the gate's artifact opens by default");
  } finally {
    await fixture.close();
  }

  // No intent on disk: the gate's structural check fails; the page still renders with diagnostics.
  const broken = await startFixture(makeTask({ status: "blocked_on_user" }), false);
  try {
    const res = await fetch(`${broken.base}/tasks/task-a`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /gate check failing/);
    assert.match(page, /approve-button/);
  } finally {
    await broken.close();
  }
});
