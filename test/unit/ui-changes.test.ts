import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import type { TaskState } from "../../src/model.js";

/* Task changes page and API (`/tasks/:id/changes`, `/api/tasks/:id/changes`) over a real
 * server on port 0 and a temporary git repository. */

const makeTask = (overrides: Partial<TaskState> = {}): TaskState => {
  const now = new Date().toISOString();
  return {
    id: "task-a", title: "Task A", type: "infra", phase: "build", gate: "G2_codereview", status: "active",
    language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {},
    decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now, ...overrides,
  };
};

/** git without anything from the caller's environment that would redirect it (e.g. when tests run from a hook). */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) delete env[name];
  return env;
};
const REAL_GIT = process.platform === "win32" ? "git" : execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const git = (root: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: root, env: gitEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const writeFile = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
/** Writes files and commits them; returns the full commit SHA. */
const commit = (root: string, message: string, files: Record<string, string | Buffer>): string => {
  for (const [path, content] of Object.entries(files)) writeFile(root, path, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const writeAssignments = (root: string, taskId: string, assignments: Array<Record<string, unknown>>): void => {
  const now = new Date().toISOString();
  writeFile(root, `.agents/data/tasks/${taskId}/runtime/assignments.json`, JSON.stringify({
    schemaVersion: 1, taskId,
    assignments: assignments.map((entry, index) => ({ id: `a-${index}`, taskId, workerId: "w1", ownedPaths: ["src"], attempt: 1, leaseExpiresAt: now, createdAt: now, updatedAt: now, ...entry })),
  }));
};

interface Fixture { base: string; root: string; close: () => Promise<void> }

/** A task that reached `done` (archived by `saveState`, read back through the archive record). */
const makeDoneTask = (overrides: Partial<TaskState> = {}): TaskState => makeTask({ phase: "done", gate: "none", status: "done", ...overrides });

/** Local-mode server over a git repo whose `.agents/` (canonical state, loop records) is ignored. Tasks may be built from the repository (e.g. its base SHA). */
const startFixture = async (tasks: TaskState[] | ((root: string) => TaskState[]) = [makeTask()], { repo = true }: { repo?: boolean } = {}): Promise<Fixture> => {
  const { emptyState, saveState } = await import("../../src/state.js");
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-changes-"));
  if (repo) {
    git(root, "init", "-q");
    commit(root, "base", { ".gitignore": ".agents/\n", "README.md": "# Fixture\n" });
  }
  const state = emptyState();
  for (const task of typeof tasks === "function" ? tasks(root) : tasks) state.tasks[task.id] = task;
  saveState(root, state);
  const { server, port } = await startUiServer({ root, host: "127.0.0.1", port: 0, mode: "local" });
  const close = (): Promise<void> => new Promise<void>((done) => { server.close(() => done()); rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, root, close };
};

interface ChangesJson { ok: boolean; error?: string; source?: string; note?: string; items?: Array<{ itemId: string; workerId?: string; commit: string; base?: string; files: Array<{ path: string; oldPath?: string; status: string; added: number; removed: number; binary: boolean; whitespaceOnly?: boolean }>; patch: string; truncated: boolean; note?: string; workingTree?: true }> }
const getJson = async (url: string): Promise<{ status: number; body: ChangesJson }> => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as ChangesJson };
};

const rawRequest = (base: string, path: string, headers: Record<string, string>): Promise<number> =>
  new Promise((done, reject) => {
    const url = new URL(base);
    const req = request({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => { res.resume(); res.on("end", () => done(res.statusCode ?? 0)); });
    req.on("error", reject);
    req.end();
  });

/** Puts a logging `git` wrapper first on PATH: every invocation's argv lands in the returned log. */
const traceGit = (dir: string): { log: () => string[]; restore: () => void } => {
  const bin = join(dir, "bin");
  const logPath = join(dir, "git-calls.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${REAL_GIT}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${previous ?? ""}`;
  return {
    log: () => existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [],
    restore: () => { process.env["PATH"] = previous; },
  };
};

test("local assignments: integration commit, base..commit fallback, missing object note, latest non-released attempt", async () => {
  const fixture = await startFixture();
  try {
    const { root, base } = fixture;
    const start = git(root, "rev-parse", "HEAD");
    const c1 = commit(root, "item a", { "src/a.ts": "export const hello = 1;\n", "README.md": "# Fixture\nchanged line\n", "src/logo.bin": Buffer.from([0, 1, 2, 0, 255, 0, 3]) });
    const c2 = commit(root, "item b", { "src/b.ts": "export const b = 2;\n" });
    writeAssignments(root, "task-a", [
      { itemId: "item-a", attempt: 1, state: "released", commit: c2, baseCommit: start },
      { itemId: "item-a", attempt: 2, state: "integrated", workerId: "w2", commit: "a".repeat(40), baseCommit: start, integrationCommit: c1 },
      { itemId: "item-b", state: "reported", commit: c2, baseCommit: c1 },
      { itemId: "item-c", state: "reported", commit: "0123456789abcdef0123456789abcdef01234567", baseCommit: c1 },
      { itemId: "item-d", state: "released", commit: c2, baseCommit: c1 },
      { itemId: "item-e", state: "leased" },
    ]);

    const whole = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(whole.status, 200);
    assert.equal(whole.body.source, "assignments");
    assert.deepEqual(whole.body.items?.map((item) => item.itemId), ["item-a", "item-b", "item-c"], "released and leased attempts are skipped");
    const [a, b, c] = whole.body.items!;
    assert.equal(a!.commit, c1, "the integration commit wins over the worker commit");
    assert.equal(a!.base, start, "diffed against its parent");
    assert.equal(a!.workerId, "w2", "latest attempt");
    assert.deepEqual(a!.files.map((file) => [file.path, file.status, file.added, file.removed, file.binary]), [
      ["README.md", "modified", 1, 0, false],
      ["src/a.ts", "added", 1, 0, false],
      ["src/logo.bin", "added", 0, 0, true],
    ]);
    assert.match(a!.patch, /^\+export const hello = 1;$/m);
    assert.equal(a!.truncated, false);
    assert.equal(b!.commit, c2);
    assert.equal(b!.base, c1, "base..commit when no integration commit is recorded");
    assert.deepEqual(b!.files.map((file) => file.path), ["src/b.ts"]);
    assert.equal(c!.note, "commit not available in the local repository");
    assert.deepEqual(c!.files, []);

    const one = await getJson(`${base}/api/tasks/task-a/changes?item=item-b`);
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.items?.map((item) => item.itemId), ["item-b"]);
    assert.equal((await getJson(`${base}/api/tasks/task-a/changes?item=item-d`)).status, 404, "a released item has no changes");

    const page = await fetch(`${base}/tasks/task-a/changes`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<a class="ad-breadcrumb" href="\/tasks\/task-a">/);
    assert.match(html, /Item · item-a/);
    assert.match(html, /<div class="ad-diff-line ad-diff-add">\+export const hello = 1;<\/div>/);
    assert.match(html, /<div class="ad-diff-line ad-diff-hunk">@@ /);
    assert.match(html, /<div class="ad-diff-line ad-diff-meta">diff --git a\/README\.md b\/README\.md<\/div>/);
    assert.match(html, /Binary file changed\./);
    assert.match(html, /commit not available in the local repository/);
    assert.match(html, /<option value="item-b">/, "item selector");
    assert.match(html, /<script src="\/assets\/changes\.js\?v=[0-9a-f]{12}"><\/script>/);
    const selected = await (await fetch(`${base}/tasks/task-a/changes?item=item-b`)).text();
    assert.match(selected, /data-change-item="item-a" hidden/, "other items are hidden server-side");
    assert.match(selected, /data-change-item="item-b">/);
    assert.equal((await fetch(`${base}/tasks/task-a/changes?item=nope`)).status, 404);
    const script = await fetch(`${base}/assets/changes.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally { await fixture.close(); }
});

test("working-tree fallback lists tracked changes and untracked files when the task has no loop records", async () => {
  const fixture = await startFixture();
  try {
    writeFile(fixture.root, "README.md", "# Fixture\nlocal edit\n");
    writeFile(fixture.root, "notes/new file.txt", "draft\n");
    const res = await getJson(`${fixture.base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "working-tree");
    const [item] = res.body.items!;
    assert.equal(item!.itemId, "working-tree");
    assert.deepEqual(item!.files.map((file) => [file.path, file.status]), [["README.md", "modified"], ["notes/new file.txt", "untracked"]]);
    assert.match(item!.patch, /^\+local edit$/m);
    assert.doesNotMatch(item!.patch, /draft/, "untracked files carry no patch");
    assert.equal(res.body.note, undefined, "a task created before base commits were recorded falls straight to the working tree");
    const html = await (await fetch(`${fixture.base}/tasks/task-a/changes`)).text();
    assert.match(html, /Working tree \(uncommitted, not task-scoped\)/);
    assert.match(html, /Untracked file: not in git yet/);
    assert.match(html, /data-changes-source="working-tree"/);
  } finally { await fixture.close(); }
});

test("task-range: an open task with a base commit diffs base → HEAD plus the working tree in one item", async () => {
  const fixture = await startFixture((root) => [makeTask({ baseCommit: git(root, "rev-parse", "HEAD") })]);
  try {
    const { root, base } = fixture;
    const start = git(root, "rev-parse", "HEAD");
    const c1 = commit(root, "after base", { "src/a.ts": "export const hello = 1;\n" });
    writeFile(root, "README.md", "# Fixture\nlocal edit\n");
    writeFile(root, "notes/draft.txt", "draft\n");
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "task-range");
    assert.equal(res.body.note, undefined, "nothing was skipped: no payload note");
    const [item] = res.body.items!;
    assert.equal(res.body.items!.length, 1);
    assert.equal(item!.itemId, "task");
    assert.equal(item!.base, start);
    assert.equal(item!.commit, c1, "HEAD while the task is open");
    assert.equal(item!.workingTree, true);
    assert.deepEqual(item!.files.map((file) => [file.path, file.status]), [["README.md", "modified"], ["src/a.ts", "added"], ["notes/draft.txt", "untracked"]]);
    assert.match(item!.patch, /^\+export const hello = 1;$/m, "the commit after the base is included");
    assert.match(item!.patch, /^\+local edit$/m, "the uncommitted change is included");
    assert.match(item!.note ?? "", /task range from the task's base commit; may include commits made outside this task; working tree included/);
    assert.equal((await getJson(`${base}/api/tasks/task-a/changes?item=task`)).status, 200);
    assert.equal((await getJson(`${base}/api/tasks/task-a/changes?item=working-tree`)).status, 404);
    assert.equal((await getJson(`${base}/api/tasks/task-a/changes?item=other`)).status, 404);
    const html = await (await fetch(`${base}/tasks/task-a/changes`)).text();
    assert.match(html, /data-changes-source="task-range"/);
    assert.match(html, /source · task range/);
    assert.match(html, new RegExp(`Task range · base ${start.slice(0, 7)} → HEAD \\+ working tree`));
    assert.match(html, /working tree included/);
    assert.match(html, /<span class="ad-changes-options" data-changes-options hidden>/, "display toggles are revealed by changes.js");
    assert.match(html, /<input type="checkbox" data-changes-wrap checked>/);
    assert.match(html, /<input type="checkbox" data-changes-ws>/);
    assert.match(html, /class="ad-changes-diff is-wrapped"/);
    assert.equal((await fetch(`${base}/tasks/task-a/changes?item=task`)).status, 200);
    assert.equal((await fetch(`${base}/tasks/task-a/changes?item=other`)).status, 404);
  } finally { await fixture.close(); }
});

test("task-range: a done task diffs base → final commit only, excluding later uncommitted changes", async () => {
  let c1 = "";
  const fixture = await startFixture((root) => {
    const start = git(root, "rev-parse", "HEAD");
    c1 = commit(root, "task work", { "src/a.ts": "export const hello = 1;\n" });
    return [makeDoneTask({ id: "done-a", baseCommit: start, finalCommit: c1 }), makeDoneTask({ id: "done-empty", baseCommit: start, finalCommit: start })];
  });
  try {
    const { root, base } = fixture;
    writeFile(root, "README.md", "# Fixture\nlater edit\n");
    writeFile(root, "notes/later.txt", "later\n");
    const res = await getJson(`${base}/api/tasks/done-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "task-range");
    const [item] = res.body.items!;
    assert.equal(item!.commit, c1);
    assert.equal(item!.workingTree, undefined);
    assert.deepEqual(item!.files.map((file) => file.path), ["src/a.ts"]);
    assert.doesNotMatch(item!.patch, /later edit/);
    assert.doesNotMatch(item!.note ?? "", /working tree/);
    assert.match(item!.note ?? "", /may include commits made outside this task/);
    const html = await (await fetch(`${base}/tasks/done-a/changes`)).text();
    assert.match(html, new RegExp(`Task range · base [0-9a-f]{7} → ${c1.slice(0, 7)}`));
    const empty = await getJson(`${base}/api/tasks/done-empty/changes`);
    assert.equal(empty.body.source, "task-range");
    assert.deepEqual(empty.body.items![0]!.files, []);
    assert.equal(empty.body.items![0]!.note, "no changes since the task's base commit");
  } finally { await fixture.close(); }
});

test("task-range: a base commit missing from the repository falls back to the working tree with a note", async () => {
  const fixture = await startFixture([makeTask({ baseCommit: "f".repeat(40) })]);
  try {
    writeFile(fixture.root, "README.md", "# Fixture\nlocal edit\n");
    const res = await getJson(`${fixture.base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "working-tree");
    assert.equal(res.body.note, "recorded base commit is not in the local repository; showing the working tree instead");
    assert.deepEqual(res.body.items!.map((item) => item.itemId), ["working-tree"]);
    assert.equal((await getJson(`${fixture.base}/api/tasks/task-a/changes?item=task`)).status, 404);
  } finally { await fixture.close(); }
});

test("task-range stands in when every assignment commit is gone from the repository", async () => {
  const fixture = await startFixture((root) => [makeTask({ baseCommit: git(root, "rev-parse", "HEAD") })]);
  try {
    const { root, base } = fixture;
    commit(root, "kept", { "src/kept.ts": "export const kept = true;\n" });
    writeAssignments(root, "task-a", [
      { itemId: "item-a", state: "integrated", integrationCommit: "e".repeat(40), commit: "d".repeat(40), baseCommit: "c".repeat(40) },
      { itemId: "item-b", state: "reported", commit: "0123456789abcdef0123456789abcdef01234567" },
    ]);
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "task-range");
    assert.equal(res.body.note, "No reported or integrated assignment commit of this task is in the local repository; showing the task range instead");
    assert.deepEqual(res.body.items!.map((item) => item.itemId), ["task"]);
    assert.deepEqual(res.body.items![0]!.files.map((file) => file.path), ["src/kept.ts"]);
    // Malformed records with a base commit: the task range, not the working tree.
    writeFile(root, ".agents/data/tasks/task-a/runtime/assignments.json", "{not json");
    const malformed = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(malformed.body.source, "task-range");
    assert.equal(malformed.body.note, "Assignment records are unreadable; showing the task range instead");
  } finally { await fixture.close(); }
});

test("?ws=ignore diffs with -w for that request only; other values are rejected before git runs", async () => {
  const { taskChanges } = await import("../../src/ui/changes.js");
  const { renderChangesPage } = await import("../../src/ui/views/changes.js");
  const fixture = await startFixture((root) => [makeTask({ baseCommit: git(root, "rev-parse", "HEAD") })]);
  try {
    const { root } = fixture;
    const options = { root, host: "127.0.0.1", port: 0, mode: "local" as const };
    commit(root, "whitespace and code", { "README.md": "#  Fixture  \n", "src/a.ts": "export const hello = 1;\n" });
    const plain = await taskChanges(options, "task-a", null);
    assert.equal(plain.status, 200);
    const plainItem = plain.status === 200 ? plain.payload.items[0]! : undefined;
    assert.deepEqual(plainItem!.files.map((file) => [file.path, file.added, file.removed, file.whitespaceOnly]), [["README.md", 1, 1, undefined], ["src/a.ts", 1, 0, undefined]]);
    assert.match(plainItem!.patch, /^diff --git a\/README\.md b\/README\.md$/m);
    const ignored = await taskChanges(options, "task-a", null, undefined, null, { ws: "ignore" });
    assert.equal(ignored.status, 200);
    const ignoredItem = ignored.status === 200 ? ignored.payload.items[0]! : undefined;
    assert.deepEqual(ignoredItem!.files.map((file) => [file.path, file.added, file.removed, file.whitespaceOnly]), [["README.md", 0, 0, true], ["src/a.ts", 1, 0, undefined]], "whitespace-only files stay listed, paired by path");
    assert.doesNotMatch(ignoredItem!.patch, /README\.md/, "no patch section for a whitespace-only file");
    assert.match(ignoredItem!.patch, /^\+export const hello = 1;$/m);
    for (const ws of ["bogus", "all", "-w", "ignore "]) {
      const rejected = await taskChanges(options, "task-a", null, undefined, null, { ws });
      assert.equal(rejected.status, 400, ws);
      assert.match(rejected.status === 400 ? rejected.payload.error : "", /Invalid ws parameter/);
    }
    assert.equal((await taskChanges(options, "task-a", null, undefined, null, { ws: "" })).status, 200, "an empty value means the default");
    const page = await renderChangesPage(options, "task-a", "task", { ws: "ignore" });
    assert.equal(page.status, 200);
    assert.match(page.html, /<input type="hidden" name="ws" value="ignore">/, "the selector form keeps the whitespace mode");
    assert.match(page.html, /<input type="checkbox" data-changes-ws checked>/);
    assert.match(page.html, /<span class="ad-diff-stat">whitespace<\/span>/);
    assert.match(page.html, /Whitespace-only changes \(hidden while whitespace is ignored\)\./);
    assert.equal((await renderChangesPage(options, "task-a", null, { ws: "bogus" })).status, 400);
  } finally { await fixture.close(); }
});

test("a symlinked assignments directory is refused and the working tree is shown instead", { skip: process.platform === "win32" }, async () => {
  const fixture = await startFixture();
  const outside = mkdtempSync(join(tmpdir(), "aidlc-ui-changes-outside-"));
  try {
    const { root, base } = fixture;
    const head = git(root, "rev-parse", "HEAD");
    writeFileSync(join(outside, "assignments.json"), JSON.stringify({ schemaVersion: 1, taskId: "task-a", assignments: [{ itemId: "item-a", state: "integrated", integrationCommit: head }] }));
    mkdirSync(join(root, ".agents/data/tasks/task-a"), { recursive: true });
    symlinkSync(outside, join(root, ".agents/data/tasks/task-a/runtime"));
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "working-tree");
    assert.match(res.body.note ?? "", /symlink/);
  } finally { await fixture.close(); rmSync(outside, { recursive: true, force: true }); }
});

test("no git repository answers source none with a note, never a 500", async () => {
  const fixture = await startFixture([makeTask()], { repo: false });
  try {
    const res = await getJson(`${fixture.base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "none");
    assert.deepEqual(res.body.items, []);
    assert.match(res.body.note ?? "", /not a git repository|git is not available/);
    assert.equal((await fetch(`${fixture.base}/tasks/task-a/changes`)).status, 200);
  } finally { await fixture.close(); }
});

test("unknown tasks and malformed task or item ids are rejected before git runs", { skip: process.platform === "win32" }, async () => {
  const fixture = await startFixture();
  const trace = traceGit(fixture.root);
  try {
    const { base } = fixture;
    assert.equal((await getJson(`${base}/api/tasks/missing/changes`)).status, 404);
    assert.equal((await fetch(`${base}/tasks/missing/changes`)).status, 404);
    for (const path of [
      "/api/tasks/..%2F/changes",
      "/api/tasks/--output/changes",
      "/api/tasks/%2D%2Doutput%3D%2Ftmp%2Fx/changes",
      "/api/tasks/%E0/changes",
      "/api/tasks/task-a/changes?item=--output%3D%2Ftmp%2Fx",
      "/api/tasks/task-a/changes?item=..%2F..%2Fetc",
      "/tasks/..%2F/changes",
      "/tasks/--output/changes",
      "/tasks/task-a/changes?item=..%2Fx",
    ]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 400, path);
    }
    assert.deepEqual(trace.log(), [], "git is never invoked for a rejected request");
  } finally { trace.restore(); await fixture.close(); }
});

test("malicious SHA values in records are rejected and never passed to git", { skip: process.platform === "win32" }, async () => {
  const fixture = await startFixture();
  const trace = traceGit(fixture.root);
  try {
    const { root, base } = fixture;
    const good = git(root, "rev-parse", "HEAD");
    const pwned = join(root, "pwned");
    writeAssignments(root, "task-a", [
      { itemId: "item-x", state: "reported", commit: `--output=${pwned}`, baseCommit: good },
      { itemId: "item-y", state: "integrated", integrationCommit: "HEAD" },
      { itemId: "item-z", state: "reported", commit: good, baseCommit: "HEAD~1" },
      { itemId: "item-w", state: "integrated", integrationCommit: "--output=/tmp/x", commit: "ABCDEF0" },
    ]);
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items?.map((item) => [item.itemId, item.files.length, /not a valid SHA/.test(item.note ?? "")]), [
      ["item-x", 0, true], ["item-y", 0, true], ["item-z", 0, true], ["item-w", 0, true],
    ]);
    assert.equal(existsSync(pwned), false);
    const calls = trace.log();
    assert.ok(calls.length > 0, "the repository check still ran");
    assert.ok(calls.every((call) => !/--output|HEAD|ABCDEF0/.test(call)), `git argv never carries a record value: ${calls.join(" | ")}`);
  } finally { trace.restore(); await fixture.close(); }
});

test("an item is truncated beyond 300 files or 1 MiB of patch, cutting the patch at a file boundary", async () => {
  const fixture = await startFixture();
  try {
    const { root, base } = fixture;
    const start = git(root, "rev-parse", "HEAD");
    const many = commit(root, "many", Object.fromEntries(Array.from({ length: 301 }, (_, index) => [`many/f${String(index).padStart(3, "0")}.txt`, `${index}\n`])));
    const big = commit(root, "big", { "big/a-small.txt": "small\n", "big/b-large.txt": Array.from({ length: 120000 }, (_, index) => `line ${index} ${"x".repeat(4)}`).join("\n") });
    writeAssignments(root, "task-a", [
      { itemId: "item-many", state: "reported", commit: many, baseCommit: start },
      { itemId: "item-big", state: "integrated", integrationCommit: big },
    ]);
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    const [manyItem, bigItem] = res.body.items!;
    assert.equal(manyItem!.truncated, true);
    assert.equal(manyItem!.files.length, 300);
    assert.equal(manyItem!.patch, "");
    assert.equal(bigItem!.truncated, true);
    assert.equal(bigItem!.files.length, 2, "every file is still listed");
    assert.ok(Buffer.byteLength(bigItem!.patch) <= 1024 * 1024);
    assert.match(bigItem!.patch, /^\+small$/m, "the first file section is kept");
    assert.doesNotMatch(bigItem!.patch, /b-large\.txt/, "the patch is cut before the section that overflowed");
    const html = await (await fetch(`${base}/tasks/task-a/changes`)).text();
    assert.match(html, /data-changes-truncated/);
    assert.match(html, /Diff not shown: the patch exceeds the display limit\./);
  } finally { await fixture.close(); }
});

test("diff lines and file names are HTML-escaped", { skip: process.platform === "win32" }, async () => {
  const fixture = await startFixture();
  try {
    const { root, base } = fixture;
    const start = git(root, "rev-parse", "HEAD");
    const evil = commit(root, "evil", { "src/<img src=x onerror=alert(1)>.txt": '<script>alert("x")</script>\n' });
    writeAssignments(root, "task-a", [{ itemId: "item-a", state: "reported", commit: evil, baseCommit: start }]);
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.body.items?.[0]?.files[0]?.path, "src/<img src=x onerror=alert(1)>.txt", "JSON carries the raw path (core.quotepath=off)");
    const html = await (await fetch(`${base}/tasks/task-a/changes`)).text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /\+&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.match(html, /src\/&lt;img src=x onerror=alert\(1\)&gt;\.txt/);
  } finally { await fixture.close(); }
});

test("changes routes reject a foreign Host header and are linked from the task page and side panel", async () => {
  const fixture = await startFixture();
  try {
    const port = new URL(fixture.base).port;
    assert.equal(await rawRequest(fixture.base, "/tasks/task-a/changes", { Host: "evil.example" }), 403);
    assert.equal(await rawRequest(fixture.base, "/api/tasks/task-a/changes", { Host: "evil.example" }), 403);
    assert.equal(await rawRequest(fixture.base, "/api/tasks/task-a/changes", { Host: `127.0.0.1:${port}` }), 200);
    const detail = await (await fetch(`${fixture.base}/tasks/task-a`)).text();
    assert.match(detail, /href="\/tasks\/task-a\/changes" data-changes-link="items"/);
    const fragment = await (await fetch(`${fixture.base}/partial/tasks/task-a`)).text();
    assert.match(fragment, /href="\/tasks\/task-a\/changes"/);
  } finally { await fixture.close(); }
});

interface FleetFixture { base: string; root: string; close: () => Promise<void> }

/** Fleet-mode server: `loop-entry.mjs` is stubbed to return the given task and gate snapshot. */
const startFleet = async (build: (root: string) => { task: TaskState; integrationCommit: string | null }): Promise<FleetFixture> => {
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-changes-fleet-"));
  git(root, "init", "-q");
  commit(root, "base", { ".gitignore": ".agents/\n", "README.md": "# Fleet\n" });
  const { task, integrationCommit } = build(root);
  mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
  writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ loop: { mode: "fleet" } }));
  writeFileSync(join(root, ".agents/aidlc/scripts/loop-entry.mjs"), `const [action] = process.argv.slice(2);
if (action === "tasks") console.log(JSON.stringify({ ok: true, tasks: ${JSON.stringify([task])} }));
else if (action === "gate") console.log(JSON.stringify({ ok: true, gate: "G2_codereview", status: "blocked_on_user", snapshot: { id: "snap-1", reviewText: "## Review", integrationCommit: ${JSON.stringify(integrationCommit)} } }));
else { console.error("unexpected " + action); process.exit(1); }
`);
  const { server, port } = await startUiServer({ root, host: "127.0.0.1", port: 0 });
  const close = (): Promise<void> => new Promise<void>((done) => { server.close(() => { rmSync(root, { recursive: true, force: true }); done(); }); });
  return { base: `http://127.0.0.1:${port}`, root, close };
};

test("fleet mode diffs the gate snapshot's integration commit and links it from the code review gate", { skip: process.platform === "win32" }, async () => {
  let integration = "";
  const fixture = await startFleet((root) => {
    integration = commit(root, "integrated", { "src/fleet.ts": "export const fleet = true;\n" });
    return { task: makeTask({ id: "fleet-a", title: "Fleet task", status: "blocked_on_user", gate: "G2_codereview", baseCommit: git(root, "rev-parse", "HEAD~1") }), integrationCommit: integration };
  });
  const { base } = fixture;
  try {
    const res = await getJson(`${base}/api/tasks/fleet-a/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "fleet", "the snapshot wins over the task range");
    const [item] = res.body.items!;
    assert.equal(item!.itemId, "integration");
    assert.equal(item!.commit, integration);
    assert.deepEqual(item!.files.map((file) => file.path), ["src/fleet.ts"]);
    assert.equal((await getJson(`${base}/api/tasks/fleet-a/changes?item=integration`)).status, 200);
    assert.equal((await getJson(`${base}/api/tasks/fleet-a/changes?item=item-a`)).status, 404);
    const detail = await (await fetch(`${base}/tasks/fleet-a`)).text();
    assert.match(detail, /data-changes-link="gate"/, "the G2 review snapshot panel links the changes");
    const page = await (await fetch(`${base}/tasks/fleet-a/changes`)).text();
    assert.match(page, /Integration commit/);
    assert.match(page, /\+export const fleet = true;/);
  } finally { await fixture.close(); }
});

test("fleet mode without an integration commit shows the task range when the task has a base commit", { skip: process.platform === "win32" }, async () => {
  let start = "";
  const fixture = await startFleet((root) => {
    start = git(root, "rev-parse", "HEAD");
    commit(root, "lead work", { "src/lead.ts": "export const lead = true;\n" });
    return { task: makeTask({ id: "fleet-b", title: "Fleet task", baseCommit: start }), integrationCommit: null };
  });
  try {
    const res = await getJson(`${fixture.base}/api/tasks/fleet-b/changes`);
    assert.equal(res.status, 200);
    assert.equal(res.body.source, "task-range");
    assert.equal(res.body.note, "No integration commit in the current review snapshot yet (it is recorded at the code review gate); showing the task range instead");
    const [item] = res.body.items!;
    assert.equal(item!.itemId, "task");
    assert.equal(item!.base, start);
    assert.deepEqual(item!.files.map((file) => file.path), ["src/lead.ts"]);
    assert.equal((await getJson(`${fixture.base}/api/tasks/fleet-b/changes?item=integration`)).status, 404);
  } finally { await fixture.close(); }
});

test("fleet mode keeps the snapshot note for tasks without a base commit and ignores an invalid one", { skip: process.platform === "win32" }, async () => {
  const plain = await startFleet(() => ({ task: makeTask({ id: "fleet-c" }), integrationCommit: null }));
  try {
    const res = await getJson(`${plain.base}/api/tasks/fleet-c/changes`);
    assert.equal(res.body.source, "fleet");
    assert.deepEqual(res.body.items, []);
    assert.match(res.body.note ?? "", /^No integration commit in the current review snapshot yet/);
  } finally { await plain.close(); }
  // Fleet task records are not validated locally: a malformed base commit never reaches git.
  const invalid = await startFleet(() => ({ task: makeTask({ id: "fleet-d", baseCommit: "--output=/tmp/x" }), integrationCommit: null }));
  try {
    const res = await getJson(`${invalid.base}/api/tasks/fleet-d/changes`);
    assert.equal(res.body.source, "working-tree");
    assert.equal(res.body.note, "No integration commit in the current review snapshot yet (it is recorded at the code review gate); recorded base commit is not a valid SHA; showing the working tree instead");
    assert.equal(existsSync("/tmp/x"), false);
  } finally { await invalid.close(); }
});

test("the whole-task view caps the total patch and always keeps the focused item", async () => {
  const { capTaskPatch, MAX_TASK_PATCH_BYTES } = await import("../../src/ui/changes.js");
  const item = (itemId: string, bytes: number) => ({ itemId, commit: "a".repeat(40), files: [{ path: `${itemId}.txt`, status: "modified", added: 1, removed: 0, binary: false }], patch: "x".repeat(bytes), truncated: false });
  const mib = 1024 * 1024;
  assert.equal(MAX_TASK_PATCH_BYTES, 4 * mib);
  const items = ["i1", "i2", "i3", "i4", "i5", "i6"].map((id) => item(id, mib - 10));
  const whole = capTaskPatch(items, null);
  assert.deepEqual(whole.map((entry) => Boolean(entry.patchOmitted)), [false, false, false, false, true, true]);
  assert.ok(whole.reduce((sum, entry) => sum + entry.patch.length, 0) <= MAX_TASK_PATCH_BYTES);
  for (const entry of whole.filter((candidate) => candidate.patchOmitted)) {
    assert.equal(entry.patch, ""); assert.equal(entry.files.length, 1); assert.equal(entry.note, undefined, "the omission is its own banner, not a note");
  }
  const focused = capTaskPatch(items, "i6");
  assert.equal(focused.find((entry) => entry.itemId === "i6")!.patchOmitted, undefined, "the focused item keeps its patch");
  assert.equal(focused.filter((entry) => entry.patchOmitted).length, 2);
  assert.equal(focused[0]!.itemId, "i1", "item order is preserved");
});

test("a recorded integration commit missing locally falls back to the worker commit", async () => {
  const fixture = await startFixture();
  try {
    const { root, base } = fixture;
    const start = git(root, "rev-parse", "HEAD");
    const worker = commit(root, "worker", { "src/a.txt": "worker\n" });
    writeAssignments(root, "task-a", [{ itemId: "item-a", state: "integrated", integrationCommit: "f".repeat(40), commit: worker, baseCommit: start }]);
    const res = await getJson(`${base}/api/tasks/task-a/changes`);
    assert.equal(res.status, 200);
    const [entry] = res.body.items!;
    assert.equal(entry!.commit, worker);
    assert.deepEqual(entry!.files.map((file) => file.path), ["src/a.txt"]);
    assert.match(entry!.note ?? "", /integration commit is not in the local repository; showing the worker commit/);
  } finally { await fixture.close(); }
});

test("the HTTP routes pass ?ws= through: ignore flags whitespace-only files, other values are 400", async () => {
  const fixture = await startFixture((root) => [makeTask({ baseCommit: git(root, "rev-parse", "HEAD") })]);
  try {
    commit(fixture.root, "whitespace and code", { "README.md": "#  Fixture  \n", "src/a.ts": "export const hello = 1;\n" });
    const ignored = await getJson(`${fixture.base}/api/tasks/task-a/changes?ws=ignore`);
    assert.equal(ignored.status, 200);
    assert.equal(ignored.body.items?.[0]?.files.find((file) => file.path === "README.md")?.whitespaceOnly, true);
    assert.equal((await getJson(`${fixture.base}/api/tasks/task-a/changes?ws=bogus`)).status, 400);
    assert.equal((await fetch(`${fixture.base}/tasks/task-a/changes?ws=bogus`)).status, 400);
    const page = await (await fetch(`${fixture.base}/tasks/task-a/changes?ws=ignore`)).text();
    assert.ok(page.includes("data-changes-ws checked"), "the page keeps the ws selection");
  } finally { await fixture.close(); }
});
