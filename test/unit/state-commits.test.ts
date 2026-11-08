import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { TaskState } from "../../src/model.js";
import { validateState } from "../../src/state.js";

const scripts = resolve("dist/assets/.agents/aidlc/scripts");
const store = await import(pathToFileURL(join(scripts, "lib/store.mjs")).href);
const repoHead = await import(pathToFileURL(join(scripts, "lib/repo-head.mjs")).href);

const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=aidlc", "-c", "user.email=aidlc@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const initRepo = (cwd: string): string => { git(cwd, ["init", "-q"]); git(cwd, ["commit", "-q", "--allow-empty", "-m", "initial"]); return git(cwd, ["rev-parse", "HEAD"]); };

const baseTask = (id: string, overrides: Partial<TaskState> = {}): TaskState => ({
  id, title: "Commit fixture", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—",
  artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, design: `.agents/data/tasks/${id}/design.md`, workplan: `.agents/data/tasks/${id}/workplan.md` },
  decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides
});

/** Temp project with the built lifecycle scripts installed; optionally seeded with a wrap-phase task that can move to done. */
function project(seed?: TaskState): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-state-commits-"));
  cpSync(resolve("dist/assets/.agents/aidlc"), join(root, ".agents/aidlc"), { recursive: true });
  mkdirSync(join(root, ".agents/data/state"), { recursive: true });
  if (seed) {
    writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), JSON.stringify({ schemaVersion: 4, tasks: { [seed.id]: seed }, archive: {} }));
    mkdirSync(join(root, ".agents/data/tasks", seed.id), { recursive: true });
  }
  return root;
}
const wrapTask = (id: string): TaskState => baseTask(id, { phase: "wrap", gate: "none", lessonDisposition: { status: "none", reason: "fixture", source: "unit test", recordedAt: "2026-01-01T00:00:01.000Z" } });
const run = (root: string, args: string[]) => {
  const result = spawnSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args, "--root", root], { cwd: root, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, json: result.status === 0 ? JSON.parse(result.stdout) : undefined };
};
const readState = (root: string) => JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));

test("recordTaskCommit validates the field and SHA and bumps updatedAt", () => {
  const task: any = baseTask("rec");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.throws(() => store.recordTaskCommit(task, "headCommit", sha), /Unknown task commit field/);
  assert.throws(() => store.recordTaskCommit(task, "baseCommit", "abc123"), /Invalid baseCommit/);
  assert.throws(() => store.recordTaskCommit(task, "baseCommit", sha.toUpperCase()), /Invalid baseCommit/);
  assert.throws(() => store.recordTaskCommit(task, "finalCommit", `${sha}zz`), /Invalid finalCommit/);
  assert.throws(() => store.recordTaskCommit(task, "baseCommit", 42), /Invalid baseCommit/);
  assert.throws(() => store.recordTaskCommit(undefined, "baseCommit", sha), /requires a task/);
  assert.equal(task.baseCommit, undefined);
  const returned = store.recordTaskCommit(task, "baseCommit", "abcdef1");
  assert.equal(returned, task);
  assert.equal(task.baseCommit, "abcdef1");
  assert.ok(Date.parse(task.updatedAt) > Date.parse("2026-01-01T00:00:00.000Z"));
  store.recordTaskCommit(task, "finalCommit", sha);
  assert.equal(task.finalCommit, sha);
});

test("local core, shared core, and TypeScript validation accept and reject the commit fields identically", async () => {
  // @ts-ignore -- runtime conformance against the verbatim service copy.
  const core = await import("../../services/aidlc-coordination/src/lifecycle-core.mjs");
  const valid = { schemaVersion: 4 as const, tasks: { ok: baseTask("ok", { baseCommit: "abcdef1", finalCommit: "0123456789abcdef0123456789abcdef01234567" }) }, archive: {} };
  assert.doesNotThrow(() => validateState(structuredClone(valid)));
  assert.doesNotThrow(() => store.validateState(structuredClone(valid)));
  assert.doesNotThrow(() => core.validateState(structuredClone(valid)));
  for (const bad of [{ baseCommit: "ABCDEF1" }, { finalCommit: "abc" }, { baseCommit: 123 as unknown as string }, { finalCommit: "" }]) {
    const invalid = { schemaVersion: 4 as const, tasks: { bad: baseTask("bad", bad as Partial<TaskState>) }, archive: {} };
    assert.throws(() => validateState(structuredClone(invalid)), /Invalid task (base|final)Commit: bad/);
    assert.throws(() => store.validateState(structuredClone(invalid)), /Invalid task (base|final)Commit: bad/);
    assert.throws(() => core.validateState(structuredClone(invalid)), /Invalid task (base|final)Commit: bad/);
  }
});

test("headCommit returns the HEAD SHA for a repository and undefined otherwise", () => {
  const repo = mkdtempSync(join(tmpdir(), "aidlc-repo-head-"));
  const plain = mkdtempSync(join(tmpdir(), "aidlc-repo-plain-"));
  try {
    assert.equal(repoHead.headCommit(plain), undefined);
    assert.equal(repoHead.headCommit(join(plain, "missing")), undefined);
    assert.equal(repoHead.headCommit(undefined), undefined);
    assert.equal(repoHead.headCommit(""), undefined);
    git(repo, ["init", "-q"]);
    assert.equal(repoHead.headCommit(repo), undefined, "unborn branch has no commit");
    git(repo, ["commit", "-q", "--allow-empty", "-m", "initial"]);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    assert.equal(repoHead.headCommit(repo), sha);
    assert.match(sha, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("state.mjs task create records baseCommit from HEAD and omits it outside a repository", () => {
  const repoRoot = project();
  const plainRoot = project();
  try {
    const sha = initRepo(repoRoot);
    const created = run(repoRoot, ["task", "create", "commit-create", "--title", "Create in repo"]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(created.json.result.task.baseCommit, sha);
    assert.equal(created.json.result.task.finalCommit, undefined);
    assert.equal(readState(repoRoot).tasks["commit-create"].baseCommit, sha);

    const plain = run(plainRoot, ["task", "create", "commit-plain", "--title", "Create outside repo"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.json.result.task.baseCommit, undefined);
    assert.equal("baseCommit" in readState(plainRoot).tasks["commit-plain"], false);

    const override = run(plainRoot, ["task", "create", "commit-override", "--title", "Explicit base", "--base-commit", "abcdef1234567", "--switch-from", "commit-plain"]);
    assert.equal(override.status, 0, override.stderr);
    assert.equal(override.json.result.task.baseCommit, "abcdef1234567");
    const rejected = run(plainRoot, ["task", "create", "commit-bad", "--title", "Bad base", "--base-commit", "not-a-sha", "--switch-from", "commit-plain,commit-override"]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Invalid baseCommit/);
    assert.equal(readState(plainRoot).tasks["commit-bad"], undefined);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
  }
});

test("state.mjs transition --to done records finalCommit and keeps baseCommit", () => {
  const root = project(wrapTask("commit-done"));
  try {
    const sha = initRepo(root);
    const state = readState(root); state.tasks["commit-done"].baseCommit = "abcdef1"; writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), JSON.stringify(state));
    const early = run(root, ["task", "transition", "commit-done", "--mode", "audited", "--reason", "r", "--source", "s", "--to", "clarify", "--final-commit", sha]);
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /--final-commit is only accepted with --to done/);
    const done = run(root, ["task", "transition", "commit-done", "--mode", "audited", "--reason", "finished", "--source", "unit test", "--to", "done"]);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(done.json.result.task.status, "done");
    assert.equal(done.json.result.task.baseCommit, "abcdef1");
    assert.equal(done.json.result.task.finalCommit, sha);
    const archived = JSON.parse(readFileSync(join(root, ".agents/data/state/archive/commit-done.json"), "utf8"));
    assert.equal(archived.baseCommit, "abcdef1");
    assert.equal(archived.finalCommit, sha);
    assert.equal(readState(root).tasks["commit-done"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state.mjs task archive records finalCommit from HEAD or an explicit override", () => {
  const repoRoot = project(wrapTask("commit-archive"));
  const plainRoot = project(wrapTask("commit-archive-plain"));
  try {
    const sha = initRepo(repoRoot);
    const archived = run(repoRoot, ["task", "archive", "commit-archive", "--reason", "finished", "--source", "unit test"]);
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(archived.json.result.task.finalCommit, sha);
    assert.equal(JSON.parse(readFileSync(join(repoRoot, ".agents/data/state/archive/commit-archive.json"), "utf8")).finalCommit, sha);

    const explicit = run(plainRoot, ["task", "archive", "commit-archive-plain", "--reason", "finished", "--source", "unit test", "--final-commit", "fedcba9876543210"]);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(explicit.json.result.task.finalCommit, "fedcba9876543210");
    assert.ok(existsSync(join(plainRoot, ".agents/data/state/archive/commit-archive-plain.json")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
  }
});

test("state.mjs task archive outside a repository leaves finalCommit unset", () => {
  const root = project(wrapTask("commit-archive-none"));
  try {
    const archived = run(root, ["task", "archive", "commit-archive-none", "--reason", "finished", "--source", "unit test"]);
    assert.equal(archived.status, 0, archived.stderr);
    assert.equal(archived.json.result.task.finalCommit, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
