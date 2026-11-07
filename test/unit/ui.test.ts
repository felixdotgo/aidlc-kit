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

test("dashboard keeps archived done tasks after a reload, alongside active tasks", async () => {
  const { loadState, saveState } = await import("../../src/state.js");
  const fixture = await startFixture(makeTask());
  try {
    const state = loadState(fixture.root);
    state.tasks["task-done"] = makeTask({ id: "task-done", title: "Finished task", phase: "done", gate: "none", status: "done", artifacts: {} });
    saveState(fixture.root, state);
    const persisted = loadState(fixture.root);
    assert.equal(persisted.tasks["task-done"], undefined, "terminal task is moved out of the active catalog");
    assert.equal(persisted.archive?.["task-done"]?.status, "done", "terminal task is archived");

    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /data-task-id="task-a"|\/tasks\/task-a/);
    assert.match(html, /Finished task/);
    assert.match(html, /data-status="done"/);
    assert.match(html, /data-phase-column="done"[^>]*>\s*<header[^>]*>.*?data-column-count>1</s);
  } finally {
    await fixture.close();
  }
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

    const feedback = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: "task-a", feedback: "scope is wrong" }) });
    assert.equal(feedback.status, 401);
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

test("feedback proxy validates inputs and rejects a task that is not waiting at a gate", async () => {
  const fixture = await startFixture(makeTask(), true);
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    const missingFeedback = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ taskId: "task-a", feedback: "   " }) });
    assert.equal(missingFeedback.status, 400);
    assert.match(((await missingFeedback.json()) as { error: string }).error, /feedback is required/);

    const missingTask = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ feedback: "scope is wrong" }) });
    assert.equal(missingTask.status, 400);

    const unknownTask = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ taskId: "missing", feedback: "scope is wrong" }) });
    assert.equal(unknownTask.status, 404);

    const activeTask = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ taskId: "task-a", feedback: "scope is wrong" }) });
    assert.equal(activeTask.status, 409);

    // An active task shows neither the feedback nor the approve controls.
    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.doesNotMatch(detail, /id="feedback-button"/);
    assert.doesNotMatch(detail, /id="approve-button"/);
  } finally {
    await fixture.close();
  }
});

test("gate detail page offers feedback before approve, and approve only opens a confirmation dialog", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    const feedbackAt = detail.indexOf('id="feedback-panel"');
    const approveAt = detail.indexOf('id="approve-panel"');
    assert.ok(feedbackAt > 0 && approveAt > feedbackAt, "feedback block renders before the approve block");
    assert.match(detail, /id="feedback-button"[^>]*>✎ Send feedback \(stay at gate\)</);
    assert.match(detail, /id="approve-button"[^>]*>✓ Approve</);
    assert.match(detail, /id="approve-modal" class="modal"/);
    assert.match(detail, /id="approve-confirm"[^>]*>✓ Confirm approve</);
    assert.match(detail, /openModal\("approve-modal"\)/, "the approve button opens the dialog");
    // Only the dialog's confirm handler posts the approval.
    const confirmHandler = detail.slice(detail.indexOf("const onApproveConfirm"), detail.indexOf('document.addEventListener("click"', detail.indexOf("const onApproveConfirm")));
    assert.match(confirmHandler, /post\("\/api\/gate\/approve", \{ taskId: detailTask\(\), gate, source/);
    const approveHandler = detail.slice(detail.indexOf("const onApproveOpen"), detail.indexOf("const onApproveConfirm"));
    assert.doesNotMatch(approveHandler, /post\("\/api\/gate\/approve"/);
    assert.doesNotMatch(detail, /feedback pending/);

    // The side-panel fragment stays read-only: no feedback/approve controls, no dialog.
    const fragment = await (await fetch(`${fixture.base}/partial/tasks/task-a`)).text();
    assert.doesNotMatch(fragment, /id="feedback-button"|id="approve-button"|id="approve-modal"/);
  } finally {
    await fixture.close();
  }
});

test("pending feedback shows on the dashboard and the detail page until that gate is approved", async () => {
  const feedback = (gate: string, text: string) => ({ kind: "diagnostic" as const, result: "pass" as const, source: "Dashboard feedback", detail: `Cancelled gate wait at ${gate}: ${text}`, recordedAt: new Date().toISOString() });
  const approval = (gate: "G0_confirm" | "G1_review") => ({ kind: "approval" as const, gate, result: "pass" as const, source: "ok", recordedAt: new Date().toISOString() });
  const fixture = await startFixture(makeTask({ status: "active", evidence: [feedback("G0_confirm", "handled earlier"), approval("G0_confirm"), feedback("G0_confirm", "the scope misses the fleet path")] }), true);
  try {
    const home = await (await fetch(`${fixture.base}/`)).text();
    assert.match(home, /data-feedback-pending="1"/);
    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    const panelStart = detail.indexOf('id="feedback-pending-panel"');
    assert.ok(panelStart > 0, "pending panel renders");
    const panel = detail.slice(panelStart, detail.indexOf("</section>", panelStart));
    assert.match(panel, /the scope misses the fleet path/);
    assert.doesNotMatch(panel, /handled earlier/, "feedback followed by that gate's approval is no longer pending");
    assert.match(panel, /The loop lead is revising the review artifact/);
    assert.match(panel, /ad-panel-tools">1</, "only the unapproved feedback counts");
  } finally {
    await fixture.close();
  }

  // Waiting again after feedback: the approve panel warns but still renders.
  const waiting = await startFixture(makeTask({ status: "blocked_on_user", evidence: [feedback("G0_confirm", "tighten the scope")] }), true);
  try {
    const detail = await (await fetch(`${waiting.base}/tasks/task-a`)).text();
    assert.match(detail, /id="approve-pending-warning"/);
    assert.match(detail, /id="approve-button"/);
    assert.match(detail, /Check that the review artifact reflects it before approving/);
  } finally {
    await waiting.close();
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
    assert.match(html, /<div id="list-view">/, "the list view is hidden by CSS (html[data-view]), not inline style that live updates would reset");
    assert.match(html, /document\.documentElement\.setAttribute\("data-view"/, "the saved view applies before first paint");
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
    assert.match(home, /href="\/tasks\/task-a"[^>]*>review<\/a>/);
    assert.doesNotMatch(home, /data-resume="task-a"/);
  } finally {
    await gated.close();
  }
});

test("dashboard feedback keeps the task at its gate and records the loop's feedback evidence", { skip: process.platform === "win32" }, async () => {
  const fixture = await startInstalledFixture();
  const headers = { "content-type": "application/json", "x-aidlc-token": fixture.token };
  try {
    fixture.state("task", "create", "gated", "--title", "Gated");
    writeTaskDir(fixture.root, "gated");
    fixture.state("task", "status", "gated", "--status", "blocked_on_user");
    const before = fixture.state("task", "show", "gated").result;
    assert.deepEqual({ phase: before.phase, gate: before.gate, status: before.status }, { phase: "clarify", gate: "G0_confirm", status: "blocked_on_user" });

    const detail = await (await fetch(`${fixture.base}/tasks/gated`)).text();
    assert.match(detail, /id="feedback-button"/);
    assert.match(detail, /id="approve-button"/);

    const sent = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ taskId: "gated", feedback: "The scope misses the fleet path; add it." }) });
    const sentText = await sent.text();
    assert.equal(sent.status, 200, sentText);
    const payload = JSON.parse(sentText) as { ok: boolean; result: { nextAction?: { classification: string; phase: string } } };
    assert.equal(payload.ok, true);
    assert.equal(payload.result.nextAction?.classification, "run_phase", "the loop continues the same phase (no gate advance)");
    assert.equal(payload.result.nextAction?.phase, "clarify");

    const after = fixture.state("task", "show", "gated").result;
    assert.deepEqual({ phase: after.phase, gate: after.gate, status: after.status }, { phase: "clarify", gate: "G0_confirm", status: "active" }, "feedback never approves or advances the gate");
    assert.equal(after.evidence.some((entry: { kind: string }) => entry.kind === "approval"), false);
    const last = after.evidence[after.evidence.length - 1];
    assert.deepEqual({ kind: last.kind, result: last.result, source: last.source, detail: last.detail }, { kind: "diagnostic", result: "pass", source: "Dashboard feedback", detail: "Cancelled gate wait at G0_confirm: The scope misses the fleet path; add it." });

    const home = await (await fetch(`${fixture.base}/`)).text();
    assert.match(home, /data-feedback-pending="1"/);
    const revised = await (await fetch(`${fixture.base}/tasks/gated`)).text();
    assert.match(revised, /id="feedback-pending-panel"/);
    assert.match(revised, /The scope misses the fleet path; add it\./);
    assert.doesNotMatch(revised, /id="approve-button"/, "no approve control while the lead revises");

    // A second feedback while active is rejected: the task is no longer waiting.
    const again = await fetch(`${fixture.base}/api/gate/feedback`, { method: "POST", headers, body: JSON.stringify({ taskId: "gated", feedback: "more" }) });
    assert.equal(again.status, 409);

    // The installed loop-entry `feedback` action is fleet-only; local dashboards go through state.mjs directly.
    const { execFileSync } = await import("node:child_process");
    assert.throws(
      () => execFileSync(process.execPath, [join(fixture.root, ".agents/aidlc/scripts/loop-entry.mjs"), "feedback", "gated", fixture.root], { input: JSON.stringify({ reason: "x", source: "y" }), stdio: ["pipe", "pipe", "pipe"] }),
      /loop feedback is a fleet dashboard action/);
  } finally {
    await fixture.close();
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

test("dashboard drops the stat cards and lists gate reviews as header notifications", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user", phase: "plan", gate: "G1_review" }));
  try {
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.doesNotMatch(html, /class="ad-stats"|data-stat-filter/, "status stat cards are gone");
    assert.doesNotMatch(html, /class="ad-attention"/, "the inline review queue is gone");
    const header = html.slice(html.indexOf('<header class="ad-header">'), html.indexOf("<main"));
    assert.match(header, /id="notify-toggle"[^>]*aria-expanded="false"[^>]*aria-label="1 task waiting for your review"/);
    assert.match(header, /data-review-count="1">1</);
    assert.match(header, /<a class="ad-notify-item" href="\/tasks\/task-a" data-review-item="task-a">/, "a notification opens the task detail page");
    assert.match(header, /Approve plan/);
    assert.match(html, /id="task-search"/);
    assert.match(html, /id="filter-status"/);
    assert.match(html, /aria-label="Phase 2 of 5: plan"/);
    assert.match(html, /data-status="blocked_on_user"/);
    assert.match(html, /id="toasts"/);

    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.match(detail, /data-review-item="task-a" aria-current="page"/, "the detail page header marks the open review");
    assert.doesNotMatch(await (await fetch(`${fixture.base}/partial/tasks/task-a`)).text(), /id="notify-panel"/, "the side-panel fragment has no header");
  } finally {
    await fixture.close();
  }

  const quiet = await startFixture(makeTask());
  try {
    const html = await (await fetch(`${quiet.base}/`)).text();
    assert.match(html, /aria-label="Nothing waiting for your review"/);
    assert.doesNotMatch(html, /data-review-count|data-review-item/);
    assert.match(html, /class="ad-notify-empty"/);
  } finally {
    await quiet.close();
  }
});

/* ---- Reactive live regions ---- */

const liveHashes = (html: string, names: string[]): string =>
  names.map((name) => `${name}:${new RegExp(`data-live="${name}" data-live-hash="([^"]*)"`).exec(html)?.[1] ?? "missing"}`).join(",");

test("live endpoint returns only changed regions and reflects daemon-side state changes without a reload", async () => {
  const { loadState, saveState } = await import("../../src/state.js");
  const fixture = await startFixture(makeTask({ status: "active", phase: "plan", gate: "G1_review" }), true);
  try {
    const home = await (await fetch(`${fixture.base}/`)).text();
    assert.doesNotMatch(home, /location\.reload/, "actions refresh regions in place, never the whole page");
    const known = liveHashes(home, ["notify", "daemon", "board"]);
    assert.doesNotMatch(known, /missing/, "every dashboard region carries a hash");
    const live = async (query: string): Promise<any> => (await fetch(`${fixture.base}/api/live?${query}`)).json();

    const quiet = await live(`known=${encodeURIComponent(known)}`);
    assert.deepEqual(quiet.regions, {}, "nothing changed, nothing sent");
    assert.equal(quiet.reviews.count, 0);
    assert.deepEqual((await live("known=bogus:x")).regions, {}, "unknown regions are ignored");

    // The daemon moves the task to its gate: the bell and the board change, the daemon pill does not.
    const state = loadState(fixture.root);
    state.tasks["task-a"]!.status = "blocked_on_user";
    saveState(fixture.root, state);
    const changed = await live(`known=${encodeURIComponent(known)}`);
    assert.deepEqual(Object.keys(changed.regions).sort(), ["board", "notify"]);
    assert.match(changed.regions.notify.html, /data-review-item="task-a"/);
    assert.match(changed.regions.board.html, /data-status="blocked_on_user"/);
    assert.deepEqual(changed.reviews, { count: 1, items: [{ id: "task-a", title: "Task A", gate: "Approve plan" }] });

    // Detail page: the region re-renders with the gate controls; the live log is client-owned.
    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.match(detail, /<body data-task="task-a">/);
    assert.match(detail, /id="live-log" data-live-ignore/);
    assert.match(detail, /id="approve-modal"[^>]*data-live-preserve="class"/, "an open dialog survives a live update");
    const detailKnown = liveHashes(detail, ["notify", "detail"]);
    assert.deepEqual((await live(`task=task-a&known=${encodeURIComponent(detailKnown)}`)).regions, {});
    const later = loadState(fixture.root);
    later.tasks["task-a"]!.status = "active";
    saveState(fixture.root, later);
    const moved = await live(`task=task-a&known=${encodeURIComponent(detailKnown)}`);
    assert.doesNotMatch(moved.regions.detail.html, /id="feedback-panel"|id="approve-panel"/, "gate controls disappear once the task leaves the gate");
    assert.match(moved.regions.notify.html, /class="ad-notify-empty"/);

    // Side panel: rendered only when the client says it is open, echoing which task it is for.
    const drawer = await live("drawer=task-a&known=drawer:");
    assert.equal(drawer.drawer, "task-a");
    assert.match(drawer.regions.drawer.html, /<h1 class="ad-page-title">Task A<\/h1>/);
    assert.doesNotMatch(drawer.regions.drawer.html, /id="live-log"|id="approve-modal"/);
  } finally {
    await fixture.close();
  }
});

test("notifications show a fixed page of reviews with load more", async () => {
  const { loadState, saveState } = await import("../../src/state.js");
  const fixture = await startFixture(makeTask({ status: "blocked_on_user", updatedAt: "2026-11-01T00:00:00.000Z" }));
  try {
    const state = loadState(fixture.root);
    for (let index = 1; index <= 6; index += 1) {
      const id = `task-r${index}`;
      state.tasks[id] = makeTask({ id, title: `Review ${index}`, status: "blocked_on_user", artifacts: {}, updatedAt: `2026-11-0${index + 1}T00:00:00.000Z` });
    }
    saveState(fixture.root, state);
    const html = await (await fetch(`${fixture.base}/`)).text();
    const header = html.slice(0, html.indexOf("<main"));
    assert.equal((header.match(/data-review-item=/g) ?? []).length, 5, "first page only");
    assert.match(header, /data-review-item="task-r6"/, "newest first");
    assert.doesNotMatch(header, /data-review-item="task-a"/);
    assert.match(header, /data-notify-more>Load more <span class="has-text-grey">\(2 more\)<\/span>/);
    assert.match(header, /data-review-count="7">7</);

    const more = await (await fetch(`${fixture.base}/api/live?notify=10&known=notify:`)).json();
    assert.equal((more.regions.notify.html.match(/data-review-item=/g) ?? []).length, 7);
    assert.doesNotMatch(more.regions.notify.html, /data-notify-more/);
    const clamped = await (await fetch(`${fixture.base}/api/live?notify=-3&known=notify:`)).json();
    assert.equal((clamped.regions.notify.html.match(/data-review-item=/g) ?? []).length, 5, "invalid limits fall back to one page");
  } finally {
    await fixture.close();
  }
});

test("daemon health keeps turn and poll errors open until resolved", async () => {
  const { daemonHealth } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-health-"));
  try {
    assert.deepEqual(daemonHealth(root), [], "no event log, no errors");
    const dir = join(root, ".agents", "data", "loop");
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "ui-events.jsonl");
    const write = (...events: object[]): void => appendFileSync(log, events.map((event) => `${JSON.stringify({ at: "2026-11-07T00:00:00.000Z", ...event })}\n`).join(""));
    write(
      { type: "daemon_turn_error", taskId: "task-old", message: "before restart" },
      { type: "daemon_start", pid: 1 },
      { type: "daemon_turn_error", taskId: "task-a", message: "agent crashed", failures: 2, retryInMs: 30000 },
      { type: "daemon_turn_error", taskId: "task-b", message: "transient" },
      { type: "daemon_turn", taskId: "task-b", status: "progress" },
      { type: "daemon_turn_error", taskId: "task-c", message: "no longer actionable" },
      { type: "daemon_poll", actionable: ["task-a"] },
      { type: "daemon_poll_error", message: "service unreachable" },
    );
    const errors = daemonHealth(root);
    assert.deepEqual(errors.map((error) => error.taskId ?? "poll"), ["poll", "task-a"]);
    assert.equal(errors[1]?.retryInMs, 30000);
    write({ type: "daemon_poll", actionable: ["task-a"] });
    assert.deepEqual(daemonHealth(root).map((error) => error.taskId), ["task-a"], "a successful poll clears the poll error");
    write({ type: "daemon_start", pid: 2 });
    assert.deepEqual(daemonHealth(root), [], "a restarted daemon starts clean");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("header daemon pill shows unresolved errors while the daemon runs", async () => {
  const fixture = await startFixture(makeTask());
  try {
    const dir = join(fixture.root, ".agents", "data", "loop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "daemon.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.match(await (await fetch(`${fixture.base}/`)).text(), /data-daemon="running"/);
    appendFileSync(join(dir, "ui-events.jsonl"), `${JSON.stringify({ type: "daemon_turn_error", taskId: "task-a", message: "agent <crashed>", retryInMs: 4000 })}\n`);
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /<a class="ad-pill is-warning is-live" data-daemon="error" href="\/tasks\/task-a" title="daemon running · pid \d+\ntask-a: agent &lt;crashed&gt; \(retry in 4s\)">/);
    assert.match(html, /daemon · 1 error</);
  } finally {
    await fixture.close();
  }
});

test("side panel points at the full page when a gate or handoff needs the human", async () => {
  const waiting = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const fragment = await (await fetch(`${waiting.base}/partial/tasks/task-a`)).text();
    assert.match(fragment, /^<div class="ad-callout ad-drawer-cta"/, "the call to action leads the panel");
    assert.match(fragment, /Waiting at <strong>Confirm requirements<\/strong>/);
    assert.match(fragment, /<a class="button is-small is-warning" href="\/tasks\/task-a" data-review-cta>Open review →<\/a>/);
  } finally {
    await waiting.close();
  }
  const active = await startFixture(makeTask(), true);
  try {
    assert.doesNotMatch(await (await fetch(`${active.base}/partial/tasks/task-a`)).text(), /ad-drawer-cta/);
  } finally {
    await active.close();
  }
});

test("approve refuses a gate the task has already moved past", async () => {
  const fixture = await startFixture(makeTask({ status: "blocked_on_user" }), true);
  try {
    const response = await fetch(`${fixture.base}/api/gate/approve`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": fixture.token }, body: JSON.stringify({ taskId: "task-a", gate: "G1_review", source: "looked at the plan" }) });
    assert.equal(response.status, 409);
    assert.match(((await response.json()) as { error: string }).error, /now waits at Confirm requirements \(G0_confirm\), not G1_review/);
  } finally {
    await fixture.close();
  }
});

test("the done column collapses past its limit with a show-more control", async () => {
  const { loadState, saveState } = await import("../../src/state.js");
  const fixture = await startFixture(makeTask());
  try {
    const state = loadState(fixture.root);
    for (let index = 1; index <= 10; index += 1) {
      const id = `task-d${index}`;
      state.tasks[id] = makeTask({ id, title: `Done ${index}`, phase: "done", gate: "none", status: "done", artifacts: {} });
    }
    saveState(fixture.root, state);
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /data-phase-column="done" data-collapse="8"/);
    assert.match(html, /<button type="button" class="ad-column-more" data-column-more>Show 2 more<\/button>/);
    assert.match(html, /data-key="card:task-d1"/, "cards are keyed so live updates morph them in place");
    assert.equal((html.match(/<button[^>]*data-column-more/g) ?? []).length, 1, "only the done column collapses");
  } finally {
    await fixture.close();
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
    assert.match(page, /<details class="ad-artifact" data-key="artifact:intent" open><summary>intent/, "the gate's artifact opens by default");
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

/* ---- Authority-neutral dashboard and token hardening ---- */

const rawRequest = async (base: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> => {
  const { request } = await import("node:http");
  const url = new URL(path, base);
  return new Promise((resolveRequest, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method: options.method ?? "GET", headers: options.headers ?? {} }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; }); res.on("end", () => resolveRequest({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject); req.end(options.body ?? "");
  });
};

test("dashboard rejects foreign Host headers, cross-origin posts, and body-only tokens", async () => {
  const fixture = await startFixture(makeTask({ status: "paused" }));
  try {
    const port = new URL(fixture.base).port;
    assert.equal((await rawRequest(fixture.base, "/", { headers: { Host: "evil.example" } })).status, 403, "DNS-rebinding host");
    assert.equal((await rawRequest(fixture.base, "/", { headers: { Host: `localhost:${port}` } })).status, 200, "any loopback name works when bound to loopback");
    const json = { "content-type": "application/json", Host: `127.0.0.1:${port}` };
    const crossSite = await rawRequest(fixture.base, "/api/loop/resume", { method: "POST", headers: { ...json, Origin: "https://evil.example", "x-aidlc-token": fixture.token }, body: JSON.stringify({ taskId: "task-a" }) });
    assert.equal(crossSite.status, 403);
    const bodyToken = await rawRequest(fixture.base, "/api/loop/resume", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", Host: `127.0.0.1:${port}` }, body: `taskId=task-a&token=${fixture.token}` });
    assert.equal(bodyToken.status, 401, "a token in a form body (CSRF-able) is not accepted");
    const html = await (await fetch(`${fixture.base}/`)).text();
    assert.match(html, /token=\(\[\^&\]\+\)/, "the page adopts the #token= login link");
    assert.match(html, /history\.replaceState\(history\.state, "", location\.pathname \+ location\.search\)/);
  } finally { await fixture.close(); }
});

test("token files must live outside the project, be private regular files, and can be created", async () => {
  const { readUiTokenFile } = await import("../../src/task-ui.js");
  const { chmodSync, symlinkSync, statSync } = await import("node:fs");
  const project = mkdtempSync(join(tmpdir(), "aidlc-ui-project-"));
  const outside = mkdtempSync(join(tmpdir(), "aidlc-ui-secrets-"));
  try {
    assert.throws(() => readUiTokenFile(project, join(project, "ui.token"), { create: true }), /outside the project/);
    const created = join(outside, "ui.token");
    const token = readUiTokenFile(project, created, { create: true });
    assert.ok(token.length >= 32);
    if (process.platform !== "win32") assert.equal(statSync(created).mode & 0o777, 0o600);
    assert.equal(readUiTokenFile(project, created, { create: false }), token, "the same token survives a restart");
    assert.throws(() => readUiTokenFile(project, join(outside, "missing.token"), { create: false }), /not found/);
    if (process.platform !== "win32") {
      chmodSync(created, 0o644);
      assert.throws(() => readUiTokenFile(project, created, { create: false }), /private/);
      chmodSync(created, 0o600);
      symlinkSync(created, join(outside, "link.token"));
      assert.throws(() => readUiTokenFile(project, join(outside, "link.token"), { create: false }), /symlink/);
    }
    writeFileSync(join(outside, "short.token"), "abc\n", { mode: 0o600 });
    assert.throws(() => readUiTokenFile(project, join(outside, "short.token"), { create: false }), /16–256/);
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("child processes and the daemon never inherit UI or reviewer credentials", async () => {
  const { scrubbedEnv } = await import("../../src/task-ui.js");
  const previous = { ...process.env };
  process.env.AIDLC_FLEET_REVIEWER_TOKEN = "r".repeat(32); process.env.AIDLC_UI_TOKEN = "u".repeat(32);
  try {
    const env = scrubbedEnv({ AIDLC_LOOP_EVENT_LOG: "/tmp/x" });
    assert.equal(env.AIDLC_FLEET_REVIEWER_TOKEN, undefined);
    assert.equal(env.AIDLC_UI_TOKEN, undefined);
    assert.equal(env.AIDLC_LOOP_EVENT_LOG, "/tmp/x");
    assert.equal(scrubbedEnv({ AIDLC_FLEET_REVIEWER_TOKEN: "explicit" }).AIDLC_FLEET_REVIEWER_TOKEN, "explicit", "only an explicit per-call grant (approve) passes it");
  } finally { process.env = previous; }
});

test("fleet dashboard reads tasks, gate snapshots, resume and approve through loop-entry with a scoped reviewer credential", { skip: process.platform === "win32" }, async () => {
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-fleet-"));
  const calls = join(root, "calls.jsonl");
  const fleetTask = { ...makeTask({ status: "blocked_on_user" }), id: "fleet-a", title: "Fleet task A" };
  const pausedTask = { ...makeTask({ status: "paused" }), id: "fleet-b", title: "Fleet task B" };
  mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
  writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ loop: { mode: "fleet", agents: { lead: "codex", workers: { w: "codex" } } } }));
  // A fake installed loop-entry.mjs that records each dashboard action, its stdin, and whether it got the reviewer credential.
  writeFileSync(join(root, ".agents/aidlc/scripts/loop-entry.mjs"), `import { appendFileSync, readFileSync } from "node:fs";
let input = ""; try { input = readFileSync(0, "utf8"); } catch { /* no stdin */ }
const [action, taskId] = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ action, taskId, input, reviewer: process.env.AIDLC_FLEET_REVIEWER_TOKEN ?? null }) + "\\n");
const tasks = ${JSON.stringify([fleetTask, pausedTask])};
if (action === "tasks") console.log(JSON.stringify({ ok: true, authority: "fleet", tasks }));
else if (action === "gate") console.log(JSON.stringify({ ok: true, gate: "G0_confirm", status: "blocked_on_user", snapshot: { id: "snap-1", reviewText: "## Remote review\\nSnapshot body" } }));
else if (action === "approve" || action === "resume-task" || action === "feedback") console.log(JSON.stringify({ ok: true, result: { action } }));
else { console.error("unexpected " + action); process.exit(1); }
`);
  const read = () => readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const run = async (reviewerToken?: string) => {
    const { server, port, token } = await startUiServer({ root, host: "127.0.0.1", port: 0, ...(reviewerToken ? { reviewerToken } : {}) });
    return { base: `http://127.0.0.1:${port}`, token, close: () => new Promise<void>((done) => server.close(() => done())) };
  };
  const plain = await run();
  try {
    const home = await (await fetch(`${plain.base}/`)).text();
    assert.match(home, /data-authority="fleet"/);
    assert.match(home, /Fleet task A/);
    assert.match(home, /Fleet task B/);
    const detail = await (await fetch(`${plain.base}/tasks/fleet-a`)).text();
    assert.match(detail, /review snapshot/);
    assert.match(detail, /Snapshot body/);
    assert.match(detail, /remote-state\.mjs gate approve fleet-a/, "without a reviewer credential the page shows the reviewer command");
    const denied = await fetch(`${plain.base}/api/gate/approve`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": plain.token }, body: JSON.stringify({ taskId: "fleet-a", source: "ok" }) });
    assert.equal(denied.status, 403);
    // Feedback never needs the reviewer credential: it goes through loop-entry's `feedback` action as JSON on stdin.
    assert.match(detail, /id="feedback-button"/, "feedback is offered even without a reviewer credential");
    assert.doesNotMatch(detail, /id="approve-modal"/, "no approve dialog without a reviewer credential");
    const fed = await fetch(`${plain.base}/api/gate/feedback`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": plain.token }, body: JSON.stringify({ taskId: "fleet-a", feedback: "split the plan", source: "reviewer note" }) });
    assert.equal(fed.status, 200, await fed.text());
    const feedbackCall = read().find((call) => call.action === "feedback");
    assert.deepEqual({ taskId: feedbackCall.taskId, input: JSON.parse(feedbackCall.input), reviewer: feedbackCall.reviewer }, { taskId: "fleet-a", input: { reason: "split the plan", source: "reviewer note" }, reviewer: null });
    const resumed = await fetch(`${plain.base}/api/loop/resume`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": plain.token }, body: JSON.stringify({ taskId: "fleet-b" }) });
    assert.equal(resumed.status, 200);
    assert.ok(read().some((call) => call.action === "resume-task" && call.taskId === "fleet-b"));
  } finally { await plain.close(); }
  const reviewer = await run("r".repeat(32));
  try {
    const detail = await (await fetch(`${reviewer.base}/tasks/fleet-a`)).text();
    assert.match(detail, /approve-button/);
    const approved = await fetch(`${reviewer.base}/api/gate/approve`, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": reviewer.token }, body: JSON.stringify({ taskId: "fleet-a", source: "looks good" }) });
    assert.equal(approved.status, 200);
    const all = read();
    const approve = all.find((call) => call.action === "approve");
    assert.deepEqual({ taskId: approve.taskId, input: approve.input, reviewer: approve.reviewer }, { taskId: "fleet-a", input: "looks good", reviewer: "r".repeat(32) });
    assert.ok(all.filter((call) => call.action !== "approve").every((call) => call.reviewer === null), "read and resume children never receive the reviewer credential");
  } finally { await reviewer.close(); rmSync(root, { recursive: true, force: true }); }
});
