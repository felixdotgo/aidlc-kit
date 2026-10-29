import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findAdapter } from "../../src/adapters.js";
import { applyPlan, planInit } from "../../src/installer.js";
import type { EvalRunner } from "./config.js";

const bundledSuitePath = fileURLToPath(new URL("./assets/scenarios.json", import.meta.url));
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type EvalDimension = "completion" | "continuation" | "state" | "artifact" | "tool" | "safety" | "verification" | "transcript";
export type EvalAssertion = { id: string; dimension: EvalDimension; severity: "critical" | "high" | "medium" | "low"; type: "transportCompleted" | "fileExists" | "jsonEquals" | "transcriptIncludes" | "transcriptExcludes" | "eventObserved" | "eventNotObserved"; path?: string; jsonPath?: string; value?: unknown; text?: string; event?: string };
export interface EvalTurn { role: "user"; input: string }
export interface EvalScenario { id: string; category: string; turns: EvalTurn[]; assertions: EvalAssertion[]; maxContextChars: number; setup?: { files?: Record<string, string> } }
export interface EvalSuite { schemaVersion: 2; suiteId: string; version: string; releaseEligible: boolean; scenarios: EvalScenario[] }
export interface RunnerResult { transport: "completed" | "error" | "timeout"; transcript: string; events?: Array<{ type: string; [key: string]: unknown }>; usage?: { inputTokens?: number; outputTokens?: number; contextChars?: number; latencyMs?: number; costUsd?: number }; diagnostics?: string[] }
export interface AssertionResult { id: string; dimension: EvalDimension; severity: EvalAssertion["severity"]; passed: boolean; detail: string }
export interface EvalScenarioResult { id: string; category: string; model: string; repeat: number; completed: boolean; score: number; assertions: AssertionResult[]; usage: NonNullable<RunnerResult["usage"]>; diagnostics: string[] }
export interface EvalReport {
  schemaVersion: 2;
  runner: string;
  adapter: string;
  model: string;
  modelsByCategory: Record<string, string>;
  version: string;
  protocolVersion: 1 | 2;
  evidenceKind: "simulated" | "real";
  executionId: string;
  suiteId: string;
  suiteVersion: string;
  suiteDigest: string;
  releaseEligibleSuite: boolean;
  createdAt: string;
  durationMs: number;
  scenarios: number;
  repeats: number;
  completionRate: number;
  averageScore: number;
  criticalViolations: number;
  dimensions: Record<string, number | "notMeasured">;
  categories: Record<string, { completionRate: number; averageScore: number }>;
  telemetry: { medianContextChars: number | "notMeasured"; p95ContextChars: number | "notMeasured"; inputTokens: number | "notMeasured"; outputTokens: number | "notMeasured"; medianLatencyMs: number | "notMeasured"; costUsd: number | "notMeasured"; repeatPassRate: number; scoreStdDev: number };
  passedReleaseGate: boolean;
  results: EvalScenarioResult[];
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const median = (values: number[]): number | "notMeasured" => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : "notMeasured";
const p95 = (values: number[]): number | "notMeasured" => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : "notMeasured";
const total = (values: number[]): number | "notMeasured" => values.length ? values.reduce((sum, value) => sum + value, 0) : "notMeasured";
const inside = (root: string, path: string): string => { const target = resolve(root, path); const fromRoot = relative(resolve(root), target); if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Path escapes evaluation workspace: ${path}`); return target; };
const bounded = (value: unknown): string => { const rendered = JSON.stringify(value); const text = rendered === undefined ? String(value) : rendered; return text.length <= 240 ? text : `${text.slice(0, 237)}...`; };
export const scenarioTimeoutMs = (perTurnTimeoutMs: number, turns: number): number => perTurnTimeoutMs * turns + 30_000;

const validateSuite = (value: unknown): EvalSuite => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Evaluation suite must be an object");
  const suite = value as EvalSuite;
  if (suite.schemaVersion !== 2 || !safeId.test(suite.suiteId) || !suite.version || !Array.isArray(suite.scenarios) || !suite.scenarios.length) throw new Error("Unsupported evaluation suite");
  const ids = new Set<string>();
  for (const scenario of suite.scenarios) {
    if (!safeId.test(scenario.id) || ids.has(scenario.id) || !scenario.category || !Array.isArray(scenario.turns) || !scenario.turns.length || !Array.isArray(scenario.assertions) || !scenario.assertions.length || !Number.isInteger(scenario.maxContextChars) || scenario.maxContextChars < 1) throw new Error(`Invalid evaluation scenario: ${scenario.id}`);
    ids.add(scenario.id);
    for (const assertion of scenario.assertions) {
      if (!safeId.test(assertion.id) || !["critical", "high", "medium", "low"].includes(assertion.severity) || !["completion", "continuation", "state", "artifact", "tool", "safety", "verification", "transcript"].includes(assertion.dimension) || !["transportCompleted", "fileExists", "jsonEquals", "transcriptIncludes", "transcriptExcludes", "eventObserved", "eventNotObserved"].includes(assertion.type)) throw new Error(`Invalid assertion in ${scenario.id}`);
      if (["fileExists", "jsonEquals"].includes(assertion.type) && !assertion.path) throw new Error(`Assertion ${assertion.id} requires a path`);
      if (["transcriptIncludes", "transcriptExcludes"].includes(assertion.type) && !assertion.text) throw new Error(`Assertion ${assertion.id} requires text`);
      if (["eventObserved", "eventNotObserved"].includes(assertion.type) && !assertion.event) throw new Error(`Assertion ${assertion.id} requires an event`);
    }
  }
  return suite;
};

type LegacyScenario = { id: string; category: string; prompt: string; requiredTerms?: string[]; forbiddenTerms?: string[]; maxContextChars?: number };
const legacySuite = (items: LegacyScenario[]): EvalSuite => validateSuite({ schemaVersion: 2, suiteId: "legacy-v1-diagnostic", version: "1-compat", releaseEligible: false, scenarios: items.map((item) => ({ id: item.id, category: item.category, maxContextChars: item.maxContextChars ?? 16_000, turns: [{ role: "user", input: item.prompt }], assertions: [{ id: "transport", dimension: "completion", severity: "critical", type: "transportCompleted" }, ...(item.requiredTerms ?? []).map((text, index) => ({ id: `required-${index}`, dimension: "transcript", severity: "medium", type: "transcriptIncludes", text })), ...(item.forbiddenTerms ?? []).map((text, index) => ({ id: `forbidden-${index}`, dimension: "safety", severity: "high", type: "transcriptExcludes", text }))] })) });

export const loadEvalSuite = (path = bundledSuitePath): EvalSuite => {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(value) ? legacySuite(value as LegacyScenario[]) : validateSuite(value);
};
export const evalSuiteDigest = (suite: EvalSuite): string => digest(suite);

export const resolveRunnerArguments = (root: string, args: string[]): string[] => {
  const projectRoot = resolve(root);
  return args.map((arg) => {
    if (!arg.startsWith("./") && !arg.startsWith("../")) return arg;
    const candidate = resolve(projectRoot, arg); const fromRoot = relative(projectRoot, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error(`Runner argument escapes the project root: ${arg}`);
    return candidate;
  });
};

const normalizeRunnerResult = (stdout: string, id: string): RunnerResult => {
  try {
    const value = JSON.parse(stdout) as RunnerResult & { status?: "pass" | "fail" };
    if (value.transport && ["completed", "error", "timeout"].includes(value.transport) && typeof value.transcript === "string") return value;
    if (value.status && typeof value.transcript === "string") return { transport: value.status === "pass" ? "completed" : "error", transcript: value.transcript, usage: value.usage, diagnostics: ["legacy protocol v1: diagnostic only", ...(value.diagnostics ?? [])] };
  } catch { /* normalized below */ }
  throw new Error(`Runner returned invalid JSON for ${id}`);
};

const jsonValue = (path: string, pointer = ""): unknown => pointer.split(".").filter(Boolean).reduce<unknown>((current, key) => {
  if (key === "$last" && Array.isArray(current)) return current.at(-1);
  return current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
}, JSON.parse(readFileSync(path, "utf8")));
const evaluateAssertion = (workspace: string, assertion: EvalAssertion, result: RunnerResult): AssertionResult => {
  let passed = false; let detail: string = assertion.type;
  try {
    if (assertion.type === "transportCompleted") { passed = result.transport === "completed"; detail = `expected=completed observed=${result.transport}`; }
    if (assertion.type === "fileExists") { const exists = Boolean(assertion.path && existsSync(inside(workspace, assertion.path))); passed = exists; detail = `path=${assertion.path} exists=${exists}`; }
    if (assertion.type === "jsonEquals") { const observed = assertion.path ? jsonValue(inside(workspace, assertion.path), assertion.jsonPath) : undefined; passed = Boolean(assertion.path) && JSON.stringify(observed) === JSON.stringify(assertion.value); detail = `path=${assertion.path} jsonPath=${assertion.jsonPath ?? ""} expected=${bounded(assertion.value)} observed=${bounded(observed)}`; }
    if (assertion.type === "transcriptIncludes") { const matched = Boolean(assertion.text && result.transcript.toLowerCase().includes(assertion.text.toLowerCase())); passed = matched; detail = `text=${bounded(assertion.text)} matched=${matched} transcriptChars=${result.transcript.length}`; }
    if (assertion.type === "transcriptExcludes") { const matched = Boolean(assertion.text && result.transcript.toLowerCase().includes(assertion.text.toLowerCase())); passed = Boolean(assertion.text) && !matched; detail = `text=${bounded(assertion.text)} matched=${matched} transcriptChars=${result.transcript.length}`; }
    if (assertion.type === "eventObserved" || assertion.type === "eventNotObserved") { const observed = [...new Set((result.events ?? []).map((event) => event.type))]; const matched = Boolean(assertion.event && observed.includes(assertion.event)); passed = assertion.type === "eventObserved" ? matched : Boolean(assertion.event) && !matched; detail = `event=${assertion.event} observed=${bounded(observed)}`; }
  } catch (error) { detail = error instanceof Error ? error.message : String(error); }
  return { id: assertion.id, dimension: assertion.dimension, severity: assertion.severity, passed, detail };
};

const provision = (workspace: string, scenario: EvalScenario, adapter: string): void => {
  if (!findAdapter(adapter)) throw new Error(`Unsupported runner adapter: ${adapter}`);
  applyPlan(workspace, planInit({ root: workspace, agents: [adapter], all: false, dryRun: false, yes: true, force: false }));
  mkdirSync(join(workspace, ".agents/data/tasks"), { recursive: true });
  for (const [path, content] of Object.entries(scenario.setup?.files ?? {})) { const target = inside(workspace, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content, "utf8"); }
};

export interface EvalRunOptions { suitePath?: string; scenario?: string; category?: string; repeat?: number; progress?: (message: string) => void }
export const runEvaluation = (runnerId: string, runner: EvalRunner, root = process.cwd(), options: EvalRunOptions = {}): EvalReport => {
  const started = Date.now(); const suite = loadEvalSuite(options.suitePath); const runnerArgs = resolveRunnerArguments(root, runner.args); const repeat = options.repeat ?? 1;
  const modelsByCategory = Object.fromEntries(Object.entries(runner.modelsByCategory ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  if (!runner.model?.trim() || Object.entries(modelsByCategory).some(([category, model]) => !safeId.test(category) || typeof model !== "string" || !model.trim())) throw new Error("Runner model routing requires non-empty models and safe category IDs");
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("repeat must be an integer from 1 to 20");
  const requested = options.scenario?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  if (requested.some((id) => !safeId.test(id)) || new Set(requested).size !== requested.length) throw new Error("--scenario requires unique comma-separated scenario IDs");
  const unknown = requested.filter((id) => !suite.scenarios.some((item) => item.id === id));
  if (unknown.length) throw new Error(`Unknown evaluation scenarios: ${unknown.join(", ")}`);
  const requestedIds = new Set(requested);
  const selected = suite.scenarios.filter((item) => (!requested.length || requestedIds.has(item.id)) && (!options.category || item.category === options.category));
  if (!selected.length) throw new Error("No evaluation scenarios matched the filters");
  const results: EvalScenarioResult[] = [];
  for (const scenario of selected) for (let iteration = 1; iteration <= repeat; iteration += 1) {
    options.progress?.(`[${results.length + 1}/${selected.length * repeat}] ${scenario.id} repeat ${iteration}`);
    const workspace = mkdtempSync(join(tmpdir(), `aidlc-eval-${scenario.id}-`)); const scenarioStarted = Date.now(); const model = modelsByCategory[scenario.category] ?? runner.model; let output: RunnerResult;
    try {
      provision(workspace, scenario, runner.adapter ?? "codex");
      const request = { protocolVersion: 2, suiteId: suite.suiteId, scenario, workspace }; const perTurnTimeoutMs = runner.timeoutMs ?? 120_000; const outerTimeoutMs = scenarioTimeoutMs(perTurnTimeoutMs, scenario.turns.length);
      const execution = spawnSync(runner.command, runnerArgs, { input: JSON.stringify(request), encoding: "utf8", timeout: outerTimeoutMs, cwd: workspace, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PWD: workspace, AIDLC_EVAL_WORKSPACE: workspace, AIDLC_EVAL_MODEL: model, AIDLC_EVAL_VERSION: runner.version, AIDLC_EVAL_TIMEOUT_MS: String(perTurnTimeoutMs), AIDLC_EVAL_SCENARIO_TIMEOUT_MS: String(outerTimeoutMs) }, shell: false });
      if (execution.error || execution.status !== 0) { const timedOut = Boolean(execution.error && "code" in execution.error && execution.error.code === "ETIMEDOUT"); output = { transport: timedOut ? "timeout" : "error", transcript: "", diagnostics: [timedOut ? `scenario=${scenario.id} turns=${scenario.turns.length} perTurnTimeoutMs=${perTurnTimeoutMs} outerTimeoutMs=${outerTimeoutMs} elapsedMs=${Date.now() - scenarioStarted} timeout` : execution.error?.message ?? `Runner exited ${execution.status}: ${execution.stderr}`] }; }
      else output = normalizeRunnerResult(execution.stdout, scenario.id);
      output.usage = { ...output.usage, latencyMs: output.usage?.latencyMs ?? Date.now() - scenarioStarted };
      const assertions = scenario.assertions.map((assertion) => evaluateAssertion(workspace, assertion, output));
      const passed = assertions.filter((item) => item.passed).length;
      const diagnostics = [...(output.diagnostics ?? [])];
      if (assertions.some((item) => !item.passed)) { const eventTypes = Object.entries((output.events ?? []).reduce<Record<string, number>>((counts, event) => ({ ...counts, [event.type]: (counts[event.type] ?? 0) + 1 }), {})); diagnostics.push(`transcriptChars=${output.transcript.length} transcriptSha256=${digest(output.transcript).slice(0, 12)} eventTypes=${bounded(eventTypes)}`); }
      results.push({ id: scenario.id, category: scenario.category, model, repeat: iteration, completed: output.transport === "completed", score: 10 * passed / assertions.length, assertions, usage: output.usage, diagnostics });
    } catch (error) {
      results.push({ id: scenario.id, category: scenario.category, model, repeat: iteration, completed: false, score: 0, assertions: scenario.assertions.map((item) => ({ id: item.id, dimension: item.dimension, severity: item.severity, passed: false, detail: "scenario execution failed" })), usage: { latencyMs: Date.now() - scenarioStarted }, diagnostics: [error instanceof Error ? error.message : String(error)] });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
  const completionRate = results.filter((item) => item.completed).length / results.length; const averageScore = results.reduce((sum, item) => sum + item.score, 0) / results.length;
  const assertions = results.flatMap((item) => item.assertions); const criticalViolations = assertions.filter((item) => item.severity === "critical" && !item.passed).length;
  const dimensions = Object.fromEntries([...new Set(assertions.map((item) => item.dimension))].map((dimension) => { const items = assertions.filter((item) => item.dimension === dimension); return [dimension, items.length ? items.filter((item) => item.passed).length / items.length : "notMeasured" as const]; })) as Record<string, number | "notMeasured">;
  const categories = Object.fromEntries([...new Set(results.map((item) => item.category))].map((category) => { const items = results.filter((item) => item.category === category); return [category, { completionRate: items.filter((item) => item.completed).length / items.length, averageScore: items.reduce((sum, item) => sum + item.score, 0) / items.length }]; }));
  const contexts = results.flatMap((item) => Number.isFinite(item.usage.contextChars) ? [item.usage.contextChars!] : []); const latencies = results.flatMap((item) => Number.isFinite(item.usage.latencyMs) ? [item.usage.latencyMs!] : []); const scores = results.map((item) => item.score); const mean = averageScore;
  const report: EvalReport = { schemaVersion: 2, runner: runnerId, adapter: runner.adapter ?? runnerId, model: runner.model, modelsByCategory, version: runner.version, protocolVersion: runner.protocolVersion ?? 1, evidenceKind: runner.evidenceKind ?? "simulated", executionId: `${Date.now()}-${process.pid}-${digest(results).slice(0, 12)}`, suiteId: suite.suiteId, suiteVersion: suite.version, suiteDigest: digest(suite), releaseEligibleSuite: suite.releaseEligible && selected.length === suite.scenarios.length && !options.scenario && !options.category, createdAt: new Date().toISOString(), durationMs: Date.now() - started, scenarios: selected.length, repeats: repeat, completionRate, averageScore, criticalViolations, dimensions, categories, telemetry: { medianContextChars: median(contexts), p95ContextChars: p95(contexts), inputTokens: total(results.flatMap((item) => Number.isFinite(item.usage.inputTokens) ? [item.usage.inputTokens!] : [])), outputTokens: total(results.flatMap((item) => Number.isFinite(item.usage.outputTokens) ? [item.usage.outputTokens!] : [])), medianLatencyMs: median(latencies), costUsd: total(results.flatMap((item) => Number.isFinite(item.usage.costUsd) ? [item.usage.costUsd!] : [])), repeatPassRate: results.filter((item) => item.score >= 8 && item.completed).length / results.length, scoreStdDev: Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length) }, passedReleaseGate: false, results };
  report.passedReleaseGate = recomputeReportGate(report);
  return report;
};

export const recomputeReportGate = (report: EvalReport): boolean => {
  if (report.schemaVersion !== 2 || report.protocolVersion !== 2 || report.evidenceKind !== "real" || !report.releaseEligibleSuite || reportIntegrityErrors(report).length) return false;
  const completion = report.results.filter((item) => item.completed).length / report.results.length; const score = report.results.reduce((sum, item) => sum + item.score, 0) / report.results.length;
  const critical = report.results.some((item) => item.assertions.some((assertion) => assertion.severity === "critical" && !assertion.passed));
  return completion >= 0.85 && score >= 8 && !critical && report.results.every((item) => item.completed && item.assertions.length > 0);
};
export const evaluationPassed = (report: EvalReport): boolean => report.results.length > 0 && report.results.every((item) => item.completed && item.assertions.length > 0 && item.assertions.every((assertion) => assertion.passed));

const close = (left: number, right: number): boolean => Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 1e-9;
const equalMetric = (left: number | "notMeasured", right: number | "notMeasured"): boolean => left === "notMeasured" || right === "notMeasured" ? left === right : close(left, right);

export const reportIntegrityErrors = (report: EvalReport): string[] => {
  const errors: string[] = [];
  if (!report || typeof report !== "object" || !report.telemetry || !report.dimensions || !report.categories || !report.modelsByCategory || Array.isArray(report.modelsByCategory) || !Array.isArray(report.results)) return ["report structure is incomplete"];
  if (!report.model?.trim() || Object.entries(report.modelsByCategory).some(([category, model]) => !safeId.test(category) || typeof model !== "string" || !model.trim())) errors.push("invalid model routing map");
  if (!report.results?.length || !Number.isInteger(report.scenarios) || report.scenarios < 1 || !Number.isInteger(report.repeats) || report.repeats < 1 || report.results.length !== report.scenarios * report.repeats) errors.push("raw results do not match scenario/repeat counts");
  if (!report.results?.length) return errors;
  const keys = new Set<string>(); const ids = new Set<string>();
  for (const item of report.results) {
    const key = `${item.id}:${item.repeat}`; if (keys.has(key)) errors.push(`duplicate result ${key}`); keys.add(key); ids.add(item.id);
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 10 || !Number.isInteger(item.repeat) || item.repeat < 1 || item.repeat > report.repeats || !item.assertions.length) errors.push(`invalid raw result ${key}`);
    if (!item.model || item.model !== (report.modelsByCategory[item.category] ?? report.model)) errors.push(`model routing mismatch: ${key}`);
    if (item.assertions.some((assertion) => typeof assertion.passed !== "boolean")) errors.push(`invalid assertion result ${key}`);
  }
  if (ids.size !== report.scenarios) errors.push("raw results do not cover unique scenarios");
  const completionRate = report.results.filter((item) => item.completed).length / report.results.length;
  const averageScore = report.results.reduce((sum, item) => sum + item.score, 0) / report.results.length;
  const criticalViolations = report.results.flatMap((item) => item.assertions).filter((item) => item.severity === "critical" && !item.passed).length;
  if (!close(report.completionRate, completionRate) || !close(report.averageScore, averageScore) || report.criticalViolations !== criticalViolations) errors.push("persisted aggregate does not match raw results");
  const repeatPassRate = report.results.filter((item) => item.score >= 8 && item.completed).length / report.results.length;
  const scoreStdDev = Math.sqrt(report.results.reduce((sum, item) => sum + (item.score - averageScore) ** 2, 0) / report.results.length);
  if (!close(report.telemetry.repeatPassRate, repeatPassRate) || !close(report.telemetry.scoreStdDev, scoreStdDev)) errors.push("persisted repeat metrics do not match raw results");
  const contexts = report.results.flatMap((item) => Number.isFinite(item.usage.contextChars) ? [item.usage.contextChars!] : []); const latencies = report.results.flatMap((item) => Number.isFinite(item.usage.latencyMs) ? [item.usage.latencyMs!] : []);
  const telemetry: Array<[keyof EvalReport["telemetry"], number | "notMeasured"]> = [
    ["medianContextChars", median(contexts)], ["p95ContextChars", p95(contexts)],
    ["inputTokens", total(report.results.flatMap((item) => Number.isFinite(item.usage.inputTokens) ? [item.usage.inputTokens!] : []))],
    ["outputTokens", total(report.results.flatMap((item) => Number.isFinite(item.usage.outputTokens) ? [item.usage.outputTokens!] : []))],
    ["medianLatencyMs", median(latencies)], ["costUsd", total(report.results.flatMap((item) => Number.isFinite(item.usage.costUsd) ? [item.usage.costUsd!] : []))]
  ];
  for (const [key, expected] of telemetry) if (!equalMetric(report.telemetry[key], expected)) errors.push(`telemetry aggregate mismatch: ${key}`);
  const assertions = report.results.flatMap((item) => item.assertions);
  for (const dimension of new Set(assertions.map((item) => item.dimension))) {
    const items = assertions.filter((item) => item.dimension === dimension); const expected = items.filter((item) => item.passed).length / items.length;
    if (!(dimension in report.dimensions) || !equalMetric(report.dimensions[dimension], expected)) errors.push(`dimension aggregate mismatch: ${dimension}`);
  }
  for (const category of new Set(report.results.map((item) => item.category))) {
    const items = report.results.filter((item) => item.category === category); const expectedCompletion = items.filter((item) => item.completed).length / items.length; const expectedScore = items.reduce((sum, item) => sum + item.score, 0) / items.length;
    if (!report.categories[category] || !close(report.categories[category].completionRate, expectedCompletion) || !close(report.categories[category].averageScore, expectedScore)) errors.push(`category aggregate mismatch: ${category}`);
  }
  return errors;
};

export const releaseReady = (reports: EvalReport[], requiredAdapters = ["codex", "claude"]): boolean => {
  const adapters = new Set(reports.map((item) => item.adapter));
  return requiredAdapters.length > 0
    && requiredAdapters.every((adapter) => adapters.has(adapter))
    && new Set(reports.map((item) => item.executionId)).size === reports.length
    && reports.every((report) => recomputeReportGate(report));
};
