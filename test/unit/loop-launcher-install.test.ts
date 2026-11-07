import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";
import { applyUpgrade, planUpgrade } from "../../src/upgrade.js";
import { LOOP_ENV_TEMPLATE } from "../../src/workflow.js";

const init = (root: string, mode: "off" | "local" = "off") =>
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false, ...(mode === "local" ? { loop: { mode, agents: { lead: "codex", workers: { "worker-a": "codex" } } } } : {}) }));

test("init always installs the launchers, an executable loop.sh, and a git-ignored env template", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-launch-install-"));
  try {
    init(root); // loop mode off: the launchers are still installed
    const sh = join(root, ".agents/aidlc/scripts/loop.sh");
    const cmd = join(root, ".agents/aidlc/scripts/loop.cmd");
    assert.ok(existsSync(sh) && existsSync(cmd));
    if (process.platform !== "win32") assert.equal(statSync(sh).mode & 0o111, 0o111);
    assert.match(readFileSync(cmd, "utf8"), /\r\n/, "loop.cmd keeps CRLF line endings");
    const manifest = JSON.parse(readFileSync(join(root, ".agents/aidlc/manifest.json"), "utf8"));
    assert.ok(manifest.files[".agents/aidlc/scripts/loop.sh"] && manifest.files[".agents/aidlc/scripts/loop.cmd"]);
    assert.equal(readFileSync(join(root, ".agents/loop.env"), "utf8"), LOOP_ENV_TEMPLATE);
    assert.match(readFileSync(join(root, ".agents/.gitignore"), "utf8"), /^loop\.env$/m);
    // The template is all comments: it sets nothing until the user edits it.
    assert.ok(LOOP_ENV_TEMPLATE.split("\n").every((line) => !line.trim() || line.startsWith("#")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade preserves an edited env file and gitignore and restores the launcher mode", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-launch-upgrade-"));
  try {
    init(root, "local");
    writeFileSync(join(root, ".agents/loop.env"), "OPENAI_API_KEY=mine\n");
    writeFileSync(join(root, ".agents/.gitignore"), "loop.env\ncustom\n");
    rmSync(join(root, ".agents/aidlc/scripts/loop.sh"));
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".agents/loop.env")?.action, "preserve");
    assert.equal(plan.find((item) => item.path === ".agents/.gitignore")?.action, "preserve");
    applyUpgrade(root, plan);
    assert.equal(readFileSync(join(root, ".agents/loop.env"), "utf8"), "OPENAI_API_KEY=mine\n");
    assert.equal(readFileSync(join(root, ".agents/.gitignore"), "utf8"), "loop.env\ncustom\n");
    const sh = join(root, ".agents/aidlc/scripts/loop.sh");
    assert.ok(existsSync(sh));
    if (process.platform !== "win32") assert.equal(statSync(sh).mode & 0o111, 0o111);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop.sh forwards to the project CLI with --root and maps check to loop env", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-launch-sh-"));
  try {
    init(root, "local");
    // A stand-in project-local CLI that echoes its arguments.
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    const fake = join(root, "node_modules/.bin/aidlc-kit");
    writeFileSync(fake, "#!/bin/sh\necho \"cli:$*\"\n");
    chmodSync(fake, 0o755);
    const sh = join(root, ".agents/aidlc/scripts/loop.sh");
    const run = (...args: string[]) => spawnSync(sh, args, { encoding: "utf8", cwd: tmpdir() });
    assert.equal(run().stdout.trim(), `cli:loop up --root ${root}`);
    assert.equal(run("up", "--open", "--port", "5000").stdout.trim(), `cli:loop up --root ${root} --open --port 5000`);
    assert.equal(run("check").stdout.trim(), `cli:loop env --root ${root}`);
    assert.equal(run("down", "--now").stdout.trim(), `cli:loop down --root ${root} --now`);
    assert.equal(run("--open").stdout.trim(), `cli:loop up --root ${root} --open`, "options alone run the default command");
    assert.match(run("help").stdout, /Usage: \.agents\/aidlc\/scripts\/loop\.sh/);
    const unknown = run("bogus");
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown command: bogus/);
    assert.match(run("logs").stdout, /No daemon log yet/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
