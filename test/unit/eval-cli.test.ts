import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findAdapter } from "../../src/adapters.js";

const cli = resolve("dist/dev/evaluator/cli.js");

test("repository evaluator CLI reads development config and writes non-overwriting evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-dev-eval-cli-"));
  try {
    const runner = join(root, "runner.mjs"); const config = join(root, "config.json");
    writeFileSync(runner, 'process.stdin.once("data", () => process.stdout.write(JSON.stringify({ transport: "completed", transcript: "ok", events: [] })));\n');
    writeFileSync(config, JSON.stringify({ runners: { fixture: { command: "node", args: [runner], adapter: "codex", model: "fixture", version: "local", protocolVersion: 2, evidenceKind: "simulated" } }, suites: {}, policy: {} }));
    const listed = spawnSync(process.execPath, [cli, "list", "--config", config], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr); assert.deepEqual(JSON.parse(listed.stdout).runners, ["fixture"]);
    const output = ".agents/data/evaluation/fixture.json";
    const run = spawnSync(process.execPath, [cli, "run", "--config", config, "--runner", "fixture", "--scenario", "clarify-read-only", "--output", output, "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const rerun = spawnSync(process.execPath, [cli, "run", "--config", config, "--runner", "fixture", "--scenario", "clarify-read-only", "--output", output, "--root", root], { encoding: "utf8" });
    assert.equal(rerun.status, 1); assert.match(rerun.stderr, /Refusing to overwrite/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository release policy names only adapters with a pinned real runner", () => {
  type Runner = { command: string; args: string[]; adapter: string; protocolVersion: number; evidenceKind: string };
  const config = JSON.parse(readFileSync(resolve("dev/evaluator/config.json"), "utf8")) as { runners: Record<string, Runner> };
  const runner = config.runners["opencode-beam"]!;
  assert.equal(runner.command, "node");
  assert.deepEqual(runner.args, ["./dist/dev/evaluator/runners/opencode.js"]);
  assert.equal(runner.adapter, "opencode");
  assert.equal(runner.protocolVersion, 2);
  assert.equal(runner.evidenceKind, "real");
  assert.equal(config.runners["codex-luna"]!.adapter, "codex");
  assert.equal(config.runners["claude-sonnet"]!.adapter, "claude");
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts["release:check"]!;
  assert.match(script, /release-check\.js \.agents\/project\/release-eval\.json /);
  assert.match(pkg.scripts.prepublishOnly!, /release:check/);
  // The certified adapter set is a maintainer choice (any installer-registered adapter),
  // but every entry must be backed by a pinned real runner so the check cannot pass on
  // simulated evidence, and the flag must appear exactly once because release-check rejects repeats.
  assert.equal(script.split("--adapters").length, 2, "release:check must pass --adapters exactly once");
  const required = (/--adapters (\S+)/.exec(script)?.[1] ?? "").split(",").filter(Boolean);
  assert.ok(required.length > 0, "release:check must name at least one adapter");
  assert.equal(new Set(required).size, required.length);
  for (const adapter of required) {
    assert.ok(findAdapter(adapter), `release adapter ${adapter} is not registered by the installer`);
    assert.ok(Object.values(config.runners).some((item) => item.adapter === adapter && item.evidenceKind === "real" && item.protocolVersion === 2), `release adapter ${adapter} has no pinned real runner in dev/evaluator/config.json`);
  }
  assert.equal(config.runners["local-simulated"]!.evidenceKind, "simulated");
});
