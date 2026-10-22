import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileContext } from "../../src/context.js";
import type { TaskState } from "../../src/model.js";
import { defaultConfig, includedRuleFiles, loadProjectConfig, resolveEffectiveConfig, resolveProfiles, validateProfile } from "../../src/profiles.js";

const task: TaskState = {
  id: "ctx", title: "Context", type: "infra", phase: "build", gate: "G2_codereview", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—",
  artifacts: {}, decisions: [{ id: "D", label: "Keep invariant", status: "approved" }], tasks: [], evidence: [], createdAt: "x", updatedAt: "x"
};

test("default configuration exposes no gate auto-pass surface", () => {
  assert.equal("gates" in defaultConfig(), false);
});

test("config and profiles are dependency-free, composable, and traversal-safe", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-profile-"));
  try {
    mkdirSync(join(root, ".agents/project/profiles/local/rules"), { recursive: true });
    writeFileSync(join(root, ".agents/project/profiles/local/profile.json"), JSON.stringify({ schemaVersion: 1, id: "local", extends: ["topology/single"], topology: "single", rules: { include: [".agents/project/rules/*.md"] } }));
    mkdirSync(join(root, ".agents/project/rules"), { recursive: true });
    writeFileSync(join(root, ".agents/project/rules/a.md"), "# A\n");
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ ...defaultConfig(), extends: ["local"], rules: { include: [".agents/project/rules/*.md"] } }));
    assert.deepEqual(resolveProfiles(root, loadProjectConfig(root).extends).map((item) => item.id), ["topology/single", "local"]);
    assert.equal(includedRuleFiles(root, [".agents/project/rules/*.md"]).length, 1);
    const outside = mkdtempSync(join(tmpdir(), "aidlc-outside-"));
    try {
      writeFileSync(join(outside, "escape.md"), "secret");
      symlinkSync(join(outside, "escape.md"), join(root, ".agents/project/rules/escape.md"));
      assert.equal(includedRuleFiles(root, [".agents/project/rules/*.md"]).length, 1);
    } finally { rmSync(outside, { recursive: true, force: true }); }
    assert.throws(() => validateProfile({ schemaVersion: 1, id: "bad", topology: "single", specs: { roots: ["../secret"] } }), /inside the project/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Backlog tracker is opt-in and rejects incomplete or secret-bearing config", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-tracker-config-"));
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ ...defaultConfig(), schemaVersion: 3 }));
    assert.equal(loadProjectConfig(root).tracker, undefined);
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ ...defaultConfig(), schemaVersion: 3, tracker: { enabled: true, provider: "backlog", spaceUrl: "https://team.backlog.com", project: "TEAM", tokenEnv: "BACKLOG_TOKEN", workflow: "scrum", mapping: { gateFieldId: 12 } } }));
    assert.deepEqual(loadProjectConfig(root).tracker?.mapping, { gateFieldId: 12 });
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ ...defaultConfig(), schemaVersion: 3, tracker: { enabled: true, provider: "backlog", spaceUrl: "https://team.backlog.com", project: "TEAM", token: "secret", workflow: "scrum" } }));
    assert.throws(() => loadProjectConfig(root), /complete enabled Backlog/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context packet includes canonical decisions and honors the configured budget", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-context-"));
  try {
    const config = defaultConfig(); config.context.maxChars = 8_000;
    const packet = compileContext(root, config, task, "build");
    assert.ok(packet.chars <= 8_000);
    assert.match(packet.content, /Keep invariant/);
    assert.match(packet.content, /COSTARS build emphasis/);
    assert.match(packet.content, /CRITICS section/);
    assert.match(packet.content, /Next action \/ stop contract/);
    assert.match(packet.content, /workflow installation and upgrades remain human-only/);
    assert.match(packet.content, /after the user explicitly approves the result at the Review implementation step/);
    assert.match(packet.content, /batch of independent canonical items/i);
    assert.match(packet.content, /before marking items or recording any lifecycle evidence\/state mutation/i);
    assert.match(packet.content, /final\/current authoritative `nextAction`/);
    assert.match(packet.content, /"status": "active"/);
    assert.ok(packet.estimatedTokens > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("focused build context keeps the remaining item loop visible", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-context-item-"));
  try {
    const config = defaultConfig(); config.context.maxChars = 8_000;
    const multiItem: TaskState = { ...task, tasks: [
      { id: "T1", label: "Current", status: "in_progress" },
      { id: "T2", label: "Next", status: "todo" },
      { id: "T3", label: "Finished", status: "done" }
    ] };
    const packet = compileContext(root, config, multiItem, "build", { itemId: "T1" });
    assert.match(packet.content, /actionable items are T1, T2/);
    assert.match(packet.content, /Item completion is progress for commentary, never a final response/);
    assert.match(packet.content, /--item T1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context packet preserves durable handoff and structured next actions", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-context-handoff-"));
  try {
    const config = defaultConfig(); config.context.maxChars = 8_000;
    const blocked: TaskState = { ...task, status: "paused", handoff: { kind: "release_failed", reason: "provider evidence failed", source: "review", recordedAt: "2026-01-01T00:00:00.000Z" } };
    const packet = compileContext(root, config, blocked, "build");
    assert.match(packet.content, /release_failed/); assert.match(packet.content, /provider evidence failed/); assert.match(packet.content, /reopen_g1/); assert.doesNotMatch(packet.content, /gate approve ctx/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context packet retains only lifecycle-relevant evidence and omits verbose historical detail", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-context-compact-"));
  try {
    const config = defaultConfig(); config.context.maxChars = 8_000;
    const historical: TaskState = {
      ...task,
      evidence: [
        { kind: "approval", gate: "G1_review", result: "pass", source: "old approval", detail: "old detail must not appear", recordedAt: "2026-01-01T00:00:00.000Z" },
        { kind: "approval", gate: "G1_review", result: "fail", source: "reopened G1", detail: "new detail must not appear", recordedAt: "2026-01-02T00:00:00.000Z" },
        { kind: "test", area: "root", result: "pass", source: "current test", detail: "x".repeat(20_000), recordedAt: "2026-01-03T00:00:00.000Z" }
      ]
    };
    const packet = compileContext(root, config, historical, "build");
    assert.match(packet.content, /reopened G1/); assert.match(packet.content, /current test/);
    assert.doesNotMatch(packet.content, /old approval|old detail must not appear|new detail must not appear/);
    assert.doesNotMatch(packet.content, /x{100}/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("context compiler refuses to truncate canonical decisions and invariants", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-context-large-"));
  try {
    const config = defaultConfig(); config.context.maxChars = 4_000;
    const oversized = { ...task, decisions: Array.from({ length: 80 }, (_, index) => ({ id: `D${index}`, label: "x".repeat(100), status: "approved" as const })) };
    assert.throws(() => compileContext(root, config, oversized, "build"), /too small/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("effective config merges parent then child then project with stable arrays and last commands winning", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-effective-"));
  try {
    mkdirSync(join(root, ".agents/project/profiles/base"), { recursive: true });
    mkdirSync(join(root, ".agents/project/profiles/child"), { recursive: true });
    writeFileSync(join(root, ".agents/project/profiles/base/profile.json"), JSON.stringify({ schemaVersion: 1, id: "base", topology: "company/base", specs: { roots: ["specs/base"] }, commands: { test: { command: "base-test", args: [] } }, rules: { include: [".agents/project/rules/base.md"] } }));
    writeFileSync(join(root, ".agents/project/profiles/child/profile.json"), JSON.stringify({ schemaVersion: 1, id: "child", extends: ["base"], topology: "company/monorepo", specs: { roots: ["specs/base", "specs/child"] }, commands: { test: { command: "child-test", args: ["--fast"] }, lint: { command: "child-lint", args: [] } } }));
    const config = defaultConfig(); config.extends = ["child"]; config.specs.roots = ["specs/project", "specs/base"]; config.commands.test = { command: "project-test", args: ["--ci"] };
    const effective = resolveEffectiveConfig(root, config);
    assert.deepEqual(effective.profiles.map((item) => item.id), ["base", "child"]);
    assert.deepEqual(effective.specs.roots, ["specs/base", "specs/child", "specs/project"]);
    assert.deepEqual(effective.commands.test, { command: "project-test", args: ["--ci"] });
    assert.deepEqual(effective.commands.lint, { command: "child-lint", args: [] });
    assert.equal(effective.profiles.at(-1)?.topology, "company/monorepo");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
