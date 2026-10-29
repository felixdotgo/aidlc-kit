import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyPlan, doctor, planInit, readManifest } from "../../src/installer.js";
import { legacyV021AdapterContents } from "../../src/legacy.js";
import type { InitOptions, PlannedWrite } from "../../src/model.js";
import { defaultConfig, loadProjectConfig } from "../../src/profiles.js";
import { applyUpgrade, migrateLegacyBoard, planUpgrade } from "../../src/upgrade.js";

const makeRoot = () => mkdtempSync(join(tmpdir(), "aidlc-upgrade-"));
const options = (root: string): InitOptions => ({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false });

test("upgrade previews explicit loop selection and preserves config when omitted", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const path = join(root, ".agents/config.json");
    const original = readFileSync(path, "utf8");
    assert.equal(loadProjectConfig(root).loop?.mode, "off");
    const loop = { mode: "fleet" as const, agents: { lead: "claude" as const, workers: { one: "codex" as const, two: "claude" as const } } };
    const plan = planUpgrade(root, loop);
    assert.equal(plan.find((entry) => entry.path === ".agents/config.json")?.action, "update");
    assert.equal(readFileSync(path, "utf8"), original);
    const result = applyUpgrade(root, plan);
    assert.equal(readFileSync(join(root, result.backup, ".agents/config.json"), "utf8"), original);
    assert.deepEqual(loadProjectConfig(root).loop, loop);
    const updated = readFileSync(path, "utf8");
    const noChoice = planUpgrade(root);
    assert.equal(noChoice.find((entry) => entry.path === ".agents/config.json")?.action, "preserve");
    applyUpgrade(root, noChoice);
    assert.equal(readFileSync(path, "utf8"), updated);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("current installation upgrades without touching project config or state", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const config = join(root, ".agents/config.json"); const state = join(root, ".agents/data/state/aidlc-state.json");
    writeFileSync(config, `${readFileSync(config, "utf8").trim()}\n`);
    const plan = planUpgrade(root);
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.equal(plan.find((item) => item.path === ".agents/config.json")?.action, "preserve");
    assert.equal(plan.find((item) => item.path === ".agents/data/state/aidlc-state.json")?.action, "preserve");
    assert.equal(plan.find((item) => item.path === ".agents/aidlc/manifest.json")?.action, "update");
    assert.ok(existsSync(state));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade migrates an existing legacy project config to .agents", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    rmSync(join(root, ".agents/config.json"));
    mkdirSync(join(root, ".aidlc"), { recursive: true });
    writeFileSync(join(root, ".aidlc/config.json"), '{"schemaVersion":1,"legacy":true}\n');
    const plan = planUpgrade(root, { mode: "local" });
    assert.equal(plan.find((item) => item.path === ".agents/config.json")?.action, "migrate");
    assert.equal(plan.find((item) => item.path === ".aidlc/config.json")?.action, "delete");
    applyUpgrade(root, plan);
    assert.match(readFileSync(join(root, ".agents/config.json"), "utf8"), /legacy/);
    assert.equal(loadProjectConfig(root).loop?.mode, "local");
    assert.equal(existsSync(join(root, ".aidlc/config.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade migrates the complete legacy tree and rewrites schema-known paths", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    rmSync(join(root, ".agents/config.json"));
    mkdirSync(join(root, ".aidlc/index"), { recursive: true });
    mkdirSync(join(root, ".aidlc/profiles/local"), { recursive: true });
    mkdirSync(join(root, ".aidlc/rules"), { recursive: true });
    mkdirSync(join(root, ".aidlc/custom"), { recursive: true });
    writeFileSync(join(root, ".aidlc/config.json"), JSON.stringify({ ...defaultConfig(), schemaVersion: 1, extends: ["local"], rules: { include: [".aidlc/rules/*.md"] } }));
    writeFileSync(join(root, ".aidlc/index/repo-map.md"), "# Legacy index\n");
    writeFileSync(join(root, ".aidlc/profiles/local/profile.json"), JSON.stringify({ schemaVersion: 1, id: "local", topology: "single", rules: { include: [".aidlc/rules/*.md"] } }));
    writeFileSync(join(root, ".aidlc/rules/a.md"), "# Rule\n");
    writeFileSync(join(root, ".aidlc/custom/blob.bin"), Buffer.from([0, 255, 1, 2]));

    const plan = planUpgrade(root);
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.equal(plan.find((item) => item.path === ".agents/data/index/repo-map.md")?.action, "migrate");
    assert.equal(plan.find((item) => item.path === ".agents/project/profiles/local/profile.json")?.action, "migrate");
    assert.equal(plan.find((item) => item.path === ".agents/project/custom/blob.bin")?.contentEncoding, "base64");

    applyUpgrade(root, plan);
    assert.equal(existsSync(join(root, ".aidlc")), false);
    assert.equal(readFileSync(join(root, ".agents/data/index/repo-map.md"), "utf8"), "# Legacy index\n");
    assert.match(readFileSync(join(root, ".agents/project/profiles/local/profile.json"), "utf8"), /\.agents\/project\/rules/);
    assert.match(readFileSync(join(root, ".agents/config.json"), "utf8"), /\.agents\/project\/rules/);
    assert.deepEqual(readFileSync(join(root, ".agents/project/custom/blob.bin")), Buffer.from([0, 255, 1, 2]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy migration deduplicates identical destinations and conflicts on differing content", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    mkdirSync(join(root, ".aidlc/rules"), { recursive: true });
    mkdirSync(join(root, ".agents/project/rules"), { recursive: true });
    writeFileSync(join(root, ".aidlc/rules/same.md"), "same\n");
    writeFileSync(join(root, ".agents/project/rules/same.md"), "same\n");
    writeFileSync(join(root, ".aidlc/rules/conflict.md"), "legacy\n");
    writeFileSync(join(root, ".agents/project/rules/conflict.md"), "canonical\n");
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".aidlc/rules/same.md")?.action, "delete");
    assert.equal(plan.find((item) => item.path === ".agents/project/rules/conflict.md")?.action, "conflict");
    assert.throws(() => applyUpgrade(root, plan), /no files were written/);
    assert.equal(readFileSync(join(root, ".aidlc/rules/same.md"), "utf8"), "same\n");
    assert.equal(readFileSync(join(root, ".agents/project/rules/conflict.md"), "utf8"), "canonical\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy migration rejects symlinks before any write", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    mkdirSync(join(root, ".aidlc/rules"), { recursive: true });
    writeFileSync(join(root, "outside.md"), "outside\n");
    symlinkSync(join(root, "outside.md"), join(root, ".aidlc/rules/escape.md"));
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".aidlc/rules/escape.md")?.action, "conflict");
    assert.throws(() => applyUpgrade(root, plan), /no files were written/);
    assert.equal(readFileSync(join(root, "outside.md"), "utf8"), "outside\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade moves prior discovery indexes out of lifecycle state", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    writeFileSync(join(root, ".agents/data/state/repo-map.md"), "# Repo map\n");
    writeFileSync(join(root, ".agents/data/state/specs-index.md"), "# Specs index\n");
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".agents/data/index/repo-map.md")?.action, "migrate");
    applyUpgrade(root, plan);
    assert.equal(existsSync(join(root, ".agents/data/state/repo-map.md")), false);
    assert.equal(readFileSync(join(root, ".agents/data/index/specs-index.md"), "utf8"), "# Specs index\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("current canonical JSON installation removes a leftover BOARD projection", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const board = join(root, ".agents/data/state/BOARD.md");
    writeFileSync(board, "# AI-DLC BOARD\n\n_No tasks in flight._\n");
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".agents/data/state/BOARD.md")?.action, "delete");
    applyUpgrade(root, plan);
    assert.equal(existsSync(board), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8")), { schemaVersion: 4, tasks: {}, archive: {} });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade migrates valid canonical state v1 to v4 transactionally without changing active task content", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const path = join(root, ".agents/data/state/aidlc-state.json");
    const legacyTask = {
      id: "2026-0001-v1", title: "Legacy v1", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—",
      artifacts: { intent: ".agents/data/tasks/2026-0001-v1/intent.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, tasks: { [legacyTask.id]: legacyTask } }, null, 2)}\n`);
    const plan = planUpgrade(root); const stateItem = plan.find((item) => item.path === ".agents/data/state/aidlc-state.json");
    assert.equal(stateItem?.action, "migrate"); assert.match(stateItem?.reason ?? "", /v1 to v4/);
    const result = applyUpgrade(root, plan); const migrated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(migrated.schemaVersion, 4); assert.deepEqual(migrated.tasks[legacyTask.id], legacyTask); assert.deepEqual(migrated.archive, {});
    assert.equal(JSON.parse(readFileSync(join(root, result.backup, ".agents/data/state/aidlc-state.json"), "utf8")).schemaVersion, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("upgrade compacts v2 terminal tasks and builds the lesson index transactionally", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const statePath = join(root, ".agents/data/state/aidlc-state.json");
    const active = {
      id: "2026-0002-active", title: "Active", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—",
      artifacts: { intent: ".agents/data/tasks/2026-0002-active/intent.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const done = {
      ...active, id: "2026-0001-done", title: "Done", phase: "done", gate: "none", status: "done", artifacts: { intent: ".agents/data/tasks/2026-0001-done/intent.md" },
      lessons: [{ id: "keep-index-small", taskId: "2026-0001-done", areas: ["root"], summary: "Keep state reads bounded", prevention: "Use the lesson index", example: "lesson search", promotion: "orchestrator", source: "upgrade fixture", recordedAt: "2026-01-01T00:00:01.000Z" }],
      lessonDisposition: { status: "captured", source: "upgrade fixture", recordedAt: "2026-01-01T00:00:01.000Z" }, updatedAt: "2026-01-01T00:00:01.000Z"
    };
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 2, tasks: { [active.id]: active, [done.id]: done } }, null, 2)}\n`);
    const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".agents/data/state/archive/2026-0001-done.json")?.action, "migrate");
    const result = applyUpgrade(root, plan);
    const migrated = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(Object.keys(migrated.tasks), [active.id]); assert.deepEqual(Object.keys(migrated.archive), [done.id]);
    assert.equal(JSON.parse(readFileSync(join(root, migrated.archive[done.id].record), "utf8")).id, done.id);
    assert.equal(JSON.parse(readFileSync(join(root, ".agents/data/lessons/index.json"), "utf8")).lessons[0].id, "keep-index-small");
    assert.equal(JSON.parse(readFileSync(join(root, result.backup, ".agents/data/state/aidlc-state.json"), "utf8")).schemaVersion, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("modified managed core creates a conflict before any upgrade write", () => {
  const root = makeRoot();
  try {
    applyPlan(root, planInit(options(root)));
    const target = join(root, ".agents/aidlc/orchestrator.md");
    writeFileSync(target, `${readFileSync(target, "utf8")}local change\n`);
    const before = readFileSync(target, "utf8"); const plan = planUpgrade(root);
    assert.equal(plan.find((item) => item.path === ".agents/aidlc/orchestrator.md")?.action, "conflict");
    assert.throws(() => applyUpgrade(root, plan), /no files were written/);
    assert.equal(readFileSync(target, "utf8"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("transaction stages all writes and leaves earlier targets unchanged on symlink rejection", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "a.txt"), "before\n");
    writeFileSync(join(root, "real.txt"), "real\n");
    symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    const spec = (path: string, content: string): PlannedWrite => ({ path, content, owner: "test", ownershipClass: "managed", action: "update", reason: "test" });
    assert.throws(() => applyUpgrade(root, [spec("a.txt", "after\n"), spec("link.txt", "bad\n")]), /symlink/);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "before\n");
    assert.equal(readFileSync(join(root, "real.txt"), "utf8"), "real\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("successful transaction creates an audit backup", () => {
  const root = makeRoot();
  try {
    writeFileSync(join(root, "a.txt"), "before\n");
    const plan: PlannedWrite[] = [{ path: "a.txt", content: "after\n", owner: "test", ownershipClass: "managed", action: "update", reason: "test" }];
    const result = applyUpgrade(root, plan);
    assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "after\n");
    assert.ok(existsSync(join(root, result.backup, "journal.json")));
    assert.equal(readFileSync(join(root, result.backup, "a.txt"), "utf8"), "before\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy BOARD migration preserves prose and reconstructs approval history", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    mkdirSync(join(root, ".agents/data/tasks/in-progress"), { recursive: true });
    const doc = ".agents/data/tasks/in-progress/01-01-2026-legacy.md";
    writeFileSync(join(root, doc), "---\ntask_id: 2026-0101-legacy\ntype: infra\nlanguage: en\n---\n# Legacy\n");
    writeFileSync(join(root, ".agents/data/state/BOARD.md"), "# AI-DLC BOARD\n\n| id | title | phase | gate | status | branch | submodules | doc |\n|----|-------|-------|------|--------|--------|------------|-----|\n| `2026-0101-legacy` | Legacy | build | G2_codereview | active | — | root | `.agents/data/tasks/in-progress/01-01-2026-legacy.md` |\n");
    const migrated = migrateLegacyBoard(root); const task = migrated.state.tasks["2026-0101-legacy"];
    assert.equal(task.phase, "build");
    assert.equal(task.language, "en");
    assert.ok(task.evidence.some((item) => item.gate === "G0_confirm"));
    assert.ok(task.evidence.some((item) => item.gate === "G1_review"));
    assert.ok(migrated.files.some((item) => item.path.endsWith("intent-design.md")));
    assert.ok(migrated.files.some((item) => item.path.endsWith("workplan.md")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("recognized v0.2.1 core and adapter migrate end-to-end without conflicts", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".agents/aidlc/rules"), { recursive: true });
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    mkdirSync(join(root, ".agents/data/tasks/open"), { recursive: true });
    writeFileSync(join(root, ".agents/aidlc/manifest.json"), '{"schemaVersion":1,"workflow":"AI-DLC","source":"local-package-assets","remoteUpdates":false,"managedBy":"aidlc-workflow"}\n');
    writeFileSync(join(root, ".agents/aidlc/rules/gate-check.md"), "# Gate-check command (AI-DLC · project rule)\n\n> Project-specific executable for the gate self-check. The **generic contract** (what the command must accept/return, when to run it, manual fallback) lives in `.agents/aidlc/conventions.md §3`; this file holds the concrete command for THIS repo.\n\n## Command\n\n## Caveats\n");
    writeFileSync(join(root, "AGENTS.md"), legacyV021AdapterContents["AGENTS.md"]);
    const doc = ".agents/data/tasks/open/01-01-2026-legacy.md";
    writeFileSync(join(root, doc), "---\ntask_id: 2026-0101-legacy\ntype: infra\nlanguage: en\n---\n# Legacy\n");
    writeFileSync(join(root, ".agents/data/state/BOARD.md"), `# AI-DLC BOARD\n\n| id | title | phase | gate | status | branch | submodules | doc |\n|----|-------|-------|------|--------|--------|------------|-----|\n| \`2026-0101-legacy\` | Legacy | clarify | G0_confirm | blocked_on_user | — | root | \`${doc}\` |\n`);
    const plan = planUpgrade(root);
    assert.equal(plan.some((item) => item.action === "conflict"), false);
    assert.equal(plan.find((item) => item.path === ".agents/aidlc/rules/gate-check.md")?.action, "update");
    assert.equal(plan.find((item) => item.path === "AGENTS.md")?.action, "update");
    assert.equal(plan.find((item) => item.path === ".agents/data/state/aidlc-state.json")?.action, "migrate");
    applyUpgrade(root, plan);
    assert.equal(readManifest(root)?.schemaVersion, 2);
    assert.match(doctor(root, true), /^OK:/);
    assert.ok(JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8")).tasks["2026-0101-legacy"]);
    assert.equal(existsSync(join(root, ".agents/data/state/BOARD.md")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy BOARD migration refuses an unrecognized projection", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    writeFileSync(join(root, ".agents/data/state/BOARD.md"), "custom state that cannot be migrated\n");
    assert.throws(() => migrateLegacyBoard(root), /refusing lossy migration/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy BOARD migration refuses a malformed task row", () => {
  const root = makeRoot();
  try {
    mkdirSync(join(root, ".agents/data/state"), { recursive: true });
    writeFileSync(join(root, ".agents/data/state/BOARD.md"), "# AI-DLC BOARD\n\n| broken | task | row |\n");
    assert.throws(() => migrateLegacyBoard(root), /malformed task row/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
