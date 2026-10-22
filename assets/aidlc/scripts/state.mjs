#!/usr/bin/env node
import { acquireStateLock, approveAndAdvance, checkGate, closeTask, failEntry, handoffTask, listTaskSummaries, loadMemoryRegistry, loadState, loadTask, migrateState, nextAction, option, parseArguments, promoteAgenticMemory, rebuildLessonIndex, recordLesson, recordNoLessons, renderViews, reopenTask, retireAgenticMemory, rootOption, saveState, searchLessons, supersedeTask, transitionTask, validateArguments } from "./lib/runtime.mjs";
import { readLiveLease } from "./lib/loop-lease.mjs";
import { listFeatures, loadFeature, readyFeatureTasks, saveFeature } from "./lib/feature-store.mjs";
import { readyTaskItems } from "./lib/store.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
requireLocalAuthority();
const raw = process.argv.slice(2);
const valueOptions = ["--root", "--status", "--limit", "--cursor", "--query", "--title", "--type", "--language", "--risk", "--area", "--mode", "--reason", "--source", "--to", "--kind", "--successor", "--label", "--resolution", "--result", "--gate", "--detail", "--summary", "--prevention", "--example", "--promotion", "--guidance", "--phase", "--priority", "--source-task", "--source-lesson", "--approved-by", "--switch-from", "--feature", "--depends-on", "--branch", "--owns"];
const parsed = parseArguments(raw, { valueOptions, booleanOptions: ["--include-archive"] });
const args = parsed.positionals;
const [group, action, rawId] = args;
const id = rawId;
const schemas = {
  "state migrate": { minPositionals: 2 },
  "task show": { minPositionals: 2, maxPositionals: 3, valueOptions: ["--status", "--limit", "--cursor"], booleanOptions: ["--include-archive"] },
  "task list": { minPositionals: 2, valueOptions: ["--status", "--limit", "--cursor"], booleanOptions: ["--include-archive"] },
  "task find": { minPositionals: 2, valueOptions: ["--query", "--status", "--limit", "--cursor"], booleanOptions: ["--include-archive"], requiredOptions: ["--query"] },
  "task next": { minPositionals: 3 },
  "task ready": { minPositionals: 3 },
  "task create": { minPositionals: 3, valueOptions: ["--title", "--type", "--language", "--risk", "--area", "--switch-from", "--feature", "--depends-on"], requiredOptions: ["--title"] },
  "task transition": { minPositionals: 3, valueOptions: ["--mode", "--reason", "--source", "--to"], requiredOptions: ["--mode", "--reason", "--source", "--to"], usage: "task transition requires --mode audited, --reason, --source, and --to" },
  "task archive": { minPositionals: 3, valueOptions: ["--reason", "--source"], requiredOptions: ["--reason", "--source"] },
  "task handoff": { minPositionals: 3, valueOptions: ["--kind", "--reason", "--source"], requiredOptions: ["--kind", "--reason", "--source"] },
  "task close": { minPositionals: 3, valueOptions: ["--reason", "--source"], requiredOptions: ["--reason", "--source"] },
  "task supersede": { minPositionals: 3, valueOptions: ["--successor", "--reason", "--source"], requiredOptions: ["--successor", "--reason", "--source"] },
  "task reopen": { minPositionals: 3, valueOptions: ["--to", "--reason", "--source"], requiredOptions: ["--to", "--reason", "--source"] },
  "task status": { minPositionals: 3, valueOptions: ["--status", "--mode", "--reason", "--source"], requiredOptions: ["--status"] },
  "task item": { minPositionals: 4, valueOptions: ["--status", "--label", "--depends-on", "--owns"], requiredOptions: ["--status"] },
  "feature create": { minPositionals: 3, valueOptions: ["--branch"], requiredOptions: ["--branch"] },
  "feature show": { minPositionals: 3 },
  "feature ready": { minPositionals: 3 },
  "feature link": { minPositionals: 4, valueOptions: ["--depends-on"] },
  "decision set": { minPositionals: 4, valueOptions: ["--status", "--label", "--resolution"], requiredOptions: ["--status"] },
  "evidence add": { minPositionals: 3, valueOptions: ["--kind", "--result", "--gate", "--area", "--source", "--detail"], requiredOptions: ["--kind", "--result"] },
  "lesson record": { minPositionals: 4, valueOptions: ["--area", "--summary", "--prevention", "--example", "--promotion", "--source"] },
  "lesson none": { minPositionals: 3, valueOptions: ["--reason", "--source"], requiredOptions: ["--reason", "--source"] },
  "lesson rebuild": { minPositionals: 2 },
  "lesson search": { minPositionals: 2, valueOptions: ["--query", "--area", "--limit"] },
  "memory list": { minPositionals: 2 },
  "memory promote": { minPositionals: 3, valueOptions: ["--summary", "--guidance", "--area", "--phase", "--priority", "--source-task", "--source-lesson", "--approved-by"], requiredOptions: ["--summary", "--guidance", "--source-task", "--source-lesson", "--approved-by"] },
  "memory retire": { minPositionals: 3, valueOptions: ["--reason", "--approved-by"], requiredOptions: ["--reason", "--approved-by"] },
  "gate approve": { minPositionals: 3, valueOptions: ["--gate", "--source"], requiredOptions: ["--gate", "--source"] }
};
const usage = "Usage: state.mjs state migrate | task create|show|list|find|next|ready|status|item|transition|archive|handoff|close|supersede|reopen | feature create|show|ready|link | decision set | evidence add | lesson record|none|search|rebuild | memory list|promote|retire | gate approve";
const schema = schemas[`${group ?? ""} ${action ?? ""}`];
if (!schema) throw new Error(usage);
validateArguments(parsed, { ...schema, maxPositionals: schema.maxPositionals ?? schema.minPositionals, usage: schema.usage ?? usage });
const root = rootOption(parsed);
const releaseStateLock = acquireStateLock(root);
let released = false;
const releaseOnce = () => { if (!released) { releaseStateLock(); released = true; } };
process.once("exit", releaseOnce);
try {
const state = loadState(root);
const now = () => new Date().toISOString();
const numberOption = (name, fallback) => {
  const rawValue = option(parsed, name);
  if (rawValue === undefined) return fallback;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const summaryOptions = (query) => ({
  includeArchive: parsed.flags.has("--include-archive"),
  statuses: option(parsed, "--status")?.split(",").map((item) => item.trim()).filter(Boolean),
  query,
  limit: numberOption("--limit", 20),
  cursor: numberOption("--cursor", 0)
});
const warnings = [];
const derivedStep = (code, hint, step) => { try { step(); } catch (error) { warnings.push({ code, message: error instanceof Error ? error.message : String(error), hint }); } };
const persist = (tasks, rebuildLessons = false) => {
  const archived = saveState(root, state);
  if (rebuildLessons || archived.length) derivedStep("LESSON_INDEX_STALE", "restore the damaged archive record from git history, then run state.mjs lesson rebuild", () => rebuildLessonIndex(root, state));
  derivedStep("RENDER_FAILED", "fix the reported path, then run render.mjs <task-id>", () => renderViews(root, state, tasks.filter(Boolean)));
};
const emit = (result, task) => console.log(JSON.stringify({ ok: true, ...(result === undefined ? {} : { result }), ...(warnings.length ? { warnings } : {}), ...(task ? { nextAction: nextAction(task, root) } : {}) }, null, 2));
const respond = (task, result = {}) => emit({ task, ...result }, task);
const requireFeaturePrerequisites = (task) => {
  if (!task) throw new Error("Unknown active task");
  if (!task.featureId) return;
  const feature = loadFeature(root, task.featureId, state);
  const member = feature?.tasks.find((entry) => entry.id === task.id);
  if (!member) throw new Error(`Task is missing from feature manifest: ${task.id}`);
  const waitingOn = member.dependsOn.filter((dependency) => (state.tasks[dependency] ?? state.archive?.[dependency])?.status !== "done");
  if (waitingOn.length) throw new Error(`Feature prerequisites incomplete for ${task.id}: ${waitingOn.join(", ")}`);
};

if (group === "state" && action === "migrate") {
  emit(migrateState(root, state));
} else if (group === "task" && action === "show") {
  if (id) { const shown = loadTask(root, id, state) ?? null; emit(shown, shown ?? undefined); }
  else emit(listTaskSummaries(state, summaryOptions()));
} else if (group === "task" && action === "list") {
  emit(listTaskSummaries(state, summaryOptions()));
} else if (group === "task" && action === "find") {
  const query = option(parsed, "--query");
  if (!query) throw new Error("task find requires --query");
  emit(listTaskSummaries(state, summaryOptions(query)));
} else if (group === "task" && action === "next") {
  const task = loadTask(root, id, state);
  if (!task) throw new Error(`Unknown task: ${id}`);
  emit({ id: task.id, phase: task.phase, gate: task.gate, status: task.status }, task);
} else if (group === "task" && action === "ready") {
  const task = loadTask(root, id, state);
  if (!task) throw new Error(`Unknown task: ${id}`);
  emit({ id, ...readyTaskItems(task) }, task);
} else if (group === "feature" && action === "create") {
  if (loadFeature(root, id, state)) throw new Error(`Feature already exists: ${id}`);
  emit(saveFeature(root, { schemaVersion: 1, id, integrationBranch: option(parsed, "--branch"), tasks: [] }, state));
} else if (group === "feature" && action === "show") {
  const feature = loadFeature(root, id, state);
  if (!feature) throw new Error(`Unknown feature: ${id}`);
  emit(feature);
} else if (group === "feature" && action === "ready") {
  const feature = loadFeature(root, id, state);
  if (!feature) throw new Error(`Unknown feature: ${id}`);
  emit(readyFeatureTasks(feature, state));
} else if (group === "feature" && action === "link") {
  const taskId = args[3]; const feature = loadFeature(root, id, state); const task = state.tasks[taskId];
  if (!feature || !task) throw new Error(`Unknown feature or active task: ${id}/${taskId}`);
  if (task.featureId && task.featureId !== id) throw new Error(`Task belongs to another feature: ${taskId}`);
  if (listFeatures(root, state).some((other) => other.id !== id && other.tasks.some((entry) => entry.id === taskId))) throw new Error(`Task belongs to another feature: ${taskId}`);
  const dependsOn = (option(parsed, "--depends-on") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const entry = feature.tasks.find((item) => item.id === taskId);
  if (entry) entry.dependsOn = dependsOn; else feature.tasks.push({ id: taskId, dependsOn });
  saveFeature(root, feature, state);
  task.featureId = id; task.updatedAt = now(); persist([task]); respond(task, { feature });
} else if (group === "task" && action === "create") {
  const title = option(parsed, "--title");
  if (!id || !title) throw new Error("task create requires <task-id> and --title");
  if (loadTask(root, id, state)) throw new Error(`Task already exists: ${id}; use task next ${id} to resume it`);
  const collision = [...Object.keys(state.tasks), ...Object.keys(state.archive ?? {})].find((existing) => existing.toLowerCase() === id.toLowerCase());
  if (collision) throw new Error(`Task id collides case-insensitively with existing task: ${collision}`);
  const actionable = Object.values(state.tasks).filter((existing) => nextAction(existing, root).classification === "run_phase").map((existing) => existing.id).sort();
  const actionableByLowercase = new Map(actionable.map((existing) => [existing.toLowerCase(), existing]));
  const acknowledgedTokens = [...new Set((option(parsed, "--switch-from") ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  const unknownAcknowledgement = acknowledgedTokens.filter((ack) => !actionableByLowercase.has(ack.toLowerCase()));
  if (unknownAcknowledgement.length) throw new Error(`--switch-from must name only actionable task(s); not actionable: ${unknownAcknowledgement.join(", ")}`);
  const acknowledged = [...new Set(acknowledgedTokens.map((ack) => actionableByLowercase.get(ack.toLowerCase())))];
  const featureId = option(parsed, "--feature");
  const feature = featureId ? loadFeature(root, featureId, state) : undefined;
  if (featureId && !feature) throw new Error(`Unknown feature: ${featureId}`);
  const stranded = actionable.filter((existing) => !acknowledged.includes(existing) && (!feature || state.tasks[existing].featureId !== featureId));
  if (stranded.length) throw new Error(`Task create is blocked while other work is actionable: ${stranded.join(", ")}. With explicit user direction to switch, rerun with --switch-from ${actionable.join(",")}; acknowledged tasks keep their state and remain the resume target`);
  const recordedAt = now();
  const task = state.tasks[id] = {
    id, title, featureId, type: option(parsed, "--type") ?? "infra", phase: "clarify", gate: "G0_confirm", status: "active",
    language: option(parsed, "--language") === "en" ? "en" : "vi", risk: option(parsed, "--risk") ?? "normal",
    areas: (option(parsed, "--area") ?? "root").split(",").map((area) => area.trim()).filter(Boolean), branch: "—",
    artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, design: `.agents/data/tasks/${id}/design.md`, workplan: `.agents/data/tasks/${id}/workplan.md` },
    decisions: [], tasks: [], evidence: [], createdAt: recordedAt, updatedAt: recordedAt
  };
  const acknowledgedTasks = acknowledged.map((ack) => state.tasks[ack]);
  for (const prior of acknowledgedTasks) {
    prior.evidence.push({ kind: "diagnostic", result: "pass", source: `task create ${id}`, detail: `Switch acknowledged: created ${id} while ${prior.id} was actionable; ${prior.id} keeps its state — resume with task next ${prior.id}`, recordedAt });
    prior.updatedAt = recordedAt;
  }
  if (feature) {
    const dependsOn = (option(parsed, "--depends-on") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    feature.tasks.push({ id, dependsOn });
    saveFeature(root, feature, state);
  }
  persist([task, ...acknowledgedTasks]); respond(task);
} else if (group === "task" && action === "transition") {
  const mode = option(parsed, "--mode"); const reason = option(parsed, "--reason"); const source = option(parsed, "--source");
  if (mode !== "audited" || !reason?.trim() || !source?.trim()) throw new Error("task transition requires --mode audited, --reason, and --source");
  const from = state.tasks[id]?.phase; const target = option(parsed, "--to"); if (target === "done") requireFeaturePrerequisites(state.tasks[id]); const task = transitionTask(state, id, target);
  task.evidence.push({ kind: "diagnostic", result: "pass", source, detail: `Audited transition ${from} → ${target}: ${reason}`, recordedAt: now() });
  persist([task]); respond(task);
} else if (group === "task" && action === "archive") {
  const reason = option(parsed, "--reason"); const source = option(parsed, "--source");
  if (!reason?.trim() || !source?.trim()) throw new Error("task archive requires --reason and --source");
  requireFeaturePrerequisites(state.tasks[id]); const task = transitionTask(state, id, "done");
  task.evidence.push({ kind: "diagnostic", result: "pass", source, detail: `Archive to done: ${reason}`, recordedAt: now() });
  persist([task], true); respond(task);
} else if (group === "task" && action === "handoff") {
  const task = handoffTask(state, id, option(parsed, "--kind"), option(parsed, "--reason"), option(parsed, "--source"));
  persist([task]); respond(task);
} else if (group === "task" && action === "close") {
  const task = closeTask(state, id, option(parsed, "--reason"), option(parsed, "--source"));
  persist([task]); respond(task);
} else if (group === "task" && action === "supersede") {
  const task = supersedeTask(state, id, option(parsed, "--successor"), option(parsed, "--reason"), option(parsed, "--source")); const successor = state.tasks[task.successorTaskId];
  persist([task, successor]); respond(task, { successor });
} else if (group === "task" && action === "reopen") {
  const task = reopenTask(state, id, option(parsed, "--to"), option(parsed, "--reason"), option(parsed, "--source"));
  persist([task]); respond(task);
} else if (group === "task" && action === "status") {
  const task = state.tasks[id]; const status = option(parsed, "--status");
  if (!task || !["active", "blocked_on_user", "paused"].includes(status)) throw new Error("task status requires an active task id and --status active|blocked_on_user|paused; finishing a task uses task transition --to done or task archive");
  const leavingGateWait = task.status === "blocked_on_user" && status !== "blocked_on_user";
  const recoveringGatelessWrap = leavingGateWait && task.phase === "wrap" && task.gate === "none" && status === "active";
  if (leavingGateWait && !recoveringGatelessWrap) {
    const mode = option(parsed, "--mode"); const reason = option(parsed, "--reason"); const cancelSource = option(parsed, "--source");
    if (mode !== "audited" || !reason?.trim() || !cancelSource?.trim()) throw new Error("Cancelling a human-gate wait requires --mode audited, --reason, and --source (e.g. the user's rejection message)");
    task.evidence.push({ kind: "diagnostic", result: "pass", source: cancelSource, detail: `Cancelled gate wait at ${task.gate}: ${reason}`, recordedAt: now() });
  }
  const enteringPause = status === "paused" && task.status === "active";
  if (enteringPause) {
    const mode = option(parsed, "--mode"); const reason = option(parsed, "--reason"); const pauseSource = option(parsed, "--source");
    if (mode !== "audited" || !reason?.trim() || !pauseSource?.trim()) throw new Error("Pausing an active task requires --mode audited, --reason, and --source");
    task.evidence.push({ kind: "diagnostic", result: "pass", source: pauseSource, detail: `Paused while active: ${reason}`, recordedAt: now() });
  }
  if (status === "blocked_on_user") {
    if (task.gate === "none") throw new Error("Phase wrap has no human gate; continue wrap and finish with task transition --to done or task archive");
    const errors = checkGate(root, state, id, task.gate).filter((item) => item.level === "ERROR");
    if (errors.length) throw new Error(`Gate is not ready: ${errors.map((item) => `${item.code}: ${item.message}`).join("; ")}`);
  }
  if (leavingGateWait) delete task.legacyG2Wait;
  task.status = status; task.updatedAt = now(); persist([task]); respond(task);
} else if (group === "task" && action === "item") {
  const itemId = args[3]; const task = state.tasks[id]; const status = option(parsed, "--status");
  if (!task || !itemId || !["todo", "in_progress", "done", "deferred"].includes(status)) throw new Error("task item requires active task id, item id, and valid --status");
  const item = task.tasks.find((entry) => entry.id === itemId);
  const dependsOn = parsed.present.has("--depends-on") ? (option(parsed, "--depends-on") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
  const ownedPaths = parsed.present.has("--owns") ? (option(parsed, "--owns") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
  if (item) { item.status = status; if (parsed.present.has("--label")) item.label = option(parsed, "--label"); if (dependsOn) item.dependsOn = dependsOn; if (ownedPaths) item.ownedPaths = ownedPaths; }
  else task.tasks.push({ id: itemId, label: option(parsed, "--label") ?? itemId, status, ...(dependsOn ? { dependsOn } : {}), ...(ownedPaths ? { ownedPaths } : {}) });
  readyTaskItems(task);
  task.updatedAt = now(); persist([task]); respond(task);
} else if (group === "decision" && action === "set") {
  const decisionId = args[3]; const task = state.tasks[id]; const status = option(parsed, "--status");
  if (!task || !decisionId || !["unresolved", "approved", "changed", "dropped"].includes(status)) throw new Error("decision set requires active task id, decision id, and valid --status");
  const current = task.decisions.find((entry) => entry.id === decisionId);
  if (current) { current.status = status; if (parsed.present.has("--label")) current.label = option(parsed, "--label"); if (parsed.present.has("--resolution")) current.resolution = option(parsed, "--resolution"); }
  else task.decisions.push({ id: decisionId, label: option(parsed, "--label") ?? decisionId, status, resolution: option(parsed, "--resolution") });
  task.updatedAt = now(); persist([task]); respond(task);
} else if (group === "evidence" && action === "add") {
  const task = state.tasks[id]; const kind = option(parsed, "--kind"); const result = option(parsed, "--result");
  if (!task || !["spec", "test", "lint", "review", "diagnostic"].includes(kind) || !["pass", "fail", "skip"].includes(result)) throw new Error("evidence add requires active task id, non-approval --kind, and valid --result; approvals use gate approve");
  const area = option(parsed, "--area");
  if (area && !task.areas.includes(area)) throw new Error(`Evidence area must belong to task.areas: ${area}`);
  if (["test", "lint"].includes(kind) && task.areas.length > 1 && !area) throw new Error("Test and lint evidence for multi-area tasks requires --area");
  task.evidence.push({ kind, gate: option(parsed, "--gate"), area, result, source: option(parsed, "--source") ?? "local Node.js script", detail: option(parsed, "--detail"), recordedAt: now() });
  task.updatedAt = now(); persist([task]); respond(task);
} else if (group === "lesson" && action === "record") {
  const lessonId = args[3]; const task = state.tasks[id];
  if (!task || !lessonId) throw new Error("lesson record requires active task id and lesson id");
  const source = option(parsed, "--source");
  const lesson = recordLesson(task, { id: lessonId, areas: (option(parsed, "--area") ?? task.areas.join(",")).split(",").map((item) => item.trim()).filter(Boolean), summary: option(parsed, "--summary"), prevention: option(parsed, "--prevention"), example: option(parsed, "--example"), promotion: option(parsed, "--promotion") ?? "not promoted", source });
  persist([task], true); respond(task, { lesson });
} else if (group === "lesson" && action === "none") {
  const task = state.tasks[id]; if (!task) throw new Error("lesson none requires active task id");
  recordNoLessons(task, option(parsed, "--reason"), option(parsed, "--source")); persist([task], true); respond(task, { lessonDisposition: task.lessonDisposition });
} else if (group === "lesson" && action === "rebuild") {
  emit(rebuildLessonIndex(root, state));
} else if (group === "lesson" && action === "search") {
  emit(searchLessons(root, state, option(parsed, "--query") ?? "", (option(parsed, "--area") ?? "").split(",").map((item) => item.trim()).filter(Boolean), numberOption("--limit", 5)));
} else if (group === "memory" && action === "list") {
  emit(loadMemoryRegistry(root));
} else if (group === "memory" && action === "promote") {
  const entry = promoteAgenticMemory(root, {
    id: args[2], summary: option(parsed, "--summary"), guidance: option(parsed, "--guidance"),
    areas: (option(parsed, "--area") ?? "*").split(",").map((item) => item.trim()).filter(Boolean),
    phases: (option(parsed, "--phase") ?? "*").split(",").map((item) => item.trim()).filter(Boolean),
    priority: numberOption("--priority", 50), sourceTaskId: option(parsed, "--source-task"), sourceLessonId: option(parsed, "--source-lesson"), approvedBy: option(parsed, "--approved-by"), approvedAt: now()
  });
  emit(entry);
} else if (group === "memory" && action === "retire") {
  const entry = retireAgenticMemory(root, args[2], option(parsed, "--reason"), option(parsed, "--approved-by"));
  emit(entry);
} else if (group === "gate" && action === "approve") {
  const gate = option(parsed, "--gate"); const source = option(parsed, "--source");
  if (!id || !gate || !source) throw new Error("gate approve requires active task id, --gate, and explicit --source");
  if (readLiveLease(root, id)) throw new Error(`Gate approval is unavailable while loop runner owns ${id}; wait for the runner to stop at the human gate`);
  const outcome = approveAndAdvance(root, state, id, gate, source); persist([outcome.task]); emit({ task: outcome.task, idempotent: outcome.idempotent }, outcome.task);
} else {
  throw new Error(usage);
}
} finally {
  process.off("exit", releaseOnce);
  releaseOnce();
}
} catch (error) { failEntry(error); }
