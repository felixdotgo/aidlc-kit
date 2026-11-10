import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-intake.mjs"));
const loadStore = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/store.mjs"));

test("intake retries match the original requirement and authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-intake-"));
  const { prepareLoopIntake } = await load();
  const tasks = new Map<string, { id: string; title: string }>();
  let creates = 0;
  const options = { root, taskId: "login", requirement: "Add login\nUsing email", authority: "local",
    readTask: async (id: string) => tasks.get(id),
    createTask: async ({ taskId, title }: { taskId: string; title: string }) => { creates++; tasks.set(taskId, { id: taskId, title }); } };
  try {
    await prepareLoopIntake(options);
    await prepareLoopIntake(options);
    assert.equal(creates, 1);
    await assert.rejects(() => prepareLoopIntake({ ...options, authority: "fleet" }), /different authority/);
    await assert.rejects(() => prepareLoopIntake({ ...options, requirement: "Other" }), /different authority or requirement/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intake refuses to take over an unrelated task", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-intake-"));
  const { prepareLoopIntake } = await load();
  try {
    await assert.rejects(() => prepareLoopIntake({ root, taskId: "login", requirement: "Add login", authority: "local", readTask: async () => ({ id: "login", title: "Add login" }), createTask: async () => {} }), /no matching loop intake/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intake derives a descriptive title and honors an explicit override", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-intake-"));
  const { prepareLoopIntake } = await load();
  const tasks = new Map<string, { id: string; title: string }>();
  const base = { root, requirement: "Add login\nUsing email", authority: "local", readTask: async (id: string) => tasks.get(id), createTask: async ({ taskId, title }: { taskId: string; title: string }) => { tasks.set(taskId, { id: taskId, title }); } };
  try {
    await prepareLoopIntake({ ...base, taskId: "add-login" });
    assert.deepEqual([...tasks.values()], [{ id: "add-login", title: "Add login" }]);
    await prepareLoopIntake({ ...base, taskId: "add-login-2", title: "Custom title" });
    assert.deepEqual([...tasks.values()], [{ id: "add-login", title: "Add login" }, { id: "add-login-2", title: "Custom title" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normalizeTitle strips markdown markers, keeps one line, and cuts at a word boundary within 100 characters", async () => {
  const { normalizeTitle } = await loadStore();
  assert.equal(normalizeTitle("# Fix login"), "Fix login");
  assert.equal(normalizeTitle("## Fix login\nsecond line ignored"), "Fix login");
  assert.equal(normalizeTitle("- Bullet item"), "Bullet item");
  assert.equal(normalizeTitle("* Star item"), "Star item");
  assert.equal(normalizeTitle("1. Numbered"), "Numbered");
  assert.equal(normalizeTitle("1) Parenthesized"), "Parenthesized");
  assert.equal(normalizeTitle("> Quote"), "Quote");
  assert.equal(normalizeTitle("**bold** and `code`"), "bold and code");
  assert.equal(normalizeTitle(""), "Loop task");
  assert.equal(normalizeTitle("   \n  "), "Loop task");
  assert.equal(normalizeTitle("***"), "Loop task", "marker residue (horizontal rule) falls back");
  assert.equal(normalizeTitle("___"), "Loop task", "underscore residue falls back");
  assert.equal(normalizeTitle("- - -"), "Loop task", "hyphen/space residue falls back");
  assert.equal(normalizeTitle("2 * 3 fix"), "2 * 3 fix", "a lone asterisk inside words stays");
  assert.equal(normalizeTitle("__init__ crash"), "__init__ crash", "underscores in identifiers stay");
  assert.equal(normalizeTitle("a".repeat(200)), "a".repeat(100), "no space: cut exactly at the limit");
  const words = "word ".repeat(30).slice(0, -1); // 149 chars, spaces every 5
  const cut = normalizeTitle(words);
  assert.ok(cut.length <= 100, `cut length ${cut.length}`);
  assert.ok(cut.endsWith("word"), "cut at the last word boundary");
  assert.equal(normalizeTitle("short title", 5), "short", "the limit is configurable");
});

test("derived ids are capped at 48 characters with a loop-task fallback", async () => {
  const { deriveTaskIdentity } = await load();
  assert.equal(deriveTaskIdentity("# Fix login").slug, "fix-login", "markdown markers do not leak into the id");
  const long = deriveTaskIdentity(`Fix ${"component ".repeat(20)}thoroughly`);
  assert.ok(long.slug.length <= 48, `slug length ${long.slug.length}`);
  assert.match(long.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(long.title.length <= 100);
  assert.deepEqual(deriveTaskIdentity("***"), { slug: "loop-task", title: "Loop task" });
  assert.deepEqual(deriveTaskIdentity(""), { slug: "loop-task", title: "Loop task" });
});

test("deriveTaskIdentity keeps lowercase kebab ids with the existing title wording", async () => {
  const { deriveTaskIdentity } = await load();
  assert.deepEqual(deriveTaskIdentity("Fix the login bug!"), { slug: "fix-the-login-bug", title: "Fix the login bug!" });
  assert.deepEqual(deriveTaskIdentity("2FA login"), { slug: "2fa-login", title: "2FA login" });
  assert.deepEqual(deriveTaskIdentity("Hello, 世界!"), { slug: "hello", title: "Hello, 世界!" });
  assert.equal(deriveTaskIdentity("- `loop up` command").title, "loop up command");
  assert.equal(deriveTaskIdentity("__init__ crash").title, "__init__ crash");
});
