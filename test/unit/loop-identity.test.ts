import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-intake.mjs"));

test("deriveTaskIdentity turns a first line into a slug and title", async () => {
  const { deriveTaskIdentity } = await load();
  assert.deepEqual(deriveTaskIdentity("Add login\nUsing email"), { slug: "add-login", title: "Add login" });
  assert.deepEqual(deriveTaskIdentity("Fix the login bug!"), { slug: "fix-the-login-bug", title: "Fix the login bug!" });
  assert.deepEqual(deriveTaskIdentity("  \nRefactor state store  \nnext"), { slug: "refactor-state-store", title: "Refactor state store" });
  assert.deepEqual(deriveTaskIdentity("2FA login"), { slug: "2fa-login", title: "2FA login" });
});

test("deriveTaskIdentity falls back for empty or whitespace-only input", async () => {
  const { deriveTaskIdentity } = await load();
  assert.deepEqual(deriveTaskIdentity(""), { slug: "loop-task", title: "Loop task" });
  assert.deepEqual(deriveTaskIdentity("   \n   \n"), { slug: "loop-task", title: "Loop task" });
  assert.deepEqual(deriveTaskIdentity(undefined), { slug: "loop-task", title: "Loop task" });
});

test("deriveTaskIdentity strips non-ascii and truncates to id/title bounds", async () => {
  const { deriveTaskIdentity } = await load();
  assert.deepEqual(deriveTaskIdentity("Hello, 世界!"), { slug: "hello", title: "Hello, 世界!" });
  const long = "x".repeat(300);
  assert.deepEqual(deriveTaskIdentity(long), { slug: "x".repeat(127), title: "x".repeat(256) });
});

test("deriveTaskIdentity strips Markdown markers from the editor's first line", async () => {
  const { deriveTaskIdentity } = await load();
  assert.deepEqual(deriveTaskIdentity("# Fix **login** retry\n\nDetails"), { slug: "fix-login-retry", title: "Fix login retry" });
  assert.equal(deriveTaskIdentity("- `loop up` command").title, "loop up command");
  assert.equal(deriveTaskIdentity("#\n").title, "Loop task");
  assert.equal(deriveTaskIdentity("__init__ crash").title, "__init__ crash");
});
