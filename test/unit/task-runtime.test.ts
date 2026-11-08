import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/task-runtime.mjs"));
const loadMigrate = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/task-runtime-migrate.mjs"));

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-task-runtime-"));
  mkdirSync(join(root, ".agents", "data"), { recursive: true });
  return root;
};

test("runtime paths live under .agents/data/tasks/<id>/runtime and map every legacy location", async () => {
  const { taskRuntimeDir, taskRuntimePath, legacyTaskRuntimePath, TASK_RUNTIME_FILES, MIGRATED_TASK_RUNTIME_FILES, isTaskId } = await load();
  const root = fixture();
  try {
    assert.equal(taskRuntimeDir(root, "task-a"), join(root, ".agents/data/tasks/task-a/runtime"));
    assert.equal(taskRuntimePath(root, "task-a", "assignments.json"), join(root, ".agents/data/tasks/task-a/runtime/assignments.json"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "assignments.json"), join(root, ".agents/data/loop/assignments/task-a.json"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "assignments.lock"), join(root, ".agents/data/loop/assignments/task-a.lock"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "events.jsonl"), join(root, ".agents/data/loop/events/task-a.jsonl"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "events.jsonl.1"), join(root, ".agents/data/loop/events/task-a.jsonl.1"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "run.json"), join(root, ".agents/data/loop/task-a.json"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "intake.json"), join(root, ".agents/data/tasks/task-a/loop-intake.json"));
    assert.equal(legacyTaskRuntimePath(root, "task-a", "requirement.md"), join(root, ".agents/data/tasks/task-a/requirement.md"));
    assert.deepEqual(Object.keys(TASK_RUNTIME_FILES).sort(), ["assignments.json", "assignments.lock", "events.jsonl", "events.jsonl.1", "intake.json", "requirement.md", "run.json"]);
    assert.deepEqual([...MIGRATED_TASK_RUNTIME_FILES].sort(), ["assignments.json", "events.jsonl", "events.jsonl.1", "intake.json", "requirement.md", "run.json"], "locks are never migrated");
    for (const bad of ["../x", ".hidden", "a/b", "", "x".repeat(129), 42, null]) {
      assert.equal(isTaskId(bad), false);
      assert.throws(() => taskRuntimePath(root, bad, "run.json"), /Invalid task id/);
    }
    assert.throws(() => taskRuntimePath(root, "task-a", "other.json"), /Unknown task runtime file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reads prefer the runtime file, fall back to the legacy file, and refuse symlinked components", { skip: process.platform === "win32" }, async () => {
  const { resolveTaskRuntimeRead, taskRuntimePath, legacyTaskRuntimePath, ensureTaskRuntimeDir } = await load();
  const root = fixture();
  try {
    const current = taskRuntimePath(root, "t", "run.json"), legacy = legacyTaskRuntimePath(root, "t", "run.json");
    assert.equal(resolveTaskRuntimeRead(root, "t", "run.json"), current, "nothing exists: the current path (for a clean ENOENT)");
    mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
    writeFileSync(legacy, "{}");
    assert.equal(resolveTaskRuntimeRead(root, "t", "run.json"), legacy, "only the legacy file exists");
    const dir = ensureTaskRuntimeDir(root, "t");
    assert.equal(dir, join(root, ".agents/data/tasks/t/runtime"));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    writeFileSync(current, "{}");
    assert.equal(resolveTaskRuntimeRead(root, "t", "run.json"), current, "the runtime file wins when both exist");
    // A symlinked runtime directory fails closed for reads and writes.
    rmSync(dir, { recursive: true });
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, dir);
    assert.throws(() => taskRuntimePath(root, "t", "run.json"), /symlink/);
    assert.throws(() => resolveTaskRuntimeRead(root, "t", "run.json"), /symlink/);
    assert.throws(() => ensureTaskRuntimeDir(root, "t"), /symlink/);
    rmSync(dir);
    // A symlinked legacy file is not a regular file: the read resolves to the current path.
    rmSync(legacy);
    symlinkSync(join(root, "missing"), legacy);
    assert.throws(() => resolveTaskRuntimeRead(root, "t", "run.json"), /symlink/, "a planted legacy link is refused, not silently ignored");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration moves every legacy file once, skips existing destinations, never deletes, and reports dry runs", { skip: process.platform === "win32" }, async () => {
  const { migrateTaskRuntime, migrateAllTaskRuntime, legacyTaskRuntimeIds } = await loadMigrate();
  const { taskRuntimePath } = await load();
  const root = fixture();
  try {
    const data = join(root, ".agents/data");
    mkdirSync(join(data, "loop/assignments"), { recursive: true });
    mkdirSync(join(data, "loop/events"), { recursive: true });
    mkdirSync(join(data, "tasks/alpha"), { recursive: true });
    mkdirSync(join(data, "tasks/beta/runtime"), { recursive: true });
    writeFileSync(join(data, "loop/assignments/alpha.json"), "assignments");
    writeFileSync(join(data, "loop/assignments/alpha.lock"), "lock");
    writeFileSync(join(data, "loop/events/alpha.jsonl"), "events");
    writeFileSync(join(data, "loop/events/alpha.jsonl.1"), "rotated");
    writeFileSync(join(data, "loop/alpha.json"), "run");
    writeFileSync(join(data, "tasks/alpha/loop-intake.json"), "intake");
    writeFileSync(join(data, "tasks/alpha/requirement.md"), "requirement");
    writeFileSync(join(data, "tasks/alpha/intent.md"), "review artifact");
    // beta: a run record already under runtime/ and a legacy copy that must not overwrite it.
    writeFileSync(join(data, "loop/beta.json"), "old run");
    writeFileSync(join(data, "tasks/beta/runtime/run.json"), "new run");
    // Never task run records: lead checkpoint, gate receipt, dashboard/CLI records, the daemon lock and global sidecar.
    for (const name of ["alpha.supervisor.json", "alpha.gate-receipt.json", "ui.json", "cli.json", "daemon.lock", "ui-events.jsonl", "alpha.lease"]) writeFileSync(join(data, "loop", name), name);
    assert.deepEqual(legacyTaskRuntimeIds(root), ["alpha", "beta"]);

    const preview = migrateAllTaskRuntime(root, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.entries.map((entry: any) => [entry.taskId, entry.name, entry.action]), [
      ["alpha", "assignments.json", "would-move"], ["alpha", "events.jsonl", "would-move"], ["alpha", "events.jsonl.1", "would-move"], ["alpha", "run.json", "would-move"], ["alpha", "intake.json", "would-move"], ["alpha", "requirement.md", "would-move"],
      ["beta", "run.json", "skipped"],
    ]);
    assert.ok(existsSync(join(data, "loop/assignments/alpha.json")), "a dry run moves nothing");

    const result = migrateAllTaskRuntime(root);
    assert.equal(result.moved, 6);
    assert.equal(result.skipped, 1);
    assert.equal(result.entries.find((entry: any) => entry.taskId === "beta").reason, "destination already exists");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "assignments.json"), "utf8"), "assignments");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "events.jsonl"), "utf8"), "events");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "events.jsonl.1"), "utf8"), "rotated");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "run.json"), "utf8"), "run");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "intake.json"), "utf8"), "intake");
    assert.equal(readFileSync(taskRuntimePath(root, "alpha", "requirement.md"), "utf8"), "requirement");
    assert.equal(readFileSync(join(data, "tasks/alpha/intent.md"), "utf8"), "review artifact", "review artifacts stay at the task root");
    assert.equal(readFileSync(join(data, "tasks/beta/runtime/run.json"), "utf8"), "new run");
    assert.ok(existsSync(join(data, "loop/beta.json")), "a skipped source is left for inspection");
    assert.ok(existsSync(join(data, "loop/assignments/alpha.lock")), "locks stay (they expire on their own)");
    for (const name of ["alpha.supervisor.json", "alpha.gate-receipt.json", "ui.json", "cli.json", "daemon.lock", "ui-events.jsonl", "alpha.lease"]) assert.ok(existsSync(join(data, "loop", name)), `${name} stays in the loop directory`);
    assert.equal(existsSync(join(data, "tasks/alpha.supervisor")), false);
    for (const gone of ["loop/assignments/alpha.json", "loop/events/alpha.jsonl", "loop/events/alpha.jsonl.1", "loop/alpha.json", "tasks/alpha/loop-intake.json", "tasks/alpha/requirement.md"]) assert.equal(existsSync(join(data, gone)), false, `${gone} moved`);

    // Idempotent: a second run finds nothing for alpha and still skips beta.
    const again = migrateAllTaskRuntime(root);
    assert.equal(again.moved, 0);
    assert.deepEqual(legacyTaskRuntimeIds(root), ["beta"]);
    assert.deepEqual(migrateTaskRuntime(root, "alpha"), []);

    // A symlinked legacy file is skipped, never followed.
    symlinkSync(join(root, "outside.json"), join(data, "loop/gamma.json"));
    const gamma = migrateTaskRuntime(root, "gamma");
    assert.equal(gamma[0].action, "skipped");
    assert.match(gamma[0].reason, /symlink/);
    assert.equal(existsSync(join(data, "tasks/gamma")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-entry migrate-data and aidlc-kit loop migrate-data report and move; --dry-run previews", async () => {
  const { spawnSync } = await import("node:child_process");
  const { applyPlan, planInit } = await import("../../src/installer.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-migrate-cli-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const data = join(root, ".agents/data");
    mkdirSync(join(data, "loop/assignments"), { recursive: true });
    writeFileSync(join(data, "loop/assignments/task-a.json"), "{}");
    const entry = join(root, ".agents/aidlc/scripts/loop-entry.mjs");
    const preview = spawnSync(process.execPath, [entry, "migrate-data", root, "--dry-run", "--json"], { encoding: "utf8" });
    assert.equal(preview.status, 0, preview.stderr);
    const previewReport = JSON.parse(preview.stdout);
    assert.equal(previewReport.schemaVersion, 1);
    assert.equal(previewReport.dryRun, true);
    assert.deepEqual(previewReport.entries.map((item: any) => [item.taskId, item.name, item.action]), [["task-a", "assignments.json", "would-move"]]);
    assert.ok(existsSync(join(data, "loop/assignments/task-a.json")));
    const bad = spawnSync(process.execPath, [entry, "migrate-data", root, "--force"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown migrate-data option: --force/);
    const cli = resolve("dist/src/cli.js");
    const viaCli = spawnSync(process.execPath, [cli, "loop", "migrate-data", "--root", root], { encoding: "utf8" });
    assert.equal(viaCli.status, 0, viaCli.stderr);
    assert.match(viaCli.stdout, /moved: .*task-a\.json -> .*runtime\/assignments\.json/);
    assert.match(viaCli.stdout, /Moved 1 file\(s\), skipped 0\./);
    assert.equal(readFileSync(join(data, "tasks/task-a/runtime/assignments.json"), "utf8"), "{}");
    const nothing = spawnSync(process.execPath, [cli, "loop", "migrate-data", "--root", root], { encoding: "utf8" });
    assert.equal(nothing.status, 0, nothing.stderr);
    assert.match(nothing.stdout, /Nothing to migrate/);
    const badCli = spawnSync(process.execPath, [cli, "loop", "migrate-data", "--root", root, "--task-id", "x"], { encoding: "utf8" });
    assert.notEqual(badCli.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
