import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("src/cli.ts"), "utf8");

test("CLI loads Inquirer checkbox prompts only for interactive terminals while retaining non-interactive flag guidance", () => {
  assert.match(source, /const prompts = async \(\) => import\("@inquirer\/prompts"\)/);
  assert.match(source, /message: "Select one or more agents"/);
  assert.match(source, /required: true/);
  assert.match(source, /Use --agent <name> or --all/);
  assert.match(source, /◆ \$\{operation\} preview/);
});

test("CLI preserves the human-only upgrade boundary", () => {
  assert.match(source, /upgrade does not support --yes or --force/);
  assert.match(source, /Upgrade apply requires an interactive TTY/);
  assert.match(source, /Type \$\{expected\} to apply this user-initiated upgrade/);
});

test("loop facade fails closed before creating a task or reading a requirement when isolated dispatcher is unavailable", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { planInit, applyPlan } = await import("../../src/installer.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-loop-cli-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false, loop: { mode: "local", agents: { lead: "codex", workers: { a: "codex" } } } }));
    const cli = resolve("dist/src/cli.js");
    const result = spawnSync(process.execPath, [cli, "loop", "start", "--root", root, "--task-id", "example"], { input: "sensitive requirement", encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dispatcher is not integrated/);
    assert.doesNotMatch(result.stderr + result.stdout, /sensitive requirement/);
    assert.equal(existsSync(join(root, ".agents/data/tasks/example")), false);
    const fleet = spawnSync(process.execPath, [cli, "loop", "start", "--root", root, "--mode", "fleet"], { input: "", encoding: "utf8" });
    assert.notEqual(fleet.status, 0);
    assert.match(fleet.stderr, /does not match configured authority/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI --version prints packageVersion and exits 0", async () => {
  const { packageVersion } = await import("../../src/workflow.js");
  const cli = resolve("dist/src/cli.js");
  const result = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageVersion());
  const result2 = spawnSync(process.execPath, [cli, "version"], { encoding: "utf8" });
  assert.equal(result2.status, 0);
  assert.equal(result2.stdout.trim(), packageVersion());
});

test("CLI rejects a missing value for a value flag", () => {
  const cli = resolve("dist/src/cli.js");
  const result = spawnSync(process.execPath, [cli, "init", "--agent"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /requires a value/);
});

test("CLI rejects an unknown option", () => {
  const cli = resolve("dist/src/cli.js");
  const result = spawnSync(process.execPath, [cli, "status", "--foo"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Unknown option/);
});

test("CLI status --json emits parseable JSON with the expected fields", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "aidlc-status-json-"));
  try {
    const cli = resolve("dist/src/cli.js");
    const result = spawnSync(process.execPath, [cli, "status", root, "--json"], { encoding: "utf8" });
    assert.equal(result.status, 0);
    const data = JSON.parse(result.stdout);
    assert.equal(typeof data.workflow, "string");
    assert.equal(typeof data.installedVersion, "string");
    assert.equal(typeof data.schema, "string");
    assert.ok(Array.isArray(data.detectedAgents));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI doctor --json emits parseable JSON with level, message, and strict", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "aidlc-doctor-json-"));
  try {
    const cli = resolve("dist/src/cli.js");
    const result = spawnSync(process.execPath, [cli, "doctor", root, "--json"], { encoding: "utf8" });
    const data = JSON.parse(result.stdout);
    assert.ok(["ok", "warn", "error"].includes(data.level));
    assert.equal(typeof data.message, "string");
    assert.equal(typeof data.strict, "boolean");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
