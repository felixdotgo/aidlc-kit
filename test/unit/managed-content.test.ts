import assert from "node:assert/strict";
import test from "node:test";
import { adapters } from "../../src/adapters.js";
import { managedBlock, mergeManagedBlock } from "../../src/managed-content.js";

const spec = { path: "AGENTS.md", owner: "aidlc-codex", strategy: "managed-block" as const, content: "<!-- aidlc-installer:aidlc-codex:start -->\nnew instruction\n<!-- aidlc-installer:aidlc-codex:end -->\n", ownershipClass: "managed" as const };

test("managed-block helpers append, replace, and locate only the owned block", () => {
  assert.equal(mergeManagedBlock(spec, ""), spec.content);
  const current = "user preface\n\n<!-- aidlc-installer:aidlc-codex:start -->\nold instruction\n<!-- aidlc-installer:aidlc-codex:end -->\n\nuser suffix\n\n<!-- aidlc-installer:aidlc-codex:start -->\nduplicate\n<!-- aidlc-installer:aidlc-codex:end -->\n";
  const merged = mergeManagedBlock(spec, current);
  assert.match(merged, /user preface/); assert.match(merged, /user suffix/); assert.match(merged, /new instruction/);
  assert.equal([...merged.matchAll(/aidlc-installer:aidlc-codex:start/g)].length, 1);
  assert.equal(managedBlock(spec, merged), spec.content.trimEnd());
});

test("managed-block lookup returns the complete content for replace strategies", () => {
  assert.equal(managedBlock({ owner: "aidlc-core", strategy: "replace" }, "plain content"), "plain content");
});

test("owner-scoped blocks keep Codex and OpenCode independent in one AGENTS.md", () => {
  const block = (id: string) => adapters.find((adapter) => adapter.id === id)!.files().find((file) => file.path === "AGENTS.md")!;
  const codex = block("codex");
  const opencode = block("opencode");
  const both = mergeManagedBlock(codex, mergeManagedBlock(opencode, ""));
  const merged = mergeManagedBlock(codex, both);
  assert.match(merged, /# AI-DLC for Codex/);
  assert.match(merged, /# AI-DLC for OpenCode/);
  for (const owner of ["codex", "opencode"]) assert.equal([...merged.matchAll(new RegExp(`aidlc-installer:${owner}:start`, "g"))].length, 1);
  assert.equal(managedBlock(codex, merged), codex.content.trimEnd());
  assert.equal(managedBlock(opencode, merged), opencode.content.trimEnd());
  assert.equal(mergeManagedBlock(codex, merged), merged);
});
