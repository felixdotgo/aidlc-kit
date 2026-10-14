import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { adapters } from "../../src/adapters.js";
import { applyPlan, doctor, planInit, planUninstall, readManifest, status } from "../../src/installer.js";
import type { InitOptions } from "../../src/model.js";
import { applyUpgrade } from "../../src/upgrade.js";

const makeRoot = () => mkdtempSync(join(tmpdir(), "aidlc-v1-"));
const options = (root: string): InitOptions => ({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false });

test("package exposes only the npx-oriented workflow binary name", () => {
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  assert.deepEqual(manifest.bin, { "aidlc-workflow": "dist/src/cli.js" });
  assert.ok(manifest.files.includes("README.md"));
  assert.ok(manifest.files.includes("DEVELOPMENT.md"));
});

test("README provides setup while detailed documentation lives in docs", () => {
  const readme = readFileSync(resolve("README.md"), "utf8"); const development = readFileSync(resolve("DEVELOPMENT.md"), "utf8");
  const docs = resolve("docs");
  assert.match(readme, /## (?:pre-release )?quick start/i); assert.match(readme, /docs\/README\.md/); assert.doesNotMatch(readme, /## Development-only evaluator/);
  assert.doesNotMatch(readme, /## Workflow lifecycle/); assert.doesNotMatch(readme, /## Repository layout/);
  assert.match(development, /## Contributor documentation/); assert.match(development, /docs\/development\.md/);
  for (const name of ["README.md", "operating-workflow.md", "configuration.md", "command-reference.md", "development.md", "testing-and-release.md", "architecture.md"]) assert.ok(existsSync(join(docs, name)), `missing docs/${name}`);
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")); assert.ok(manifest.files.includes("docs"));
});

test("installs bundled assets with manifest v2 and separate project/state ownership", () => {
  const root = makeRoot();
  try {
    const plan = planInit(options(root));
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.equal(plan.find((item) => item.path === ".agents/config.json")?.ownershipClass, "project");
    assert.equal(plan.find((item) => item.path === ".agents/data/state/aidlc-state.json")?.ownershipClass, "state");
    applyPlan(root, plan);
    const manifest = readManifest(root);
    assert.equal(manifest?.schemaVersion, 2);
    assert.equal(manifest?.packageVersion, "0.0.1");
    assert.equal(manifest?.remoteUpdates, false);
    assert.ok(manifest?.files[".agents/aidlc/orchestrator.md"]);
    assert.ok(manifest?.files[".agents/aidlc/templates/model-contract.md"]);
    assert.ok(manifest?.files[".agents/aidlc/scripts/state.mjs"]);
    assert.ok(manifest?.files[".agents/aidlc/scripts/lib/runtime.mjs"]);
    assert.ok(manifest?.files[".agents/aidlc/scripts/lib/store.mjs"]);
    assert.ok(manifest?.files[".agents/aidlc/scripts/lib/context-runtime.mjs"]);
    assert.ok(manifest?.files[".agents/aidlc/scripts/gate-view.mjs"]);
    assert.ok(manifest?.files[".codex/config.toml"]);
    assert.ok(manifest?.files[".codex/rules/aidlc.rules"]);
    assert.equal(readFileSync(join(root, ".codex/config.toml"), "utf8"), "approval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n");
    assert.match(readFileSync(join(root, ".codex/rules/aidlc.rules"), "utf8"), /prefix_rule\(pattern = \["node", "\.agents\/aidlc\/scripts\/state\.mjs"\], decision = "allow"\)/);
    assert.equal(manifest?.files[".agents/data/state/BOARD.md"], undefined);
    assert.equal(existsSync(join(root, ".agents/data/state/BOARD.md")), false);
    assert.match(readFileSync(join(root, ".agents/aidlc/templates/model-contract.md"), "utf8"), /COSTARS/);
    assert.match(readFileSync(join(root, ".agents/aidlc/templates/model-contract.md"), "utf8"), /\.agents\/project\/rules/);
    const orchestrator = readFileSync(join(root, ".agents/aidlc/orchestrator.md"), "utf8");
    assert.match(orchestrator, /## Delegation contract/);
    assert.match(orchestrator, /available collaboration slots minus the lead/);
    assert.match(orchestrator, /single writer/);
    assert.match(orchestrator, /summary, changed paths, evidence, and concerns/);
    assert.match(readFileSync(join(root, ".agents/aidlc/scripts/lib/context-runtime.mjs"), "utf8"), /\.agents\/project\/profiles/);
    assert.match(readFileSync(join(root, ".agents/aidlc/phase-index.md"), "utf8"), /\.agents\/data\/index\/repo-map\.md/);
    for (const phase of ["clarify", "index", "plan", "build", "wrap"]) {
      assert.match(readFileSync(join(root, `.agents/aidlc/phase-${phase}.md`), "utf8"), /shared orchestration contract/);
    }
    assert.match(readFileSync(join(root, ".agents/aidlc/phase-build.md"), "utf8"), /final\/current authoritative `nextAction`/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8")), { schemaVersion: 4, tasks: {}, archive: {} });
    assert.equal(JSON.parse(readFileSync(join(root, ".agents/data/lessons/index.json"), "utf8")).schemaVersion, 1);
    assert.equal(JSON.parse(readFileSync(join(root, ".agents/data/memory/agentic-memory.json"), "utf8")).schemaVersion, 1);
    assert.equal(JSON.parse(readFileSync(join(root, ".agents/aidlc/schemas/state.schema.json"), "utf8")).properties.schemaVersion.const, 4);
    assert.match(doctor(root), /^OK:/);
    assert.match(status(root), /installed version: 0.0.1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installs Claude Code local lifecycle permission settings", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit({ ...options(root), agents: ["claude"] }));
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".claude/settings.local.json"), "utf8")), {
      permissions: { allow: ["Bash(node .agents/aidlc/scripts/*)"] }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init migrates legacy project data with transactional backup", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".aidlc/index"), { recursive: true });
    mkdirSync(join(root, ".aidlc/rules"), { recursive: true });
    writeFileSync(join(root, ".aidlc/config.json"), JSON.stringify({ schemaVersion: 2, rules: { include: [".aidlc/rules/*.md"] } }));
    writeFileSync(join(root, ".aidlc/index/repo-map.md"), "legacy index\n");
    writeFileSync(join(root, ".aidlc/rules/custom.bin"), Buffer.from([0, 255, 1, 2]));

    const plan = planInit(options(root));
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.equal(plan.find((item) => item.path === ".agents/config.json")?.action, "migrate");
    assert.equal(plan.find((item) => item.path === ".agents/data/index/repo-map.md")?.action, "migrate");
    assert.equal(plan.find((item) => item.path === ".agents/project/rules/custom.bin")?.contentEncoding, "base64");

    const result = applyUpgrade(root, plan);
    assert.ok(existsSync(join(root, result.backup, "journal.json")));
    assert.equal(existsSync(join(root, ".aidlc")), false);
    assert.match(readFileSync(join(root, ".agents/config.json"), "utf8"), /\.agents\/project\/rules/);
    assert.equal(readFileSync(join(root, ".agents/data/index/repo-map.md"), "utf8"), "legacy index\n");
    assert.deepEqual(readFileSync(join(root, ".agents/project/rules/custom.bin")), Buffer.from([0, 255, 1, 2]));
    assert.equal(readManifest(root)?.packageVersion, "0.0.1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init migration fails closed on differing legacy destination", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".aidlc/rules"), { recursive: true });
    mkdirSync(join(root, ".agents/project/rules"), { recursive: true });
    writeFileSync(join(root, ".aidlc/rules/custom.md"), "legacy\n");
    writeFileSync(join(root, ".agents/project/rules/custom.md"), "current\n");
    const plan = planInit(options(root));
    assert.equal(plan.find((item) => item.path === ".agents/project/rules/custom.md")?.action, "conflict");
    assert.throws(() => applyUpgrade(root, plan), /conflict/);
    assert.equal(readFileSync(join(root, ".aidlc/rules/custom.md"), "utf8"), "legacy\n");
    assert.equal(readFileSync(join(root, ".agents/project/rules/custom.md"), "utf8"), "current\n");
    assert.equal(existsSync(join(root, ".agents/aidlc/manifest.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generated Claude phase skills use descriptive review names", () => {
  const files = adapters.find((adapter) => adapter.id === "claude")!.files();
  for (const [phase, name] of [["clarify", "Confirm requirements"], ["plan", "Approve plan"], ["build", "Review implementation"]]) {
    const skill = files.find((file) => file.path === `.claude/skills/aidlc-${phase}/SKILL.md`);
    assert.ok(skill);
    assert.ok(skill.content.includes(`# AI-DLC ${phase} (${name})`));
    assert.doesNotMatch(skill.content, /\(G[012]\)/);
  }
});

test("official adapters carry the human-only upgrade boundary", () => {
  for (const adapter of adapters) for (const file of adapter.files()) {
    if (file.path === ".codex/config.toml") {
      assert.equal(file.content, "approval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n");
      continue;
    }
    if (file.path === ".codex/rules/aidlc.rules") {
      assert.match(file.content, /prefix_rule\(pattern = \["node", "\.agents\/aidlc\/scripts\/state\.mjs"\], decision = "allow"\)/);
      continue;
    }
    if (file.path === ".claude/settings.local.json") {
      assert.deepEqual(JSON.parse(file.content), { permissions: { allow: ["Bash(node .agents/aidlc/scripts/*)"] } });
      continue;
    }
    if (file.path.startsWith(".claude/skills/work-")) {
      const operation = file.path.split("/")[2].slice("work-".length);
      assert.ok(["intake", "checkpoint", "restore"].includes(operation));
      assert.ok(file.content.includes(`.agents/aidlc/work/${operation}.md`));
      assert.match(file.content, /\.agents\/aidlc\/work\/conventions\.md/);
      assert.match(file.content, /do not infer gate approval/);
      assert.doesNotMatch(file.content, /state\.mjs gate approve/);
      continue;
    }
    assert.match(file.content, /Never query npm/);
    assert.match(file.content, /Workflow install\/upgrade operations are human-only/);
    assert.match(file.content, /Project-configured build, test, and lint commands remain allowed/);
    assert.match(file.content, /state\.mjs task next/);
    assert.match(file.content, /state\.mjs gate approve/);
    assert.match(file.content, /parse (the returned )?`?nextAction`?/);
    assert.match(file.content, /terminal/);
    assert.match(file.content, /only.*complete|complete.*successful/i);
    assert.match(file.content, /Never invent/);
    assert.match(file.content, /task-next\.mjs <task-id> --require-stop/);
    assert.match(file.content, /item.*progress/i);
    if (file.path === "AGENTS.md" || file.path === "CLAUDE.md") {
      assert.match(file.content, /delegation contract/);
      assert.match(file.content, /native collaboration\/delegation tools/);
      const gateCheck = file.content.indexOf("gate-check.mjs");
      const blockedWait = file.content.indexOf("blocked_on_user", gateCheck);
      const gateView = file.content.indexOf("gate-view.mjs", blockedWait);
      assert.ok(gateCheck >= 0 && blockedWait > gateCheck && gateView > blockedWait);
      assert.match(file.content, /--source` provenance/);
      assert.match(file.content, /does not authenticate authorship/);
      assert.ok(file.content.split("\n").length > 20);
    }
  }
  assert.deepEqual(adapters.map((adapter) => adapter.id), ["claude", "codex"]);
  const codexAgents = adapters.find((adapter) => adapter.id === "codex")?.files().find((file) => file.path === "AGENTS.md")?.content;
  assert.match(codexAgents ?? "", /Run every `node \.agents\/aidlc\/scripts\/\.\.\.` lifecycle command in a separate exec call/);
  assert.match(codexAgents ?? "", /never join lifecycle commands with shell operators such as `&`, `&&`, `;`, or `\|`/);
  for (const file of adapters.find((adapter) => adapter.id === "claude")?.files() ?? []) if (file.path.startsWith(".claude/skills/aidlc-")) assert.match(file.content, /allowed-tools: Bash\(node \.agents\/aidlc\/scripts\/\*\)/);
  for (const skill of ["skills/aidlc-plan/SKILL.md", "skills/aidlc-build/SKILL.md"]) assert.doesNotMatch(readFileSync(resolve(skill), "utf8"), /review checklist/i);
});

test("re-init refreshes owned assets while preserving project config and state", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const config = join(root, ".agents/config.json");
    const state = join(root, ".agents/data/state/aidlc-state.json");
    writeFileSync(config, '{"schemaVersion":1,"custom":true}\n');
    writeFileSync(state, '{"schemaVersion":1,"tasks":{"kept":{}}}\n');
    const plan = planInit(options(root));
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.ok(["skip", "update"].includes(plan.find((item) => item.path === ".agents/aidlc/manifest.json")?.action ?? ""));
    assert.equal(plan.find((item) => item.path === ".agents/config.json")?.action, "preserve");
    assert.equal(plan.find((item) => item.path === ".agents/data/state/aidlc-state.json")?.action, "preserve");
    applyPlan(root, plan);
    assert.match(readFileSync(config, "utf8"), /custom/);
    assert.match(readFileSync(state, "utf8"), /kept/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("init cannot bypass the explicit human-only upgrade path", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const path = join(root, ".agents/aidlc/manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")); manifest.packageVersion = "0.9.0";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.throws(() => planInit(options(root)), /Only a human may upgrade/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("modified managed core conflicts while explicit initial force can replace unmanaged files", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const core = join(root, ".agents/aidlc/orchestrator.md");
    writeFileSync(core, `${readFileSync(core, "utf8")}\nlocal edit\n`);
    assert.equal(planInit(options(root)).find((item) => item.path === ".agents/aidlc/orchestrator.md")?.action, "conflict");

    const other = makeRoot();
    try {
      mkdirSync(join(other, ".codex"), { recursive: true });
      writeFileSync(join(other, ".codex/config.toml"), "unmanaged\n");
      assert.equal(planInit(options(other)).find((item) => item.path === ".codex/config.toml")?.action, "conflict");
      assert.equal(planInit({ ...options(other), force: true }).find((item) => item.path === ".codex/config.toml")?.action, "update");
    } finally { rmSync(other, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall removes unchanged managed assets and preserves state/config", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const plan = planUninstall(root);
    assert.equal(plan.some((item) => item.path.startsWith(".agents/data/state/")), false);
    applyPlan(root, plan);
    assert.equal(existsSync(join(root, ".agents/aidlc/manifest.json")), false);
    assert.ok(existsSync(join(root, ".agents/config.json")));
    assert.ok(existsSync(join(root, ".agents/data/state/aidlc-state.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uninstall preserves a modified managed adapter and ownership manifest", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const adapter = join(root, ".codex/config.toml");
    writeFileSync(adapter, `${readFileSync(adapter, "utf8")}local edit\n`);
    const plan = planUninstall(root);
    assert.equal(plan.find((item) => item.path === ".codex/config.toml")?.action, "preserve");
    assert.equal(plan.find((item) => item.path === ".agents/aidlc/manifest.json")?.action, "preserve");
    applyPlan(root, plan);
    assert.ok(existsSync(adapter));
    assert.ok(existsSync(join(root, ".agents/aidlc/manifest.json")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("package implementation contains no runtime remote fetch", () => {
  const files = [resolve("src/installer.ts"), resolve("src/upgrade.ts"), resolve("src/workflow.ts"), resolve(".agents/aidlc/orchestrator.md")];
  const content = files.map((file) => readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /npm\s+view/);
});

test("doctor strict validates project config and canonical state", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    writeFileSync(join(root, ".agents/config.json"), '{"schemaVersion":99}\n');
    assert.match(doctor(root, true), /^ERROR: local config\/state is invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bundled JSON schemas are valid JSON and avoid remote schema resolution", () => {
  const names = ["adapter", "config", "state", "profile", "manifest"];
  for (const name of names) {
    const content = readFileSync(resolve(`.agents/aidlc/schemas/${name}.schema.json`), "utf8");
    assert.doesNotThrow(() => JSON.parse(content));
    assert.doesNotMatch(content, /https?:\/\//);
  }
});

test("installer rejects non-Codex, non-Claude adapters", () => {
  const root = makeRoot();
  try {
    const allPlan = planInit({ ...options(root), agents: [], all: true });
    assert.deepEqual([...new Set(allPlan.filter((item) => item.owner === "codex" || item.owner === "claude").map((item) => item.owner))].sort(), ["claude", "codex"]);
    assert.throws(() => planInit({ ...options(root), agents: ["cursor"] }), /Unsupported adapter: cursor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluator harness is compiled for repository tests but excluded from public assets", () => {
  assert.ok(existsSync(resolve("dist/dev/evaluator/cli.js")));
  for (const path of ["dist/src/eval.js", "dist/src/release.js", "dist/src/release-check.js", "dist/src/runners/codex.js", "dist/assets/.agents/aidlc/eval/scenarios.json", "dist/assets/.agents/aidlc/schemas/eval-runner.schema.json", "dist/assets/.agents/aidlc/schemas/eval-suite.schema.json", "dist/assets/.agents/aidlc/schemas/eval-report.schema.json"]) assert.equal(existsSync(resolve(path)), false, `${path} must not be public`);
});
