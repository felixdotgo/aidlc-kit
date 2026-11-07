import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const lib = resolve("dist/assets/.agents/aidlc/scripts/lib");
const loopEnv = async (): Promise<any> => import(join(lib, "loop-env.mjs"));
const noDocker = () => true;

const config = (lead: string, workers: Record<string, string>, mode = "local") => ({ loop: { mode, agents: { lead, workers } } });

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-env-"));
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(join(root, ".agents"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { dir, root, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseEnvFile reads dotenv lines, quotes, export prefix, and comments without expansion", async () => {
  const { parseEnvFile } = await loopEnv();
  const values = parseEnvFile([
    "# comment",
    "",
    "export A=1",
    "B = two words # trailing comment",
    'C="quoted # not a comment\\nnext"',
    "D='$HOME stays literal'",
    "E=",
  ].join("\n"));
  assert.deepEqual(values, { A: "1", B: "two words", C: "quoted # not a comment\nnext", D: "$HOME stays literal", E: "" });
  assert.throws(() => parseEnvFile("not a pair", "loop.env"), /loop\.env:1: expected KEY=VALUE/);
  assert.throws(() => parseEnvFile('X="open', "loop.env"), /unterminated double quote/);
  assert.throws(() => parseEnvFile("1BAD=x", "loop.env"), /expected KEY=VALUE/);
});

test("parseJsonc strips comments and trailing commas but keeps strings", async () => {
  const { parseJsonc } = await loopEnv();
  assert.deepEqual(parseJsonc('{\n // model\n "model": "a/b", /* x */ "url": "http://x//y",\n}'), { model: "a/b", url: "http://x//y" });
});

test("loadLoopEnv: shell beats file beats derived, and secrets never reach the report", async () => {
  const { loadLoopEnv, publicReport, formatLoopEnvReport } = await loopEnv();
  const box = sandbox();
  try {
    writeFileSync(join(box.root, ".agents/loop.env"), "AIDLC_OPENCODE_MODEL=opencode-go/file-model\nOPENCODE_API_KEY=file-secret-value\nEXTRA_SETTING=on\n");
    writeFileSync(join(box.root, ".agents/.gitignore"), "loop.env\n");
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { "worker-a": "opencode" }), env: { PATH: "", AIDLC_OPENCODE_MODEL: "opencode-go/shell-model" }, commandExists: noDocker });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    const entry = (key: string) => report.entries.find((item: any) => item.key === key);
    assert.deepEqual(entry("AIDLC_OPENCODE_MODEL"), { key: "AIDLC_OPENCODE_MODEL", set: true, source: "shell", secret: false, value: "opencode-go/shell-model" });
    assert.equal(entry("OPENCODE_API_KEY").source, "file");
    assert.equal(entry("OPENCODE_API_KEY").value, undefined);
    assert.equal(entry("EXTRA_SETTING").set, true);
    assert.equal(entry("EXTRA_SETTING").value, undefined, "only known non-secret AIDLC values are ever shown");
    assert.equal(entry("AIDLC_LOOP_EVENT_LOG").value, join(box.root, ".agents/data/loop/ui-events.jsonl"));
    // Shell keys are never re-applied; file and derived ones are.
    assert.equal(report.applied.AIDLC_OPENCODE_MODEL, undefined);
    assert.equal(report.applied.OPENCODE_API_KEY, "file-secret-value");
    const printable = JSON.stringify(publicReport(report)) + formatLoopEnvReport(publicReport(report));
    assert.doesNotMatch(printable, /file-secret-value/);
    assert.equal(publicReport(report).applied, undefined);
  } finally { box.cleanup(); }
});

test("loadLoopEnv derives the OpenCode model and key from OpenCode's own config", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".config/opencode"), { recursive: true });
    mkdirSync(join(box.home, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(box.home, ".config/opencode/opencode.json"), JSON.stringify({ model: "opencode-go/global-model" }));
    writeFileSync(join(box.root, "opencode.jsonc"), '{ // project wins\n "model": "opencode-go/project-model", }');
    writeFileSync(join(box.home, ".local/share/opencode/auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "oc-secret" }, anthropic: { type: "oauth" } }));
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { w: "opencode" }), env: { PATH: "" }, commandExists: noDocker });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.applied.AIDLC_OPENCODE_MODEL, "opencode-go/project-model");
    assert.equal(report.applied.OPENCODE_API_KEY, "oc-secret");
    const key = report.entries.find((item: any) => item.key === "OPENCODE_API_KEY");
    assert.equal(key.source, `derived:${join(box.home, ".local/share/opencode/auth.json")}`);
  } finally { box.cleanup(); }
});

test("loadLoopEnv derives Codex and Claude worker keys and warns on subscription-only logins", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".codex"), { recursive: true });
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    mkdirSync(join(box.root, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-codex" }));
    writeFileSync(join(box.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "user-level" } }));
    writeFileSync(join(box.root, ".claude/settings.local.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "local-level" } }));
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("claude", { a: "codex", b: "claude" }), env: { PATH: "" }, commandExists: noDocker });
    assert.equal(report.applied.OPENAI_API_KEY, "sk-codex");
    assert.equal(report.applied.ANTHROPIC_API_KEY, "local-level");
    assert.deepEqual(report.problems.filter((problem: any) => problem.level === "warning" && problem.key), []);

    writeFileSync(join(box.home, ".codex/auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: "x" } }));
    const chatgpt = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { a: "codex" }), env: { PATH: "" }, commandExists: noDocker });
    assert.equal(chatgpt.ok, true);
    assert.match(chatgpt.problems.find((problem: any) => problem.key === "OPENAI_API_KEY").message, /signed in with ChatGPT/);
  } finally { box.cleanup(); }
});

test("loadLoopEnv fails closed on a missing opencode model, mode off, or an explicit missing env file", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  try {
    const noModel = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { w: "codex" }), env: { PATH: "" }, commandExists: noDocker });
    assert.equal(noModel.ok, false);
    assert.match(noModel.problems.find((problem: any) => problem.level === "error").message, /opencode needs a model/);
    const bad = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { w: "codex" }), env: { PATH: "", AIDLC_OPENCODE_MODEL: "no-slash" }, commandExists: noDocker });
    assert.match(bad.problems.find((problem: any) => problem.level === "error").message, /provider\/model/);
    const off = loadLoopEnv({ root: box.root, home: box.home, config: { loop: { mode: "off" } }, env: { PATH: "" }, commandExists: noDocker });
    assert.match(off.problems[0].message, /loop\.mode is off/);
    const explicit = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: "", AIDLC_ENV_FILE: "missing.env" }, commandExists: noDocker });
    assert.equal(explicit.ok, false);
    assert.match(explicit.problems[0].message, /env file not found/);
    const docker = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: "", OPENAI_API_KEY: "x" }, commandExists: () => false });
    assert.ok(docker.problems.some((problem: any) => /docker was not found/.test(problem.message)));
  } finally { box.cleanup(); }
});

test("loadLoopEnv warns when git would commit the env file and refuses env-file links outside project and home", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  const outside = mkdtempSync(join(tmpdir(), "aidlc-env-outside-"));
  try {
    writeFileSync(join(box.root, ".agents/loop.env"), "OPENAI_API_KEY=x\n");
    const outsideRepo = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: "" }, commandExists: noDocker });
    assert.ok(!outsideRepo.problems.some((problem: any) => /not git-ignored/.test(problem.message)), "outside a git work tree there is nothing to commit");
    spawnSync("git", ["init", "-q"], { cwd: box.root });
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: process.env.PATH ?? "" }, commandExists: noDocker });
    assert.ok(report.problems.some((problem: any) => /not git-ignored/.test(problem.message)));
    writeFileSync(join(box.root, ".gitignore"), "*.env\n");
    const ignored = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: process.env.PATH ?? "" }, commandExists: noDocker });
    assert.ok(!ignored.problems.some((problem: any) => /not git-ignored/.test(problem.message)), "any pattern git honours counts");
    writeFileSync(join(outside, "real.env"), "OPENAI_API_KEY=x\n");
    symlinkSync(join(outside, "real.env"), join(box.root, "linked.env"));
    const linked = loadLoopEnv({ root: box.root, home: box.home, config: config("codex", { w: "codex" }), env: { PATH: "", AIDLC_ENV_FILE: "linked.env" }, commandExists: noDocker });
    assert.equal(linked.ok, false);
    assert.match(linked.problems.find((problem: any) => problem.level === "error").message, /links outside/);
  } finally { box.cleanup(); rmSync(outside, { recursive: true, force: true }); }
});

test("loop-entry env prints a report without secrets and exits 1 until the environment is complete", () => {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-env-entry-"));
  const home = join(dir, "home");
  mkdirSync(home);
  try {
    applyPlan(dir, planInit({ root: dir, agents: ["codex"], all: false, dryRun: false, yes: true, force: false, loop: { mode: "local", agents: { lead: "codex", workers: { "worker-a": "codex" } } } }));
    const entry = join(dir, ".agents/aidlc/scripts/loop-entry.mjs");
    const env = { PATH: process.env.PATH ?? "", HOME: home, OPENAI_API_KEY: "sk-never-printed" };
    const ok = spawnSync(process.execPath, [entry, "env", dir], { encoding: "utf8", env });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /OPENAI_API_KEY\s+set\s+\[shell\]/);
    assert.doesNotMatch(ok.stdout, /sk-never-printed/);
    const json = spawnSync(process.execPath, [entry, "env", dir, "--json"], { encoding: "utf8", env });
    assert.equal(JSON.parse(json.stdout).ok, true);
    const broken = spawnSync(process.execPath, [entry, "env", dir], { encoding: "utf8", env: { ...env, AIDLC_ENV_FILE: "nope.env" } });
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /env file not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loadLoopEnv works for a project reached through a symlink and follows tool-config links", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  try {
    const linkedRoot = join(box.dir, "linked-project");
    symlinkSync(box.root, linkedRoot);
    writeFileSync(join(box.root, ".agents/loop.env"), "OPENAI_API_KEY=x\n");
    const store = join(box.dir, "store");
    mkdirSync(store);
    writeFileSync(join(store, "opencode.json"), JSON.stringify({ model: "opencode-go/linked" }));
    mkdirSync(join(box.home, ".config/opencode"), { recursive: true });
    symlinkSync(join(store, "opencode.json"), join(box.home, ".config/opencode/opencode.json"));
    const report = loadLoopEnv({ root: linkedRoot, home: box.home, config: config("opencode", { w: "codex" }), env: { PATH: "" }, commandExists: noDocker });
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.applied.OPENAI_API_KEY, "x");
    assert.equal(report.applied.AIDLC_OPENCODE_MODEL, "opencode-go/linked");
  } finally { box.cleanup(); }
});

test("loadLoopEnv never assigns the OpenCode Zen key to another provider's key", async () => {
  const { loadLoopEnv } = await loopEnv();
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".local/share/opencode"), { recursive: true });
    writeFileSync(join(box.home, ".local/share/opencode/auth.json"), JSON.stringify({ openai: { type: "oauth" }, opencode: { type: "api", key: "zen-secret" } }));
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { w: "opencode" }), env: { PATH: "", AIDLC_OPENCODE_MODEL: "openai/gpt-5" }, commandExists: noDocker });
    assert.equal(report.applied.OPENAI_API_KEY, undefined);
    assert.ok(report.problems.some((problem: any) => problem.key === "OPENAI_API_KEY"));
  } finally { box.cleanup(); }
});

test("loadLoopEnv keeps parser text and non-AIDLC values out of every report", async () => {
  const { loadLoopEnv, publicReport, formatLoopEnvReport } = await loopEnv();
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), '{"env": {"ANTHROPIC_API_KEY": sk-ant-leaky}}');
    writeFileSync(join(box.root, ".agents/loop.env"), "DATABASE_URL=postgres://u:hunter2@h/db\n");
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("claude", { w: "claude" }), env: { PATH: "" }, commandExists: noDocker });
    const printed = JSON.stringify(publicReport(report)) + formatLoopEnvReport(publicReport(report));
    assert.doesNotMatch(printed, /sk-ant-leaky|hunter2/);
    assert.match(printed, /not valid JSON/);
  } finally { box.cleanup(); }
});

test("loadLoopEnv leaves exported (even empty) shell values alone and keeps detected worker keys away from the lead", async () => {
  const { loadLoopEnv } = await loopEnv();
  const drivers = await import(join(lib, "loop-drivers.mjs"));
  const box = sandbox();
  try {
    mkdirSync(join(box.home, ".claude"), { recursive: true });
    writeFileSync(join(box.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "detected" } }));
    writeFileSync(join(box.root, ".agents/loop.env"), "OPENAI_API_KEY=from-file\nOPENCODE_API_KEY=from-file\n");
    const report = loadLoopEnv({ root: box.root, home: box.home, config: config("claude", { a: "codex", b: "claude", c: "opencode" }), env: { PATH: "", OPENAI_API_KEY: "", AIDLC_OPENCODE_MODEL: "opencode-go/x" }, commandExists: noDocker });
    assert.equal(report.applied.OPENAI_API_KEY, undefined, "an exported empty value is not overridden");
    assert.equal(report.applied.ANTHROPIC_API_KEY, "detected");
    assert.equal(report.applied.OPENCODE_API_KEY, "from-file");
    assert.equal(report.applied.AIDLC_LEAD_ENV_EXCLUDE, "ANTHROPIC_API_KEY", "only detected keys are worker-only; env-file keys act like exports");
    const empty = loadLoopEnv({ root: box.root, home: box.home, config: config("opencode", { c: "opencode" }), env: { PATH: "", AIDLC_OPENCODE_MODEL: "" }, commandExists: noDocker });
    assert.match(empty.problems.find((problem: any) => problem.level === "error").message, /exported empty in the shell/);
    const lead = drivers.leadEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "from-file", OPENAI_API_KEY: "shell", AIDLC_LEAD_ENV_EXCLUDE: "ANTHROPIC_API_KEY" });
    assert.deepEqual(lead, { PATH: "/bin", OPENAI_API_KEY: "shell" });
    const untouched = { PATH: "/bin" };
    assert.equal(drivers.leadEnv(untouched), untouched);
  } finally { box.cleanup(); }
});
