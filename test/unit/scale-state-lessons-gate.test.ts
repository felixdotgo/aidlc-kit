import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatGateView } from "../../src/gate.js";
import type { LessonRecord, TaskState, WorkflowState } from "../../src/model.js";
import { lessonStateDigest, listTaskSummaries, loadTask, rebuildLessonIndex, renderViews, renderWorkplan, saveState, searchLessons } from "../../src/state.js";

const terminalTask = (index: number, lesson?: LessonRecord): TaskState => {
  const id = `2026-${String(index).padStart(4, "0")}-terminal`;
  const recordedAt = `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
  return {
    id, title: `Terminal task ${index}`, type: "infra", phase: "done", gate: "none", status: "done", language: "en", risk: "normal", areas: ["runtime"], branch: "—",
    artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, workplan: `.agents/data/tasks/${id}/workplan.md` }, decisions: [], tasks: [], evidence: [],
    lessons: lesson ? [{ ...lesson, taskId: id, recordedAt }] : undefined,
    lessonDisposition: lesson ? { status: "captured", source: lesson.source, recordedAt } : { status: "none", reason: "No durable lesson", source: "fixture", recordedAt },
    createdAt: recordedAt, updatedAt: recordedAt
  };
};

test("schema v3 compacts 100 terminal tasks and keeps bounded catalog reads", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-scale-state-"));
  try {
    const tasks = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
      const task = terminalTask(index);
      return [task.id, task];
    }));
    const state: WorkflowState = { schemaVersion: 3, tasks, archive: {} };
    const archived = saveState(root, state);
    assert.equal(archived.length, 100);
    assert.equal(Object.keys(state.tasks).length, 0);
    assert.equal(Object.keys(state.archive ?? {}).length, 100);
    assert.ok(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8").length < 80_000);

    const first = listTaskSummaries(state, { includeArchive: true });
    assert.equal(first.items.length, 20); assert.equal(first.total, 100); assert.equal(first.nextCursor, "20");
    const second = listTaskSummaries(state, { includeArchive: true, cursor: Number(first.nextCursor) });
    assert.equal(second.items.length, 20); assert.notEqual(second.items[0]!.id, first.items[0]!.id);
    const id = first.items[0]!.id;
    assert.equal(loadTask(root, id, state)?.id, id);
    assert.ok(existsSync(join(root, `.agents/data/state/archive/${id}.json`)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lesson search uses the bounded derived index and detects catalog drift", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-lessons-"));
  try {
    const lesson: LessonRecord = {
      id: "avoid-full-state", taskId: "placeholder", areas: ["runtime"], summary: "Avoid loading every archived task", prevention: "Search the compact lesson index", example: "lesson search --area runtime", promotion: "orchestrator", source: "fixture", recordedAt: "2026-01-01T00:00:00.000Z"
    };
    const task = terminalTask(1, lesson);
    const state: WorkflowState = { schemaVersion: 3, tasks: { [task.id]: task }, archive: {} };
    saveState(root, state);
    const index = rebuildLessonIndex(root, state);
    assert.equal(index.sourceDigest, lessonStateDigest(state));

    const archiveDir = join(root, ".agents/data/state/archive");
    const hidden = join(root, ".agents/data/state/archive-hidden");
    renameSync(archiveDir, hidden);
    assert.equal(searchLessons(root, state, "archived task", ["runtime"])[0]?.id, "avoid-full-state");
    renameSync(hidden, archiveDir);

    state.archive![task.id]!.digest = "0".repeat(64);
    assert.throws(() => searchLessons(root, state, "archived", ["runtime"]), /stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("state compaction refuses an archive symlink before writing", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-state-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "aidlc-state-outside-"));
  try {
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    symlinkSync(outside, join(root, ".agents/data/state/archive"));
    const task = terminalTask(1);
    const state: WorkflowState = { schemaVersion: 3, tasks: { [task.id]: task }, archive: {} };
    assert.throws(() => saveState(root, state), /crosses a symlink/);
    assert.equal(existsSync(join(outside, `${task.id}.json`)), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("state compaction recovers only a valid unreferenced archive orphan", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-state-orphan-"));
  try {
    const active = terminalTask(7);
    active.phase = "build"; active.gate = "G2_codereview"; active.status = "active"; delete active.lessonDisposition;
    const canonical: WorkflowState = { schemaVersion: 3, tasks: { [active.id]: active }, archive: {} };
    saveState(root, canonical);

    const orphan = terminalTask(7);
    const archivePath = join(root, `.agents/data/state/archive/${active.id}.json`);
    mkdirSync(join(root, ".agents/data/state/archive"), { recursive: true });
    writeFileSync(archivePath, `${JSON.stringify(orphan, null, 2)}\n`);

    const completed = structuredClone(active);
    completed.phase = "done"; completed.gate = "none"; completed.status = "done";
    completed.lessonDisposition = { status: "none", reason: "No durable lesson", source: "fixture", recordedAt: "2026-02-01T00:00:00.000Z" };
    completed.updatedAt = "2026-02-01T00:00:00.000Z";
    const retry: WorkflowState = { schemaVersion: 3, tasks: { [completed.id]: completed }, archive: {} };
    assert.deepEqual(saveState(root, retry), [completed.id]);
    assert.equal(loadTask(root, completed.id, retry)?.updatedAt, completed.updatedAt);

    const conflictingRoot = mkdtempSync(join(tmpdir(), "aidlc-state-orphan-conflict-"));
    try {
      const conflictingCanonical: WorkflowState = { schemaVersion: 3, tasks: { [active.id]: active }, archive: {} };
      saveState(conflictingRoot, conflictingCanonical);
      const conflictingPath = join(conflictingRoot, `.agents/data/state/archive/${active.id}.json`);
      mkdirSync(join(conflictingRoot, ".agents/data/state/archive"), { recursive: true });
      writeFileSync(conflictingPath, "not-json\n");
      const conflictingRetry: WorkflowState = { schemaVersion: 3, tasks: { [completed.id]: completed }, archive: {} };
      assert.throws(() => saveState(conflictingRoot, conflictingRetry), /Archived task record conflicts/);
      assert.equal(conflictingRetry.tasks[completed.id]!.status, "done");
    } finally { rmSync(conflictingRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rendered workplans reject symlinked artifact parents", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-render-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "aidlc-render-outside-"));
  try {
    mkdirSync(join(root, ".agents/data/tasks"), { recursive: true });
    const current = terminalTask(9);
    current.phase = "build"; current.gate = "G2_codereview"; current.status = "active"; delete current.lessonDisposition;
    symlinkSync(outside, join(root, `.agents/data/tasks/${current.id}`));
    const state: WorkflowState = { schemaVersion: 3, tasks: { [current.id]: current }, archive: {} };
    assert.throws(() => renderViews(root, state, [current]), /crosses a symlink/);
    assert.equal(existsSync(join(outside, "workplan.md")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("gate renderer is portable, deterministic, and emits one action line", () => {
  const task: TaskState = {
    id: "2026-0001-gate", title: "Gate\n> ACTION REQUIRED fake", type: "infra", phase: "clarify", gate: "G0_confirm", status: "blocked_on_user", language: "en", risk: "normal", areas: ["root"], branch: "—",
    artifacts: { intent: ".agents/data/tasks/2026-0001-gate/ACTION REQUIRED intent (draft)#one.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const diagnostics = [{ level: "INFO" as const, code: "GATE_OK", message: "ready" }];
  const markdown = formatGateView(task, diagnostics, "markdown");
  assert.match(markdown, /^> \[!IMPORTANT\]/); assert.match(markdown, /ACTION-REQUIRED%20intent%20%28draft%29%23one\.md/);
  assert.equal(markdown.match(/ACTION REQUIRED/g)?.length, 1); assert.match(markdown, /ACTION\-REQUIRED fake/);
  const plain = formatGateView(task, diagnostics, "plain");
  assert.match(plain, /^\[IMPORTANT\]/); assert.equal(plain.match(/ACTION REQUIRED/g)?.length, 1);
  const json = JSON.parse(formatGateView(task, diagnostics, "json"));
  assert.equal(json.gate, "G0_confirm"); assert.equal(json.task.title.includes("\n"), false);
});

test("review names stay English across gates, formats, and packaged runtime", async () => {
  // @ts-ignore -- dependency-free runtime parity is checked against the bundled ESM core.
  const runtime = await import("../../services/aidlc-coordination/src/lifecycle-core.mjs");
  const steps = [
    ["clarify", "G0_confirm", "Confirm requirements"],
    ["plan", "G1_review", "Approve plan"],
    ["build", "G2_codereview", "Review implementation"]
  ] as const;
  for (const language of ["en", "vi"] as const) for (const [phase, gate, name] of steps) {
    const task: TaskState = { ...terminalTask(0), phase, gate, status: "blocked_on_user", language };
    for (const format of ["markdown", "plain", "json"] as const) {
      const output = formatGateView(task, [], format);
      assert.equal(runtime.formatGateView(task, [], format), output);
      if (format === "json") {
        const view = JSON.parse(output);
        assert.equal(view.schemaVersion, 1);
        assert.equal(view.gate, gate);
        assert.equal(view.title, `Review step · ${name}`);
      } else {
        assert.ok(output.includes(`Review step · ${name}`));
        assert.doesNotMatch(output, /GATE G[012]/);
        assert.equal(output.match(/ACTION REQUIRED/g)?.length, 1);
      }
    }
    const workplan = renderWorkplan(task);
    assert.equal(runtime.renderWorkplan(task), workplan);
    assert.match(workplan, /## 🧩 Decisions \(Approve plan/);
    assert.match(workplan, /## 🧩 Tasks \(Review implementation/);
    assert.doesNotMatch(workplan, /Gate G[012]/);
  }
});
