import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-commit-message.mjs"));

test("extractCommitMessage returns a valid worker-authored message", async () => {
  const { extractCommitMessage } = await load();
  const text = "Done\nAI-DLC-COMMIT: docs(ui): add web UI improvement proposal\nAI-DLC-ITEM-COMPLETE\n";
  assert.equal(extractCommitMessage(text, { itemId: "create-proposal-doc", ownedPaths: ["docs/a.md"] }), "docs(ui): add web UI improvement proposal");
});

test("extractCommitMessage accepts breaking-change and bare-type forms", async () => {
  const { extractCommitMessage } = await load();
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: feat!: drop legacy API\n", {}), "feat!: drop legacy API");
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: chore: bump\n", {}), "chore: bump");
});

test("extractCommitMessage rejects malformed or unknown-type messages", async () => {
  const { extractCommitMessage } = await load();
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: NOTATYPE: x\n", { itemId: "t1", ownedPaths: ["a.txt"] }), "chore: t1");
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: feat\n", { itemId: "t1", ownedPaths: ["a.txt"] }), "chore: t1");
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: feat:\n", { itemId: "t1", ownedPaths: ["a.txt"] }), "chore: t1");
  assert.equal(extractCommitMessage("AI-DLC-COMMIT: feat: a\u0000b\n", { itemId: "t1", ownedPaths: ["a.txt"] }), "chore: t1");
});

test("extractCommitMessage falls back to a conventional subject without a message", async () => {
  const { extractCommitMessage } = await load();
  assert.equal(extractCommitMessage(undefined, { itemId: "add-login", ownedPaths: ["a.txt"] }), "chore: add-login");
  assert.equal(extractCommitMessage("", { itemId: "add-login", ownedPaths: ["a.txt"] }), "chore: add-login");
});

test("extractCommitMessage derives a single top-level scope, omitting ambiguous ones", async () => {
  const { extractCommitMessage } = await load();
  assert.equal(extractCommitMessage(undefined, { itemId: "t1", ownedPaths: ["docs/a.md"] }), "chore(docs): t1");
  assert.equal(extractCommitMessage(undefined, { itemId: "t1", ownedPaths: ["src/state/a.ts", "src/state/b.ts"] }), "chore(src): t1");
  assert.equal(extractCommitMessage(undefined, { itemId: "t1", ownedPaths: ["src/a.ts", "docs/b.md"] }), "chore: t1");
  assert.equal(extractCommitMessage(undefined, { itemId: "t1", ownedPaths: ["a.txt", "b.txt"] }), "chore: t1");
});
