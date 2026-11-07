import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-stream.mjs"));

/** Run `body` with AIDLC_LOOP_EVENT_LOG pointing at `<tmp>/loop/ui-events.jsonl`. */
const withLog = async (name: string, body: (paths: { base: string; log: string; events: string }) => Promise<void> | void) => {
  const base = mkdtempSync(join(tmpdir(), `aidlc-stream-${name}-`));
  const log = join(base, "loop", "ui-events.jsonl");
  const previous = process.env.AIDLC_LOOP_EVENT_LOG;
  process.env.AIDLC_LOOP_EVENT_LOG = log;
  try { await body({ base, log, events: join(base, "loop", "events") }); }
  finally {
    if (previous === undefined) delete process.env.AIDLC_LOOP_EVENT_LOG;
    else process.env.AIDLC_LOOP_EVENT_LOG = previous;
    rmSync(base, { recursive: true, force: true });
  }
};
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("events with a taskId are also appended to the per-task history; the global log is unchanged", async () => {
  const { streamLog, taskEventLogPath } = await load();
  await withLog("task", ({ log, events }) => {
    assert.equal(taskEventLogPath(log, "task-a"), join(events, "task-a.jsonl"));
    streamLog({ type: "daemon_poll", actionable: ["task-a"] });
    streamLog({ type: "agent_tool", taskId: "task-a", actor: "lead", phase: "build", tool: "Bash", summary: "npm test" });
    streamLog({ type: "agent_text", taskId: "task-b", text: "hello" });
    streamLog({ type: "turn_end", taskId: "task-a", iteration: 0 });
    const global = lines(log);
    assert.deepEqual(global.map((event) => [event.type, event.taskId]), [["daemon_poll", undefined], ["agent_tool", "task-a"], ["agent_text", "task-b"], ["turn_end", "task-a"]]);
    assert.ok(global.every((event) => typeof event.at === "string"));
    const perTask = readFileSync(join(events, "task-a.jsonl"), "utf8");
    // Same serialized line (including `at`) as in the global log.
    assert.equal(perTask, readFileSync(log, "utf8").split("\n").filter((line) => line.includes('"taskId":"task-a"')).map((line) => `${line}\n`).join(""));
    assert.deepEqual(lines(join(events, "task-a.jsonl")).map((event) => event.type), ["agent_tool", "turn_end"]);
    assert.deepEqual(lines(join(events, "task-b.jsonl")).map((event) => event.text), ["hello"]);
  });
});

test("per-task history rotates to one .1 generation at 1 MiB", async () => {
  const { streamLog, TASK_EVENT_LOG_MAX_BYTES, EVENT_LOG_MAX_BYTES } = await load();
  assert.equal(TASK_EVENT_LOG_MAX_BYTES, 1024 * 1024);
  await withLog("rotate", ({ log, events }) => {
    streamLog({ type: "turn_start", taskId: "t1" });
    const path = join(events, "t1.jsonl");
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

test("invalid task ids never produce a per-task file", async () => {
  const { streamLog, taskEventLogPath } = await load();
  await withLog("invalid", ({ log, events }) => {
    for (const taskId of ["../escape", ".hidden", "a/b", "", "x".repeat(129), "white space"]) {
      assert.equal(taskEventLogPath(log, taskId), null);
      streamLog({ type: "note", taskId });
    }
    streamLog({ type: "note", taskId: 42 });
    assert.equal(lines(log).length, 7, "the global log still records them");
    assert.equal(existsSync(events), false);
    assert.equal(existsSync(join(log, "..", "..", "escape.jsonl")), false);
  });
});

test("symlinked per-task directories and files are refused without breaking the global log", { skip: process.platform === "win32" }, async () => {
  const { streamLog } = await load();
  await withLog("symlink-dir", ({ base, log, events }) => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    mkdirSync(join(base, "loop"), { recursive: true });
    symlinkSync(outside, events);
    assert.doesNotThrow(() => streamLog({ type: "agent_text", taskId: "t1", text: "x" }));
    assert.equal(existsSync(join(outside, "t1.jsonl")), false);
    assert.equal(lines(log).length, 1);
  });
  await withLog("symlink-file", ({ base, log, events }) => {
    const target = join(base, "target.txt");
    writeFileSync(target, "original");
    mkdirSync(events, { recursive: true });
    symlinkSync(target, join(events, "t1.jsonl"));
    assert.doesNotThrow(() => streamLog({ type: "agent_text", taskId: "t1", text: "x" }));
    assert.equal(readFileSync(target, "utf8"), "original");
    symlinkSync(target, join(events, "t2.jsonl.1"));
    streamLog({ type: "agent_text", taskId: "t2", text: "x" });
    assert.equal(existsSync(join(events, "t2.jsonl")), false, "a planted rotation link refuses the file too");
    assert.equal(lines(log).length, 2);
  });
});

test("streamLog renders tool and command summaries on stderr", async () => {
  const { streamLog } = await load();
  const previous = process.env.AIDLC_LOOP_EVENT_LOG;
  delete process.env.AIDLC_LOOP_EVENT_LOG;
  const written: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    streamLog({ type: "agent_tool", tool: "Edit", summary: "src/a.ts" });
    streamLog({ type: "agent_tool", tool: "grep" });
    streamLog({ type: "lifecycle_command", status: "completed", exitCode: 0, summary: "npm test" });
    streamLog({ type: "lifecycle_command", status: "failed", exitCode: 1 });
  } finally {
    process.stderr.write = original;
    if (previous !== undefined) process.env.AIDLC_LOOP_EVENT_LOG = previous;
  }
  assert.deepEqual(written, ["  › tool: Edit · src/a.ts\n", "  › tool: grep\n", "  › command completed (exit 0): npm test\n", "  › command failed (exit 1)\n"]);
});
