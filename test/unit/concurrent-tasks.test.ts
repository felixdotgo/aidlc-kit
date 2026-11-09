import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-concurrent-tasks-"));
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
  return root;
};
const run = (root: string, args: string[]): string => execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args], { cwd: root, encoding: "utf8" });
const spawnOne = (root: string, args: string[]) => spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args], { cwd: root, encoding: "utf8" });

test("multiple actionable tasks can be created without --switch-from; the flag is optional provenance", () => {
  const root = fixture();
  try {
    run(root, ["task", "create", "task-a", "--title", "First actionable"]);
    // The previously blocking guard is gone: a second actionable task needs no acknowledgement.
    const second = JSON.parse(run(root, ["task", "create", "task-b", "--title", "Second actionable"]));
    assert.equal(second.result.task.id, "task-b");
    assert.equal(second.nextAction.classification, "run_phase");
    // --switch-from still validates names and records a resume-marker diagnostic.
    run(root, ["task", "create", "task-c", "--title", "Third", "--switch-from", "task-b"]);
    const marker = JSON.parse(run(root, ["task", "show", "task-b"])).result.evidence.at(-1);
    assert.equal(marker.kind, "diagnostic");
    assert.match(marker.detail, new RegExp(`resume with task next task-b`));
    const unknown = spawnOne(root, ["task", "create", "task-d", "--title", "Fourth", "--switch-from", "missing-task"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /must name only actionable task/);
    const catalog = JSON.parse(run(root, ["task", "list"]));
    assert.equal(catalog.result.total, 3);
    for (const id of ["task-a", "task-b", "task-c"]) {
      assert.equal(JSON.parse(run(root, ["task", "show", id])).result.id, id);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent mutations on different tasks all persist on the shared SQLite store", async () => {
  const root = fixture();
  try {
    run(root, ["task", "create", "par-a", "--title", "Parallel A"]);
    run(root, ["task", "create", "par-b", "--title", "Parallel B"]);
    const spawnAsync = (id: string, item: string) => new Promise<void>((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "item", id, item, "--status", "todo", "--label", `Item ${item}`], { cwd: root });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", rejectRun);
      child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(`${id}/${item} exited ${code}: ${stderr}`)));
    });
    await Promise.all(Array.from({ length: 8 }, (_, index) => spawnAsync(index % 2 === 0 ? "par-a" : "par-b", `I${index}`)));
    for (const id of ["par-a", "par-b"]) {
      const shown = JSON.parse(run(root, ["task", "show", id])).result;
      assert.equal(shown.tasks.length, 4);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
