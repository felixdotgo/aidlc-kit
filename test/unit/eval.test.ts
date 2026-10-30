import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findAdapter, installableAdapters } from "../../src/adapters.js";
import { evalSuiteDigest, evaluationPassed, loadEvalSuite, recomputeReportGate, releaseReady, reportIntegrityErrors, resolveRunnerArguments, runEvaluation, scenarioTimeoutMs, type EvalReport, type EvalScenarioResult } from "../../dev/evaluator/eval.js";
import { verifyReleaseEvidence } from "../../dev/evaluator/release.js";
import { validateState } from "../../src/state.js";

const suite = loadEvalSuite();
const packageVersion = "0.1.1";
const result = (id: string, category: string, model: string): EvalScenarioResult => ({ id, category, model, repeat: 1, completed: true, score: 10, assertions: [{ id: "a1", dimension: "state", severity: "critical", passed: true, detail: "ok" }], usage: { contextChars: 100, latencyMs: 10 }, diagnostics: [] });
const report = (runner: string, adapter: string, evidenceKind: "real" | "simulated" = "real"): EvalReport => {
  const model = `${runner}-model`; const results = suite.scenarios.map((scenario) => result(scenario.id, scenario.category, model));
  const categories = Object.fromEntries([...new Set(results.map((item) => item.category))].map((category) => [category, { completionRate: 1, averageScore: 10 }]));
  return { schemaVersion: 2, runner, adapter, model, modelsByCategory: {}, version: "pinned", protocolVersion: 2, evidenceKind, executionId: `${runner}-execution`, suiteId: suite.suiteId, suiteVersion: suite.version, suiteDigest: evalSuiteDigest(suite), releaseEligibleSuite: true, createdAt: new Date().toISOString(), durationMs: 10, scenarios: results.length, repeats: 1, completionRate: 1, averageScore: 10, criticalViolations: 0, dimensions: { state: 1 }, categories, telemetry: { medianContextChars: 100, p95ContextChars: 100, inputTokens: "notMeasured", outputTokens: "notMeasured", medianLatencyMs: 10, costUsd: "notMeasured", repeatPassRate: 1, scoreStdDev: 0 }, passedReleaseGate: true, results };
};

test("bundled agentic suite is versioned and release eligible", () => {
  const suite = loadEvalSuite();
  assert.equal(suite.schemaVersion, 2);
  assert.equal(suite.version, "2.5.0");
  assert.equal(suite.releaseEligible, true);
  assert.equal(suite.scenarios.length, 14);
  assert.ok(suite.scenarios.some((item) => item.turns.length > 1));
  assert.ok(suite.scenarios.some((item) => item.assertions.some((assertion) => assertion.type === "jsonEquals")));
  assert.ok(suite.scenarios.some((item) => item.assertions.some((assertion) => assertion.type === "eventNotObserved")));
  const supportedAdapters = suite.scenarios.find((item) => item.id === "supported-adapters");
  assert.match(supportedAdapters?.turns[0]?.input ?? "", /Codex, Claude Code, and OpenCode/);
  assert.doesNotMatch(supportedAdapters?.turns[0]?.input ?? "", /only/);
  assert.ok(supportedAdapters?.assertions.some((assertion) => assertion.id === "no-remote" && assertion.type === "eventNotObserved" && assertion.event === "network"));
  const boundedRepair = suite.scenarios.find((item) => item.id === "build-bounded-repair");
  assert.ok(boundedRepair?.assertions.some((assertion) => assertion.id === "handoff-kind" && assertion.type === "jsonEquals" && assertion.jsonPath === "tasks.eval-task.handoff.kind"));
  for (const id of ["build-multi-item-continuation", "build-bounded-repair", "g2-to-wrap"]) validateState(JSON.parse(suite.scenarios.find((item) => item.id === id)?.setup?.files?.[".agents/data/state/aidlc-state.json"] ?? "null"));
});

test("scenario timeout gives every turn its configured budget plus fixed harness grace", () => {
  assert.equal(scenarioTimeoutMs(300_000, 1), 330_000);
  assert.equal(scenarioTimeoutMs(300_000, 2), 630_000);
  assert.equal(scenarioTimeoutMs(300_000, 3), 930_000);
});

test("multi-turn runner receives separate per-turn and whole-scenario budgets", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-timeout-contract-"));
  try {
    const runner = join(root, "runner.mjs"); const suitePath = join(root, "suite.json");
    writeFileSync(runner, `let input = ""; for await (const chunk of process.stdin) input += chunk; const request = JSON.parse(input); process.stdout.write(JSON.stringify({ transport: "completed", transcript: "ok", diagnostics: [\`turns=\${request.scenario.turns.length} perTurn=\${process.env.AIDLC_EVAL_TIMEOUT_MS} outer=\${process.env.AIDLC_EVAL_SCENARIO_TIMEOUT_MS}\`] }));\n`);
    writeFileSync(suitePath, JSON.stringify({ schemaVersion: 2, suiteId: "timeout-contract", version: "1", releaseEligible: false, scenarios: [{ id: "multi", category: "continuation", maxContextChars: 1000, turns: [{ role: "user", input: "one" }, { role: "user", input: "two" }], assertions: [{ id: "transport", dimension: "completion", severity: "critical", type: "transportCompleted" }] }] }));
    const evaluated = runEvaluation("fixture", { command: "node", args: [runner], adapter: "codex", model: "fixture", version: "fixture", protocolVersion: 2, evidenceKind: "simulated", timeoutMs: 1000 }, process.cwd(), { suitePath });
    assert.deepEqual(evaluated.results[0]!.diagnostics, ["turns=2 perTurn=1000 outer=32000"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy keyword suites remain diagnostic-only", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-legacy-suite-"));
  try {
    const path = join(root, "legacy.json");
    writeFileSync(path, JSON.stringify([{ id: "old", category: "legacy", prompt: "Explain", requiredTerms: ["state"], forbiddenTerms: ["upgrade"] }]));
    const legacy = loadEvalSuite(path);
    assert.equal(legacy.releaseEligible, false);
    assert.equal(legacy.suiteId, "legacy-v1-diagnostic");
    assert.ok(legacy.scenarios[0]?.assertions.some((item) => item.type === "transcriptIncludes"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release gate is recomputed and requires two independent real reports", () => {
  assert.equal(recomputeReportGate(report("a", "codex")), true);
  assert.equal(recomputeReportGate({ ...report("a", "codex"), evidenceKind: "simulated", passedReleaseGate: true }), false);
  assert.equal(releaseReady([report("a", "codex")]), false);
  assert.equal(releaseReady([report("a", "codex"), report("b", "claude")]), true);
  const duplicateIdentity = { ...report("a", "codex"), executionId: "second-execution" };
  assert.equal(releaseReady([report("a", "codex"), duplicateIdentity]), false);
  const routedSameAdapter = { ...report("b", "codex"), model: "stronger", results: report("b", "codex").results.map((item) => ({ ...item, model: "stronger" })) };
  assert.equal(releaseReady([report("a", "codex"), routedSameAdapter]), false);
  assert.match(reportIntegrityErrors({ ...report("a", "codex"), averageScore: 9 }).join("; "), /aggregate/);
});

test("runner routes models by scenario category and records raw provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-model-routing-"));
  try {
    const runner = join(root, "runner.mjs"); const suitePath = join(root, "suite.json");
    writeFileSync(runner, `process.stdin.resume(); for await (const _ of process.stdin) {} process.stdout.write(JSON.stringify({transport:"completed",transcript:"ok",diagnostics:[process.env.AIDLC_EVAL_MODEL]}));\n`);
    writeFileSync(suitePath, JSON.stringify({ schemaVersion: 2, suiteId: "routing", version: "1", releaseEligible: false, scenarios: [
      { id: "plan", category: "clarify", maxContextChars: 1000, turns: [{ role: "user", input: "plan" }], assertions: [{ id: "t", dimension: "completion", severity: "critical", type: "transportCompleted" }] },
      { id: "do", category: "build", maxContextChars: 1000, turns: [{ role: "user", input: "build" }], assertions: [{ id: "t", dimension: "completion", severity: "critical", type: "transportCompleted" }] }
    ] }));
    const evaluated = runEvaluation("routed", { command: "node", args: [runner], adapter: "codex", model: "generalist", modelsByCategory: { build: "doer" }, version: "fixture", protocolVersion: 2, evidenceKind: "simulated" }, process.cwd(), { suitePath });
    assert.deepEqual(evaluated.modelsByCategory, { build: "doer" });
    assert.deepEqual(evaluated.results.map((item) => item.model), ["generalist", "doer"]);
    assert.deepEqual(evaluated.results.map((item) => item.diagnostics[0]), ["generalist", "doer"]);
    assert.match(reportIntegrityErrors({ ...evaluated, results: evaluated.results.map((item, index) => index ? { ...item, model: "forged" } : item) }).join("; "), /model routing mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner script paths resolve from the project root without escaping it", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-runner-root-"));
  try {
    assert.deepEqual(resolveRunnerArguments(root, ["./scripts/runner.mjs", "--mode", "safe"]), [join(root, "scripts/runner.mjs"), "--mode", "safe"]);
    assert.throws(() => resolveRunnerArguments(root, ["../runner.mjs"]), /escapes the project root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evaluation workspace installs every adapter registered by the installer", () => {
  for (const adapter of installableAdapters()) {
    const root = mkdtempSync(join(tmpdir(), `aidlc-${adapter.id}-native-eval-`));
    try {
      const marker = adapter.files().find((file) => file.path.endsWith(".md"))?.path;
      assert.ok(marker, `adapter ${adapter.id} must install a native instruction file`);
      assert.ok(findAdapter(adapter.id), `adapter ${adapter.id} is not registered by the installer`);
      const path = join(root, "suite.json");
      writeFileSync(path, JSON.stringify({ schemaVersion: 2, suiteId: "native-adapter", version: "1", releaseEligible: false, scenarios: [{ id: "native", category: "adapter", maxContextChars: 1000, turns: [{ role: "user", input: "Inspect native instructions" }], assertions: [{ id: "transport", dimension: "completion", severity: "critical", type: "transportCompleted" }, { id: "agents", dimension: "artifact", severity: "critical", type: "fileExists", path: marker }] }] }));
      const evaluated = runEvaluation(`fake-${adapter.id}`, { command: "node", args: [resolve("dev/evaluator/scripts/deterministic-eval-runner.mjs")], adapter: adapter.id, model: "fake", version: "fixture", protocolVersion: 2, evidenceKind: "simulated" }, process.cwd(), { suitePath: path });
      assert.equal(evaluated.results[0]!.score, 10, `${adapter.id}: ${evaluated.results[0]!.diagnostics.join("; ")}`);
      assert.equal(evaluated.passedReleaseGate, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("evaluation workspace fails closed for adapters outside the installer registry", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-unknown-eval-adapter-"));
  try {
    const path = join(root, "suite.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, suiteId: "unknown-adapter", version: "1", releaseEligible: false, scenarios: [{ id: "unknown", category: "adapter", maxContextChars: 1000, turns: [{ role: "user", input: "Inspect native instructions" }], assertions: [{ id: "transport", dimension: "completion", severity: "critical", type: "transportCompleted" }] }] }));
    assert.equal(findAdapter("unknown-vendor"), undefined);
    const evaluated = runEvaluation("fake-unknown", { command: "node", args: [resolve("dev/evaluator/scripts/deterministic-eval-runner.mjs")], adapter: "unknown-vendor", model: "fake", version: "fixture", protocolVersion: 2, evidenceKind: "simulated" }, process.cwd(), { suitePath: path });
    assert.equal(evaluated.results[0]!.completed, false);
    assert.ok(evaluated.results[0]!.assertions.every((assertion) => !assertion.passed));
    assert.match(evaluated.results[0]!.diagnostics.join("\n"), /Unsupported runner adapter: unknown-vendor/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("focused evaluation accepts ordered scenario lists and reports bounded observed assertion values", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-focused-eval-"));
  try {
    const path = join(root, "suite.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, suiteId: "focused", version: "1", releaseEligible: false, scenarios: [
      { id: "first", category: "state", maxContextChars: 1000, setup: { files: { "value.json": "{\"items\":[{\"result\":\"pass\"},{\"result\":\"fail\"}]}" } }, turns: [{ role: "user", input: "Inspect state" }], assertions: [{ id: "latest", dimension: "state", severity: "critical", type: "jsonEquals", path: "value.json", jsonPath: "items.$last.result", value: "fail" }] },
      { id: "second", category: "state", maxContextChars: 1000, turns: [{ role: "user", input: "Inspect state" }], assertions: [{ id: "transport", dimension: "completion", severity: "critical", type: "transportCompleted" }] }
    ] }));
    const evaluated = runEvaluation("fixture", { command: "node", args: [resolve("dev/evaluator/scripts/deterministic-eval-runner.mjs")], adapter: "codex", model: "fixture", version: "fixture", protocolVersion: 2, evidenceKind: "simulated", timeoutMs: 1000 }, process.cwd(), { suitePath: path, scenario: "second,first" });
    assert.deepEqual(evaluated.results.map((item) => item.id), ["first", "second"]); assert.equal(evaluationPassed(evaluated), true); assert.equal(evaluated.passedReleaseGate, false); assert.match(evaluated.results[0]!.assertions[0]!.detail, /observed="fail"/);
    assert.throws(() => runEvaluation("fixture", { command: "node", args: [resolve("dev/evaluator/scripts/deterministic-eval-runner.mjs")], adapter: "codex", model: "fixture", version: "fixture", protocolVersion: 2, evidenceKind: "simulated" }, process.cwd(), { suitePath: path, scenario: "missing" }), /Unknown evaluation scenarios/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed assertions include bounded transcript hashes and normalized event counts", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-eval-diagnostics-"));
  try {
    const path = join(root, "suite.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 2, suiteId: "diagnostics", version: "1", releaseEligible: false, scenarios: [{ id: "failure", category: "transcript", maxContextChars: 1000, turns: [{ role: "user", input: "Inspect" }], assertions: [{ id: "missing", dimension: "transcript", severity: "critical", type: "transcriptIncludes", text: "never-present-value" }] }] }));
    const evaluated = runEvaluation("fixture", { command: "node", args: [resolve("dev/evaluator/scripts/deterministic-eval-runner.mjs")], adapter: "codex", model: "fixture", version: "fixture", protocolVersion: 2, evidenceKind: "simulated", timeoutMs: 1000 }, process.cwd(), { suitePath: path });
    assert.equal(evaluationPassed(evaluated), false); assert.match(evaluated.results[0]!.diagnostics.at(-1) ?? "", /^transcriptChars=\d+ transcriptSha256=[a-f0-9]{12} eventTypes=/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release evidence defaults to two adapters and permits an explicit Codex-only policy", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-release-"));
  try {
    const path = join(root, "release.json");
    const write = (reports: EvalReport[]) => writeFileSync(path, JSON.stringify({ schemaVersion: 2, packageVersion, createdAt: new Date().toISOString(), reports }));
    write([report("a", "codex")]);
    assert.throws(() => verifyReleaseEvidence(path, packageVersion), /real adapters: claude/);
    assert.equal(verifyReleaseEvidence(path, packageVersion, { requiredAdapters: ["codex"] }).reports.length, 1);
    assert.throws(() => verifyReleaseEvidence(path, packageVersion, { requiredAdapters: [] }), /unique valid adapter IDs/);
    assert.throws(() => verifyReleaseEvidence(path, packageVersion, { requiredAdapters: ["codex", "codex"] }), /unique valid adapter IDs/);
    const releaseCheck = resolve("dist/dev/evaluator/release-check.js");
    const codexOnly = spawnSync(process.execPath, [releaseCheck, path, "--adapters", "codex"], { encoding: "utf8" });
    assert.equal(codexOnly.status, 0, codexOnly.stderr); assert.match(codexOnly.stdout, /PACKAGE READY.*codex/);
    const safeDefault = spawnSync(process.execPath, [releaseCheck, path], { encoding: "utf8" });
    assert.equal(safeDefault.status, 1); assert.match(safeDefault.stderr, /RELEASE BLOCKED.*claude/);
    const duplicateFlag = spawnSync(process.execPath, [releaseCheck, path, "--adapters", "codex", "--adapters", "codex"], { encoding: "utf8" });
    assert.equal(duplicateFlag.status, 1); assert.match(duplicateFlag.stderr, /RELEASE BLOCKED.*at most once/);
    write([{ ...report("a", "codex", "simulated"), passedReleaseGate: false }, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /thresholds/);
    write([{ ...report("a", "codex"), results: [] }, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /raw results/);
    write([{ ...report("a", "codex"), telemetry: { ...report("a", "codex").telemetry, medianContextChars: 1 } }, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /telemetry aggregate/);
    write([{ ...report("a", "codex"), suiteDigest: "forged" }, { ...report("b", "claude"), suiteDigest: "forged" }]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /bundled pinned official suite/);
    const forgedCategory = report("a", "codex"); forgedCategory.results[0]! = { ...forgedCategory.results[0]!, category: "forged", model: "forged-model" }; forgedCategory.modelsByCategory = { forged: "forged-model" }; forgedCategory.categories = Object.fromEntries([...new Set(forgedCategory.results.map((item) => item.category))].map((category) => { const items = forgedCategory.results.filter((item) => item.category === category); return [category, { completionRate: 1, averageScore: items.reduce((sum, item) => sum + item.score, 0) / items.length }]; }));
    write([forgedCategory, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /categories that do not match/);
    write([{ ...report("a", "codex"), runnerVerdict: "pass" } as EvalReport, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /unknown fields/);
    write([{ ...report("a", "codex"), passedReleaseGate: false }, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion), /persisted verdict/);
    write([{ ...report("a", "codex"), createdAt: "2020-01-01T00:00:00.000Z" }, report("b", "claude")]); assert.throws(() => verifyReleaseEvidence(path, packageVersion, { maxAgeDays: 1 }), /older than 1 days/);
    write([report("a", "codex"), report("b", "claude")]); assert.equal(verifyReleaseEvidence(path, packageVersion).reports.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
