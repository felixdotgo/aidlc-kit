#!/usr/bin/env node
// Fleet lead lifecycle entry point. It never reads or writes local lifecycle JSON.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createRemoteReviewerClient, createRemoteStateClient, featureConfig, remoteConfig, reviewerConfig } from "./lib/remote-state-client.mjs";
import { compileContext } from "./lib/context-runtime.mjs";
import { checkGate, closeTask, handoffTask, nextAction, readyTaskItems, recordLesson, recordNoLessons, reopenTask, transitionTask, validateState } from "./lib/store.mjs";

const parse = (argv) => {
  const positionals = []; const options = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${value}`);
    if (options.has(value)) throw new Error(`Duplicate option: ${value}`);
    options.set(value, argv[++i]);
  }
  return { positionals, options, option: (name) => options.get(name) };
};

const required = (value, name) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; };
const statuses = new Set(["active", "blocked_on_user", "paused"]);
const itemStatuses = new Set(["todo", "in_progress", "done", "deferred"]);
const evidenceKinds = new Set(["spec", "test", "lint", "review", "diagnostic"]);
const results = new Set(["pass", "fail", "skip"]);
const gateNames = new Set(["G0_confirm", "G1_review", "G2_codereview"]);
const now = () => new Date().toISOString();
const execFileAsync = promisify(execFile);
export const readIntegrationCommit = async ({ projectRoot, integrationBranch, gitRemote = "origin" }, run = execFileAsync) => {
  if (!projectRoot?.startsWith("/") || !integrationBranch || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(integrationBranch) || integrationBranch.includes("..") || integrationBranch.endsWith("/") || !gitRemote || gitRemote.startsWith("-")) throw new Error("Valid project root, integration branch, and Git remote are required for G2 approval");
  const ref = `refs/heads/${integrationBranch}`;
  let stdout;
  try { ({ stdout } = await run("git", ["ls-remote", "--exit-code", "--heads", gitRemote, ref], { cwd: projectRoot, timeout: 20000, maxBuffer: 65536 })); }
  catch (error) { throw new Error(`Cannot verify integration branch remote ref: ${error.message}`); }
  const rows = String(stdout).trim().split(/\r?\n/).filter(Boolean).map((line) => line.split("\t"));
  if (rows.length !== 1 || rows[0][1] !== ref || !/^[a-f0-9]{40}$/i.test(rows[0][0])) throw new Error("Integration branch remote ref is missing or ambiguous");
  return rows[0][0].toLowerCase();
};
const remoteCommand = (value) => typeof value === "string" ? value
  .replace(/node (?:"([^"]*\/)context\.mjs"|([^\s"]*\/)context\.mjs)/g, (_match, quoted, bare) => quoted ? `node "${quoted}remote-state.mjs" phase context` : `node ${bare}remote-state.mjs phase context`)
  .replace(/node (?:"([^"]*\/)state\.mjs"|([^\s"]*\/)state\.mjs)/g, (_match, quoted, bare) => quoted ? `node "${quoted}remote-state.mjs"` : `node ${bare}remote-state.mjs`)
  .replace(/node (?:"([^"]*\/)gate-check\.mjs"|([^\s"]*\/)gate-check\.mjs)/g, (_match, quoted, bare) => quoted ? `node "${quoted}remote-state.mjs" gate check` : `node ${bare}remote-state.mjs gate check`)
  .replace(/ --root (?:"[^"]*"|[^\s]+)/g, "") : value;
const remoteAction = (action) => action && typeof action === "object" ? { ...action, ...(action.command ? { command: remoteCommand(action.command) } : {}) } : action;

export const runRemoteState = async (argv, client, root, git = {}) => {
  const { positionals: args, options, option } = parse(argv);
  const [group, action, id, extra] = args;
  const route = `${group ?? ""} ${action ?? ""}`;
  const readOnly = new Set(["task show", "task next", "task ready", "gate check", "phase context"]);
  const mutations = new Set(["task create", "task status", "task item", "task transition", "task handoff", "task close", "task reopen", "decision set", "evidence add", "lesson record", "lesson none", "gate snapshot"]);
  if (!readOnly.has(route) && !mutations.has(route)) throw new Error(`Unsupported remote lifecycle command: ${route}. Gate approval is reviewer-only.`);
  required(id, "task id");
  const allowed = {
    "task show": [], "task next": [], "task ready": [], "gate check": ["--gate"], "phase context": ["--phase", "--mode", "--item"],
    "task create": ["--title", "--type", "--language", "--risk", "--area", "--feature"],
    "task status": ["--status", "--mode", "--reason", "--source"], "task item": ["--status", "--label", "--depends-on", "--owns"],
    "task transition": ["--to", "--mode", "--reason", "--source"],
    "task handoff": ["--kind", "--reason", "--source"], "task close": ["--reason", "--source"], "task reopen": ["--to", "--reason", "--source"],
    "decision set": ["--status", "--label", "--resolution"],
    "evidence add": ["--kind", "--result", "--gate", "--area", "--source", "--detail"],
    "lesson record": ["--area", "--summary", "--prevention", "--example", "--promotion", "--source"],
    "lesson none": ["--reason", "--source"],
    "gate snapshot": ["--gate", "--review-file"]
  }[route];
  for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`Unsupported option for ${route}: ${key}`);
  if (extra && !["task item", "decision set", "lesson record"].includes(route)) throw new Error(`Unexpected argument: ${extra}`);
  if (!extra && ["task item", "decision set", "lesson record"].includes(route)) throw new Error(`${route} requires an item/decision/lesson id`);

  const current = await client.get();
  // --- Read-only routes ------------------------------------------------------
  if (!Number.isSafeInteger(current?.revision) || !current?.state?.tasks) throw new Error("Remote coordination returned invalid canonical state");
  const state = current.state;
  const previous = state.tasks[id];
  if (route === "task show") return { ok: true, result: previous ?? null };
  if (route === "task next") { if (!previous) throw new Error(`Unknown task: ${id}`); return { ok: true, result: { id, phase: previous.phase, gate: previous.gate, status: previous.status }, nextAction: remoteAction(nextAction(previous, root)) }; }
  if (route === "task ready") { if (!previous) throw new Error(`Unknown task: ${id}`); return { ok: true, result: { id, ...readyTaskItems(previous) }, nextAction: remoteAction(nextAction(previous, root)) }; }
  if (route === "phase context") {
    if (!previous) throw new Error(`Unknown task: ${id}`);
    const packet = compileContext(root, previous, option("--phase") ?? previous.phase, { mode: option("--mode") ?? "standard", itemId: option("--item") });
    const warning = "Fleet lifecycle authority: use remote-state.mjs for task, evidence, decision, lesson, and gate commands. Lead credentials cannot approve gates; only a reviewer using AIDLC_FLEET_REVIEWER_TOKEN may run gate approve after explicit user assent.\n\n";
    const content = warning + remoteCommand(packet.content);
    return { ok: true, result: { ...packet, content, chars: content.length, estimatedTokens: Math.ceil(content.length / 4), canonicalRevision: current.revision } };
  }
  if (route === "gate check") {
    if (!previous) throw new Error(`Unknown task: ${id}`);
    const gate = option("--gate") ?? previous.gate;
    if (!gateNames.has(gate)) throw new Error("Gate must be G0_confirm, G1_review, or G2_codereview");
    const diagnostics = checkGate(root, state, id, gate);
    return { ok: !diagnostics.some((item) => item.level === "ERROR"), result: { taskId: id, gate, diagnostics } };
  }
  if (route === "gate snapshot") {
    if (!previous) throw new Error(`Unknown task: ${id}`);
    const gate = required(option("--gate"), "--gate");
    if (!gateNames.has(gate) || previous.gate !== gate || previous.status !== "blocked_on_user") throw new Error("Task is not waiting at the requested gate");
    const reviewFile = required(option("--review-file"), "--review-file");
    const reviewText = await readFile(reviewFile, "utf8");
    if (!reviewText.trim() || reviewText.length > 20000) throw new Error("Review text must contain 1–20000 characters");
    const integrationCommit = gate === "G2_codereview" ? await (git.readRemoteRef ?? readIntegrationCommit)({ projectRoot: root, integrationBranch: git.integrationBranch, gitRemote: git.gitRemote }) : undefined;
    return { ok: true, result: await client.snapshot(current.revision, id, gate, reviewText, integrationCommit) };
  }

  // --- Mutating routes -------------------------------------------------------
  let task;
  if (route === "task create") {
    if (previous || state.archive?.[id]) throw new Error(`Task already exists: ${id}`);
    if (Object.keys({ ...state.tasks, ...state.archive }).some((key) => key.toLowerCase() === id.toLowerCase())) throw new Error("Task id collides case-insensitively");
    const title = required(option("--title"), "--title");
    const featureId = option("--feature");
    if (featureId) {
      const manifest = await client.featureGet(featureId);
      if (manifest?.feature && !manifest.feature.tasks.some((member) => member.id === id)) throw new Error(`Task ${id} is not declared in feature ${featureId}; run feature link first`);
    }
    const recordedAt = now();
    task = { id, title, ...(featureId ? { featureId } : {}), type: option("--type") ?? "infra", phase: "clarify", gate: "G0_confirm", status: "active",
      language: option("--language") === "en" ? "en" : "vi", risk: option("--risk") ?? "normal",
      areas: (option("--area") ?? "root").split(",").map((item) => item.trim()).filter(Boolean), branch: "—",
      artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, design: `.agents/data/tasks/${id}/design.md`, workplan: `.agents/data/tasks/${id}/workplan.md` },
      decisions: [], tasks: [], evidence: [], createdAt: recordedAt, updatedAt: recordedAt };
  } else {
    if (!previous) throw new Error(`Unknown task: ${id}`);
    task = structuredClone(previous);
    if (task.status === "blocked_on_user" && !["evidence add", "task status", "task handoff", "task close"].includes(route)) throw new Error("Task is frozen at a human gate");
    if (route === "task status") {
      const status = required(option("--status"), "--status");
      if (!statuses.has(status)) throw new Error("Invalid task status");
      if (task.status === "blocked_on_user" && status !== "blocked_on_user") {
        if (option("--mode") !== "audited") throw new Error("Cancelling a human-gate wait requires --mode audited");
        const reason = required(option("--reason"), "--reason"); const source = required(option("--source"), "--source");
        task.evidence.push({ kind: "diagnostic", result: "pass", source, detail: `Cancelled gate wait at ${task.gate}: ${reason}`, recordedAt: now() });
      }
      if (task.status === "active" && status === "paused") {
        if (option("--mode") !== "audited") throw new Error("Pausing active work requires --mode audited");
        const reason = required(option("--reason"), "--reason"); const source = required(option("--source"), "--source");
        task.evidence.push({ kind: "diagnostic", result: "pass", source, detail: `Paused while active: ${reason}`, recordedAt: now() });
      }
      if (status === "blocked_on_user") {
        const diagnostics = checkGate(root, state, id, task.gate).filter((item) => item.level === "ERROR");
        if (diagnostics.length) throw new Error(`Gate is not ready: ${diagnostics.map((item) => item.code).join(", ")}`);
      }
      task.status = status;
    } else if (route === "task handoff") {
      const clone = structuredClone(state); clone.tasks[id] = task;
      task = handoffTask(clone, id, required(option("--kind"), "--kind"), required(option("--reason"), "--reason"), required(option("--source"), "--source"));
    } else if (route === "task close") {
      const clone = structuredClone(state); clone.tasks[id] = task;
      task = closeTask(clone, id, required(option("--reason"), "--reason"), required(option("--source"), "--source"));
    } else if (route === "task reopen") {
      const clone = structuredClone(state); clone.tasks[id] = task;
      task = reopenTask(clone, id, required(option("--to"), "--to"), required(option("--reason"), "--reason"), required(option("--source"), "--source"));
    } else if (route === "task item") {
      const status = required(option("--status"), "--status");
      if (!itemStatuses.has(status)) throw new Error("Invalid item status");
      const item = task.tasks.find((entry) => entry.id === extra);
      const split = (name) => option(name)?.split(",").map((entry) => entry.trim()).filter(Boolean);
      if (item) { item.status = status; if (options.has("--label")) item.label = option("--label"); if (options.has("--depends-on")) item.dependsOn = split("--depends-on"); if (options.has("--owns")) item.ownedPaths = split("--owns"); }
      else task.tasks.push({ id: extra, label: option("--label") ?? extra, status, ...(split("--depends-on") ? { dependsOn: split("--depends-on") } : {}), ...(split("--owns") ? { ownedPaths: split("--owns") } : {}) });
      readyTaskItems(task);
    } else if (route === "task transition") {
      if (option("--mode") !== "audited") throw new Error("Transition requires --mode audited");
      const reason = required(option("--reason"), "--reason"); const source = required(option("--source"), "--source");
      const target = required(option("--to"), "--to");
      if (target === "done" && task.featureId) {
        const manifest = await client.featureGet(task.featureId);
        const member = manifest?.feature?.tasks?.find((entry) => entry.id === id);
        if (!member) throw new Error(`Task ${id} is missing from feature ${task.featureId}`);
        const waitingOn = member.dependsOn.filter((dependency) => (state.tasks[dependency] ?? state.archive?.[dependency])?.status !== "done");
        if (waitingOn.length) throw new Error(`Feature prerequisites incomplete for ${id}: ${waitingOn.join(", ")}`);
      }
      const clone = structuredClone(state); clone.tasks[id] = task;
      transitionTask(clone, id, target);
      task = clone.tasks[id];
      task.evidence.push({ kind: "diagnostic", result: "pass", source, detail: `Audited transition ${previous.phase} → ${target}: ${reason}`, recordedAt: now() });
    } else if (route === "decision set") {
      const status = required(option("--status"), "--status");
      if (!["unresolved", "approved", "changed", "dropped"].includes(status)) throw new Error("Invalid decision status");
      const decision = task.decisions.find((entry) => entry.id === extra);
      if (decision) { decision.status = status; if (options.has("--label")) decision.label = option("--label"); if (options.has("--resolution")) decision.resolution = option("--resolution"); }
      else task.decisions.push({ id: extra, label: option("--label") ?? extra, status, resolution: option("--resolution") });
    } else if (route === "evidence add") {
      const kind = required(option("--kind"), "--kind"); const result = required(option("--result"), "--result");
      if (!evidenceKinds.has(kind) || !results.has(result)) throw new Error("Invalid evidence kind or result");
      const area = option("--area");
      if (area && !task.areas.includes(area)) throw new Error("Evidence area must belong to task");
      if (["test", "lint"].includes(kind) && task.areas.length > 1 && !area) throw new Error("Multi-area verification requires --area");
      task.evidence.push({ kind, gate: option("--gate"), area, result, source: option("--source") ?? "fleet lead", detail: option("--detail"), recordedAt: now() });
    } else if (route === "lesson record") {
      recordLesson(task, { id: extra, areas: (option("--area") ?? task.areas.join(",")).split(",").map((entry) => entry.trim()).filter(Boolean), summary: option("--summary"), prevention: option("--prevention"), example: option("--example"), promotion: option("--promotion") ?? "not promoted", source: required(option("--source"), "--source") });
    } else if (route === "lesson none") {
      recordNoLessons(task, required(option("--reason"), "--reason"), required(option("--source"), "--source"));
    }
    task.updatedAt = now();
  }
  const candidate = structuredClone(state); candidate.tasks[id] = task; validateState(candidate);
  const saved = await client.apply(current.revision, id, task);
  const canonical = saved?.state?.tasks?.[id];
  if (!Number.isSafeInteger(saved?.revision) || !canonical) throw new Error("Remote coordination did not confirm the mutation");
  return { ok: true, result: { task: canonical, revision: saved.revision }, nextAction: remoteAction(saved.nextActions?.[id] ?? nextAction(canonical, root)) };
};

export const runRemoteReview = async (argv, client, git = {}) => {
  const { positionals: args, options, option } = parse(argv);
  const [group, action, taskId] = args;
  if (group !== "gate" || !["inbox", "approve"].includes(action)) throw new Error("Reviewer commands are gate inbox and gate approve");
  if (action === "inbox") {
    if (taskId || options.size) throw new Error("gate inbox takes no arguments");
    return { ok: true, result: await client.inbox() };
  }
  required(taskId, "task id");
  if (args.length !== 3 || [...options.keys()].some((key) => !["--snapshot", "--source"].includes(key))) throw new Error("Usage: gate approve <task-id> --snapshot <id> --source <explicit user message>");
  const snapshotId = required(option("--snapshot"), "--snapshot");
  const source = required(option("--source"), "--source");
  const current = await client.get();
  if (!Number.isSafeInteger(current?.revision) || !current.state?.tasks?.[taskId]) throw new Error("Task is absent from canonical remote state");
  const inbox = await client.inbox();
  if (!Array.isArray(inbox)) throw new Error("Remote gate inbox returned invalid data");
  const snapshot = inbox.find((entry) => entry.id === snapshotId && entry.taskId === taskId);
  if (!snapshot || current.state.tasks[taskId].gate !== snapshot.gate || current.state.tasks[taskId].status !== "blocked_on_user") throw new Error("Gate snapshot is stale or does not match the waiting task");
  let integrationCommit;
  if (snapshot.gate === "G2_codereview") {
    if (!/^[a-f0-9]{40}$/i.test(snapshot.integrationCommit ?? "")) throw new Error("G2 snapshot has no valid integration commit");
    integrationCommit = await (git.readRemoteRef ?? readIntegrationCommit)({ projectRoot: git.projectRoot, integrationBranch: git.integrationBranch, gitRemote: git.gitRemote });
    if (integrationCommit !== snapshot.integrationCommit.toLowerCase()) throw new Error("Integration branch remote ref changed since G2 snapshot; review a fresh snapshot");
  }
  const saved = await client.approve(current.revision, taskId, snapshotId, source, integrationCommit);
  const task = saved?.state?.tasks?.[taskId];
  if (!Number.isSafeInteger(saved?.revision) || !task) throw new Error("Remote coordination did not confirm gate approval");
  return { ok: true, result: { task, revision: saved.revision }, nextAction: remoteAction(saved.nextActions?.[taskId]) };
};

export const runRemoteFeature = async (argv, client) => {
  const { positionals: args, options, option } = parse(argv);
  const [group, action, featureId, taskId] = args;
  if (group !== "feature" || !["create", "show", "ready", "link"].includes(action)) throw new Error("Unsupported remote feature command");
  required(featureId, "feature id");
  if (taskId && action !== "link") throw new Error(`Unexpected task id for feature ${action}`);
  if (action === "link") required(taskId, "task id");
  const allowed = { create: ["--branch", "--tasks"], show: [], ready: [], link: ["--depends-on"] }[action];
  for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`Unsupported option: ${key}`);
  const current = await client.featureGet(featureId);
  if (!Number.isSafeInteger(current?.revision)) throw new Error("Remote feature service returned invalid revision");
  const feature = current.feature;
  if (action === "show") return { ok: true, result: feature };
  if (action === "ready") {
    if (!feature) throw new Error(`Unknown feature: ${featureId}`);
    const ready = await client.featureReady(featureId);
    if (!Number.isSafeInteger(ready?.stateRevision) || !Array.isArray(ready.items)) throw new Error("Remote feature readiness unavailable");
    return { ok: true, result: { feature, ...ready } };
  }
  let next;
  if (action === "create") {
    if (feature) throw new Error(`Feature already exists: ${featureId}`);
    const tasks = required(option("--tasks"), "--tasks").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!tasks.length || new Set(tasks).size !== tasks.length) throw new Error("Feature requires unique initial tasks");
    const canonical = await client.get();
    if (!canonical?.state?.tasks) throw new Error("Remote lifecycle state unavailable");
    for (const id of tasks) if (canonical.state.tasks[id]?.featureId !== featureId) throw new Error(`Create canonical task ${id} with --feature ${featureId} before feature create`);
    next = { schemaVersion: 1, id: featureId, integrationBranch: required(option("--branch"), "--branch"), tasks: tasks.map((id) => ({ id, dependsOn: [] })) };
  } else {
    if (!feature) throw new Error(`Unknown feature: ${featureId}`);
    const canonical = await client.get();
    if (!canonical?.state?.tasks) throw new Error("Remote lifecycle state unavailable");
    if (canonical.state.tasks[taskId] && canonical.state.tasks[taskId].featureId !== featureId) throw new Error(`Declare feature membership before task creation: ${taskId}`);
    next = structuredClone(feature);
    const dependsOn = (option("--depends-on") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const member = next.tasks.find((entry) => entry.id === taskId);
    if (member) member.dependsOn = dependsOn;
    else next.tasks.push({ id: taskId, dependsOn });
  }
  const saved = await client.featureApply(current.revision, next);
  const canonical = saved?.fleet?.features?.[featureId];
  if (!canonical) throw new Error("Remote feature service did not confirm manifest mutation");
  return { ok: true, result: { feature: canonical, revision: saved.revision } };
};

export const runRemoteLease = async (argv, client) => {
  const { positionals: args, options, option } = parse(argv);
  const [group, action, taskId] = args;
  if (group !== "run" || !["claim", "release"].includes(action) || args.length !== 3) throw new Error("Usage: run claim <task-id> [--lease-ms <ms>] | run release <task-id> --epoch <n>");
  required(taskId, "task id");
  const allowed = action === "claim" ? ["--lease-ms"] : ["--epoch"];
  for (const key of options.keys()) if (!allowed.includes(key)) throw new Error(`Unsupported option: ${key}`);
  const current = await client.fleetGet();
  if (!Number.isSafeInteger(current?.revision) || !current.fleet?.leads) throw new Error("Remote fleet state unavailable");
  if (action === "claim") {
    const leaseMs = option("--lease-ms") === undefined ? 300000 : Number(option("--lease-ms"));
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 60000 || leaseMs > 3600000) throw new Error("--lease-ms must be 60000..3600000");
    const saved = await client.runClaim(current.revision, taskId, leaseMs);
    const lease = saved?.fleet?.leads?.[taskId];
    if (!Number.isSafeInteger(lease?.epoch) || !lease.expiresAt) throw new Error("Remote fleet service did not confirm lead claim");
    return { ok: true, result: { taskId, epoch: lease.epoch, expiresAt: lease.expiresAt, fleetRevision: saved.revision } };
  }
  const epoch = Number(required(option("--epoch"), "--epoch"));
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("--epoch must be a positive integer");
  const saved = await client.runRelease(current.revision, taskId, epoch);
  if (!Number.isSafeInteger(saved?.revision)) throw new Error("Remote fleet service did not confirm lead release");
  return { ok: true, result: { taskId, epoch, fleetRevision: saved.revision, released: true } };
};

const isEntry = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;
if (isEntry) {
  try {
    const argv = process.argv.slice(2);
    const isReview = argv[0] === "gate" && ["inbox", "approve"].includes(argv[1]);
    const config = isReview ? reviewerConfig() : ["feature", "run"].includes(argv[0]) ? featureConfig() : remoteConfig();
    const result = isReview ? await runRemoteReview(argv, createRemoteReviewerClient(config), config) : argv[0] === "feature" ? await runRemoteFeature(argv, createRemoteStateClient(config)) : argv[0] === "run" ? await runRemoteLease(argv, createRemoteStateClient(config)) : await runRemoteState(argv, createRemoteStateClient(config), config.projectRoot, config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message, code: error.code, currentRevision: error.current?.revision }, null, 2)); process.exitCode = 1; }
}
