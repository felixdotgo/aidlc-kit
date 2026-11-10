import assert from "node:assert/strict";
import test from "node:test";
import type { TaskState, WorkflowState } from "../../src/model.js";
import { emptyState } from "../../src/state.js";
import { renderBoard } from "../../src/ui/views/board.js";

const task = (id: string, overrides: Partial<TaskState> = {}): TaskState => {
  const now = new Date().toISOString();
  return {
    id, title: `Title of ${id}`, type: "infra", phase: "clarify", gate: "G0_confirm", status: "active",
    language: "en", risk: "normal", areas: ["root"], branch: "—",
    artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, design: `.agents/data/tasks/${id}/design.md`, workplan: `.agents/data/tasks/${id}/workplan.md` },
    decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now, ...overrides,
  };
};

const board = (...tasks: TaskState[]): string => {
  const state: WorkflowState = emptyState();
  for (const item of tasks) state.tasks[item.id] = item;
  return renderBoard(state);
};

/** The kanban card markup of one task. */
const card = (html: string, id: string): string => {
  const match = new RegExp(`<article class="ad-card[^"]*" data-key="card:${id}"[\\s\\S]*?</article>`).exec(html);
  assert.ok(match, `card ${id} is rendered`);
  return match[0];
};

test("kanban cards lead with the title and drop the id, phase bar, gate, and routine status badges", () => {
  const html = board(
    task("plain-task"),
    task("review-task", { phase: "plan", gate: "G1_review", status: "blocked_on_user" }),
    task("done-task", { phase: "done", gate: "none", status: "done" }),
  );
  for (const id of ["plain-task", "review-task", "done-task"]) {
    const markup = card(html, id);
    assert.match(markup, new RegExp(`<a href="/tasks/${id}" data-task-link="${id}" title="${id}">Title of ${id}</a>`));
    assert.doesNotMatch(markup, /ad-card-id/);
    assert.doesNotMatch(markup, /class="ad-steps/);
    assert.doesNotMatch(markup, /title="status: (active|done|blocked_on_user)"/, "no routine status badge");
    assert.doesNotMatch(markup, /gate: G/, "no gate pill: the column implies it");
    assert.match(markup, new RegExp(`data-card-href="/tasks/${id}"`), "the whole card is a click target");
    assert.match(markup, new RegExp(`data-search="[^"]*${id}`), "search still matches the id");
  }
  assert.match(card(html, "review-task"), /class="ad-card is-attention"/);
  assert.match(card(html, "review-task"), />review</);
  assert.doesNotMatch(card(html, "plain-task"), /ad-card-meta/, "no empty meta row");
});

test("kanban cards keep flags the column cannot express: paused, closed, handoff, risk, feedback", () => {
  const html = board(
    task("paused-task", { status: "paused" }),
    task("risky-task", { risk: "high" }),
    task("handoff-task", { phase: "build", gate: "G2_codereview", handoff: { kind: "repair_exhausted", reason: "r", source: "s", recordedAt: new Date().toISOString() } } as Partial<TaskState>),
  );
  assert.match(card(html, "paused-task"), />Paused</);
  assert.match(card(html, "paused-task"), /data-resume="paused-task"/);
  assert.match(card(html, "risky-task"), />high risk</);
  assert.match(card(html, "handoff-task"), />Handed off</);
  assert.doesNotMatch(card(board(task("normal-risk")), "normal-risk"), /normal risk/);
});

test("list view drops the id column and links the title", () => {
  const html = board(task("list-task"));
  assert.match(html, /<thead><tr><th>title<\/th><th>phase<\/th>/);
  const row = /<tr data-key="row:list-task"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
  assert.match(row, /<a href="\/tasks\/list-task" data-task-link="list-task" title="list-task">Title of list-task<\/a>/);
  assert.doesNotMatch(row, /<code>list-task<\/code>/);
});

/** One kanban column's markup (columns contain no nested `<section>`). */
const column = (html: string, name: string): string => {
  const match = new RegExp(`<section class="ad-column" data-key="column:${name}" data-phase-column="${name}"[\\s\\S]*?<\\/section>`).exec(html);
  assert.ok(match, `column ${name} is rendered`);
  return match[0];
};

test("closed and superseded tasks render in the last kanban column with a closed-at hint", () => {
  const html = board(
    task("closed-plan", { phase: "plan", gate: "G1_review", status: "closed" }),
    task("superseded-build", { phase: "build", gate: "G2_codereview", status: "superseded" }),
    task("active-plan", { phase: "plan", status: "active" }),
  );
  // The last column keeps its canonical key/phase but is headed "done / closed".
  const doneColumn = column(html, "done");
  assert.match(doneColumn, />done \/ closed</);
  assert.match(doneColumn, /data-key="card:closed-plan"/);
  assert.match(doneColumn, /data-key="card:superseded-build"/);
  assert.match(doneColumn, /data-column-count>2</, "column count includes closed tasks");
  // ...while the plan column only holds the still-active task.
  const planColumn = column(html, "plan");
  assert.match(planColumn, /data-key="card:active-plan"/);
  assert.doesNotMatch(planColumn, /data-key="card:closed-plan"/);
  // Card and list row both show the visible closed-at hint with the canonical phase.
  assert.match(card(html, "closed-plan"), /closed at plan/);
  assert.match(card(html, "superseded-build"), /superseded at build/);
  const row = /<tr data-key="row:closed-plan"[\s\S]*?<\/tr>/.exec(html)?.[0] ?? "";
  assert.match(row, /closed at plan/);
  assert.doesNotMatch(row, /class="ad-steps/, "closed rows drop the step bars for the hint");
});

test("the dashboard page has no help footer under the board", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { renderDashboard } = await import("../../src/ui/views/board.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-board-"));
  mkdirSync(join(root, ".agents", "data", "state"), { recursive: true });
  writeFileSync(join(root, ".agents", "data", "state", "aidlc-state.json"), `${JSON.stringify(emptyState())}\n`);
  const html = await renderDashboard({ root, host: "127.0.0.1", port: 0 });
  assert.ok(!html.includes('class="ad-help"'), "no ad-help paragraph");
  assert.ok(!html.includes("Click a card to open it in the side panel"), "no usage note");
});
