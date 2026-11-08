import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-stream.mjs"));

/** Run `body` with AIDLC_LOOP_EVENT_LOG pointing at `<root>/.agents/data/loop/ui-events.jsonl`;
 * `taskLog(id)` is the task's history `<root>/.agents/data/tasks/<id>/runtime/events.jsonl`. */
const withLog = async (name: string, body: (paths: { root: string; log: string; taskLog: (id: string) => string }) => Promise<void> | void) => {
  const root = mkdtempSync(join(tmpdir(), `aidlc-stream-${name}-`));
  const log = join(root, ".agents", "data", "loop", "ui-events.jsonl");
  const taskLog = (id: string) => join(root, ".agents", "data", "tasks", id, "runtime", "events.jsonl");
  const previous = process.env.AIDLC_LOOP_EVENT_LOG;
  process.env.AIDLC_LOOP_EVENT_LOG = log;
  try { await body({ root, log, taskLog }); }
  finally {
    if (previous === undefined) delete process.env.AIDLC_LOOP_EVENT_LOG;
    else process.env.AIDLC_LOOP_EVENT_LOG = previous;
    rmSync(root, { recursive: true, force: true });
  }
};
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("events with a taskId are also appended to the per-task history; the global log is unchanged", async () => {
  const { streamLog, taskEventLogPath, loopRootFromEventLog } = await load();
  await withLog("task", ({ root, log, taskLog }) => {
    assert.equal(loopRootFromEventLog(log), root);
    assert.equal(loopRootFromEventLog(join(root, "elsewhere", "ui-events.jsonl")), null, "a sidecar outside .agents/data/loop has no task history");
    assert.equal(loopRootFromEventLog(join(root, ".agents", "data", "myloop", "ui-events.jsonl")), null, "directory names must match exactly");
    assert.equal(taskEventLogPath(root, "task-a"), taskLog("task-a"));
    streamLog({ type: "daemon_poll", actionable: ["task-a"] });
    streamLog({ type: "agent_tool", taskId: "task-a", actor: "lead", phase: "build", tool: "Bash", summary: "npm test" });
    streamLog({ type: "agent_text", taskId: "task-b", text: "hello" });
    streamLog({ type: "turn_end", taskId: "task-a", iteration: 0 });
    const global = lines(log);
    assert.deepEqual(global.map((event) => [event.type, event.taskId]), [["daemon_poll", undefined], ["agent_tool", "task-a"], ["agent_text", "task-b"], ["turn_end", "task-a"]]);
    assert.ok(global.every((event) => typeof event.at === "string"));
    const perTask = readFileSync(taskLog("task-a"), "utf8");
    // Same serialized line (including `at`) as in the global log.
    assert.equal(perTask, readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"taskId":"task-a"')).map((line) => `${line}\n`).join(""));
    assert.deepEqual(lines(taskLog("task-a")).map((event) => event.type), ["agent_tool", "turn_end"]);
    assert.deepEqual(lines(taskLog("task-b")).map((event) => event.text), ["hello"]);
    assert.equal(existsSync(join(root, ".agents", "data", "loop", "events")), false, "nothing is written to the pre-runtime location");
  });
});

test("per-task history rotates to one .1 generation at 1 MiB", async () => {
  const { streamLog, TASK_EVENT_LOG_MAX_BYTES, EVENT_LOG_MAX_BYTES } = await load();
  assert.equal(TASK_EVENT_LOG_MAX_BYTES, 1024 * 1024);
  await withLog("rotate", ({ log, taskLog }) => {
    streamLog({ type: "turn_start", taskId: "t1" });
    const path = taskLog("t1");
    writeFileSync(path, "x".repeat(TASK_EVENT_LOG_MAX_BYTES));
    streamLog({ type: "turn_end", taskId: "t1" });
    assert.equal(readFileSync(`${path}.1`, "utf8").length, TASK_EVENT_LOG_MAX_BYTES);
    assert.deepEqual(lines(path).map((event) => event.type), ["turn_end"]);
    writeFileSync(path, "y".repeat(TASK_EVENT_LOG_MAX_BYTES));
    streamLog({ type: "loop_stopped", taskId: "t1" });
    assert.match(readFileSync(`${path}.1`, "utf8"), /^y+$/, "only one generation is kept");
    assert.deepEqual(lines(path).map((event) => event.type), ["loop_stopped"]);
    assert.ok(EVENT_LOG_MAX_BYTES > TASK_EVENT_LOG_MAX_BYTES);
    assert.equal(lines(log).length, 3, "the global log keeps every event");
  });
});

test("a pre-runtime per-task history is moved under runtime/ before the first append", async () => {
  const { streamLog } = await load();
  await withLog("legacy", ({ root, taskLog }) => {
    const legacyDir = join(root, ".agents", "data", "loop", "events");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "old.jsonl"), `${JSON.stringify({ type: "turn_start", taskId: "old" })}\n`);
    writeFileSync(join(legacyDir, "old.jsonl.1"), "rotated\n");
    streamLog({ type: "turn_end", taskId: "old" });
    assert.deepEqual(lines(taskLog("old")).map((event) => event.type), ["turn_start", "turn_end"], "history continues in one file");
    assert.equal(readFileSync(`${taskLog("old")}.1`, "utf8"), "rotated\n");
    assert.equal(existsSync(join(legacyDir, "old.jsonl")), false);
    assert.equal(existsSync(join(legacyDir, "old.jsonl.1")), false);
  });
});

test("invalid task ids never produce a per-task file", async () => {
  const { streamLog, taskEventLogPath } = await load();
  await withLog("invalid", ({ root, log }) => {
    for (const taskId of ["../escape", ".hidden", "a/b", "", "x".repeat(129), "white space"]) {
      assert.equal(taskEventLogPath(root, taskId), null);
      streamLog({ type: "note", taskId });
    }
    streamLog({ type: "note", taskId: 42 });
    assert.equal(lines(log).length, 7, "the global log still records them");
    assert.equal(existsSync(join(root, ".agents", "data", "tasks")), false);
    assert.equal(existsSync(join(root, ".agents", "data", "loop", "events")), false);
    assert.equal(existsSync(join(root, "escape.jsonl")), false);
    assert.equal(existsSync(join(root, ".agents", "escape.jsonl")), false);
  });
});

test("symlinked per-task directories and files are refused without breaking the global log", { skip: process.platform === "win32" }, async () => {
  const { streamLog } = await load();
  await withLog("symlink-dir", ({ root, log, taskLog }) => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, ".agents", "data", "tasks", "t1"), { recursive: true });
    symlinkSync(outside, join(root, ".agents", "data", "tasks", "t1", "runtime"));
    assert.doesNotThrow(() => streamLog({ type: "agent_text", taskId: "t1", text: "x" }));
    assert.equal(existsSync(join(outside, "events.jsonl")), false);
    assert.equal(existsSync(taskLog("t1")), false);
    assert.equal(lines(log).length, 1);
  });
  await withLog("symlink-file", ({ root, log, taskLog }) => {
    const target = join(root, "target.txt");
    writeFileSync(target, "original");
    for (const id of ["t1", "t2"]) mkdirSync(join(root, ".agents", "data", "tasks", id, "runtime"), { recursive: true });
    symlinkSync(target, taskLog("t1"));
    assert.doesNotThrow(() => streamLog({ type: "agent_text", taskId: "t1", text: "x" }));
    assert.equal(readFileSync(target, "utf8"), "original");
    symlinkSync(target, `${taskLog("t2")}.1`);
    streamLog({ type: "agent_text", taskId: "t2", text: "x" });
    assert.equal(existsSync(taskLog("t2")), false, "a planted rotation link refuses the file too");
    assert.equal(lines(log).length, 2);
  });
});
