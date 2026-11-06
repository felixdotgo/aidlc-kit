import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireLocalAuthority } from "./authority.mjs";
import { runAgentTurn, isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";
import { readLoopRecord, runLoop, validateRoot } from "./loop-runtime.mjs";
import { runSupervisor } from "./loop-supervisor.mjs";
import { createLocalSupervisorAdapter } from "./loop-supervisor-local.mjs";
import { pathsOverlap, readyTaskItems, selectBuildBatch } from "./store.mjs";
import { runLocalWorkerBatch } from "./loop-local-workers.mjs";
import { reconcileLocalAssignments } from "./assignment-store.mjs";
import { ensureWorkerImage, defaultWorkerImageTag } from "./loop-worker-image.mjs";
import { workerCredentialKeys } from "./loop-worker-docker.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Bind the canonical local store, distinct supervisor lease and the existing
 * leased runner. The caller owns process supervision and human gate approval.
 * `signal` stops polling and asks runLoop to stop at its next turn boundary;
 * `cancelSignal` also cancels the in-flight agent turn. Both end as `stopped`.
 */
export function createLocalLoopSupervisor({ root: rootInput, taskId, agent, limits, driver = runAgentTurn, preflight = true, pollMs, signal, cancelSignal, untilStop = false, onEvent = () => {}, runner = runLoop } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!isLoopProvider(agent)) throw new Error(`local lead agent must be ${LOOP_PROVIDER_LIST}`);
  if (typeof driver !== "function" || typeof runner !== "function" || typeof onEvent !== "function") throw new Error("invalid local supervisor callbacks");
  const adapter = createLocalSupervisorAdapter({ root, taskId });
  const getRecord = () => readLoopRecord(root, taskId);
  const execute = async (mode) => {
    requireLocalAuthority();
    const record = getRecord();
    if (mode === "run" && record) throw new Error("Local loop record already exists; use resume");
    if (mode === "resume" && !record) throw new Error("Local loop record missing; use start");
    if (record && record.agent !== agent) throw new Error("Resume must use the recorded lead agent");
    let nextMode = mode;
    return runSupervisor({ taskId, authority: "local", ...adapter, pollMs, signal, untilStop, onEvent,
      runTurn: async ({ precondition }) => {
        if (signal?.aborted) return { status: "stopped", taskId };
        requireLocalAuthority();
        let expected = precondition;
        if (!expected) {
          const snapshot = await adapter.readTask({ taskId });
          if (snapshot.task.status !== "active" || snapshot.nextAction.classification !== "run_phase") return { status: "blocked", taskId, reason: "Canonical state changed before runner acquired lease" };
          expected = { taskId, phase: snapshot.task.phase, taskHash: digest(snapshot.task), evidenceHash: digest(snapshot.task.evidence), evidenceCount: snapshot.task.evidence.length };
        }
        const result = await runner({ root, taskId, agent, mode: nextMode, limits, driver, preflight, precondition: expected, onEvent, signal, cancelSignal });
        nextMode = "resume";
        return result;
      }
    });
  };
  return {
    start: () => execute("run"),
    resume: () => execute("resume"),
    async status() {
      requireLocalAuthority();
      const snapshot = await adapter.readTask({ taskId });
      return { taskId, authority: "local", record: getRecord(), nextAction: snapshot.nextAction };
    }
  };
}


const itemPrompt = (root, taskId, itemId) => {
  const packet = JSON.parse(execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/context.mjs"), taskId, "--phase", "build", "--item", itemId, "--format", "json", "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  if (typeof packet?.content !== "string" || !packet.content.trim()) throw new Error(`Context packet for ${itemId} was empty or invalid`);
  return `${packet.content}\n\nOnly modify the assigned owned paths. Do not modify AI-DLC lifecycle state or approve gates. End with a Conventional Commits message on its own line as AI-DLC-COMMIT: type(scope): subject (for example AI-DLC-COMMIT: docs(ui): add web UI improvement proposal), followed by AI-DLC-ITEM-COMPLETE on its own line.`;
};

const ACTIVE_ASSIGNMENT_STATES = new Set(["leased", "reported", "uncertain"]);
const UNRESOLVED_ASSIGNMENT_STATES = new Set(["reported", "uncertain"]);

/**
 * Pure batch planner for local build dispatch. Selects at most one item per
 * worker from the dependency-ready items, skipping (deferring) items whose
 * owned paths overlap each other or an active assignment, and items whose own
 * prior assignment is unresolved. Overlap never throws: an overlapping item
 * simply waits for a later batch. Throws only for a plan error (ready item
 * without owned paths) or when every ready item is blocked by an active
 * assignment, naming those assignments so a human can inspect them.
 */
export function planLocalBuildBatch({ taskId, task, workers, assignments = [] }) {
  const ready = readyTaskItems(task).ready;
  if (!ready.length) return { jobs: [], deferred: [] };
  const providers = Object.entries(workers ?? {});
  if (!providers.length) throw new Error("Loop requires a configured lead and worker providers");
  const byId = new Map(task.tasks.map((item) => [item.id, item]));
  for (const itemId of ready) {
    const item = byId.get(itemId);
    if (!item || !Array.isArray(item.ownedPaths) || !item.ownedPaths.length) throw new Error(`Build item ${itemId} requires an owned path scope for Docker dispatch`);
  }
  const active = assignments.filter((entry) => ACTIVE_ASSIGNMENT_STATES.has(entry.state));
  const busyPaths = active.flatMap((entry) => entry.ownedPaths ?? []);
  const unresolvedItems = [...new Set(active.filter((entry) => UNRESOLVED_ASSIGNMENT_STATES.has(entry.state) && byId.get(entry.itemId)?.status !== "done").map((entry) => entry.itemId))];
  const { selected, deferred } = selectBuildBatch(task, { capacity: providers.length, busyPaths, exclude: unresolvedItems });
  if (!selected.length) {
    // Every ready item is held back by an assignment; never auto-release it.
    const blocking = active.filter((entry) => ready.some((itemId) => entry.itemId === itemId || pathsOverlap(byId.get(itemId).ownedPaths, entry.ownedPaths ?? [])));
    const details = blocking.map((entry) => `${entry.state === "leased" ? "Active" : "Unresolved"} assignment ${entry.id} (${entry.state}) for ${entry.itemId} holds ${(entry.ownedPaths ?? []).join(", ")}`).join("; ");
    throw new Error(`${details || `No ready build item of ${taskId} could be dispatched`}; inspect it, then run node .agents/aidlc/scripts/assignment.mjs reconcile ${taskId} or node .agents/aidlc/scripts/assignment.mjs release ${taskId} <assignment-id>`);
  }
  const jobs = selected.map((itemId, index) => {
    const [workerId, agent] = providers[index];
    return { itemId, workerId, agent, ownedPaths: [...byId.get(itemId).ownedPaths] };
  });
  return { jobs, deferred };
}

const markItemDone = (root, taskId, itemId) => {
  const envelope = JSON.parse(execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "item", taskId, itemId, "--status", "done", "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  if (envelope?.ok !== true) throw new Error(`Failed to mark item ${itemId} done`);
};

/** Fan dependency-ready build items out to Docker-isolated workers, then record
 * each integrated item as done. No worker ever marks canonical progress itself.
 * Overlapping or excess ready items are deferred to a later batch, not failed.
 * The trailing hooks exist for tests; production uses the defaults. */
export async function dispatchLocalBuild({ root, taskId, task, workers, images = {}, credentials, worktreesRoot, onEvent = () => {}, cancelSignal, runBatch = runLocalWorkerBatch, ensureImage = ensureWorkerImage, prompt = itemPrompt, markDone = markItemDone }) {
  // Reconcile completed items first so their owned paths are released for the
  // next batch: an integrated item's assignment stays `reported` (still active)
  // until reconciled, and overlapping owned paths would otherwise block the next
  // claim even though the item is already done.
  const { assignments } = reconcileLocalAssignments(root, taskId);
  const { jobs: planned, deferred } = planLocalBuildBatch({ taskId, task, workers, assignments });
  if (!planned.length) return;
  for (const { id, reason } of deferred) await onEvent({ type: "build_deferred", taskId, itemId: id, reason });
  const jobs = planned.map((job) => ({ ...job, prompt: prompt(root, taskId, job.itemId) }));
  // Auto-build any missing per-provider image before dispatch so the user never
  // has to build the worker image by hand.
  const resolvedImages = {};
  for (const provider of new Set(jobs.map((job) => job.agent))) {
    resolvedImages[provider] = ensureImage({ root, provider, image: images[provider] ?? defaultWorkerImageTag(provider), onEvent });
  }
  const completed = await runBatch({ root, taskId, jobs, worktreesRoot, docker: { images: resolvedImages, credentials }, signal: cancelSignal });
  for (const result of completed) markDone(root, taskId, result.itemId);
}

/**
 * Local end-to-end supervisor: host-executed lead (Codex, Claude Code, or
 * OpenCode) for clarify/plan/wrap, and Docker-isolated workers for build items.
 * Reuses the local supervisor adapter + runSupervisor and the leased runLoop
 * with a build dispatcher wired to runLocalWorkerBatch. Workers only ever
 * receive environment credentials; the host lead and the trusted terminal own
 * gates and lifecycle state.
 */
export function createIsolatedLocalSupervisor({ root: rootInput, taskId, agent, workers = {}, limits, docker, worktreesRoot, workerImages = {}, pollMs, signal, cancelSignal, untilStop = false, onEvent = () => {}, runner = runLoop, driver = runAgentTurn, preflight = true } = {}) {
  requireLocalAuthority();
  const root = validateRoot(rootInput);
  if (!isLoopProvider(agent)) throw new Error(`local lead agent must be ${LOOP_PROVIDER_LIST}`);
  if (!workers || typeof workers !== "object" || Array.isArray(workers) || !Object.keys(workers).length) throw new Error("Loop requires a configured lead and worker providers");
  for (const [id, provider] of Object.entries(workers)) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !isLoopProvider(provider)) throw new Error(`invalid local worker: ${id}`);
  const adapter = createLocalSupervisorAdapter({ root, taskId });
  const getRecord = () => readLoopRecord(root, taskId);
  const images = Object.fromEntries([...new Set(Object.values(workers))].map((provider) => [provider, docker?.images?.[provider] ?? docker?.image ?? workerImages?.[provider] ?? process.env.AIDLC_WORKER_DOCKER_IMAGE ?? defaultWorkerImageTag(provider)]));
  const credentials = docker?.credentials ?? Object.fromEntries([...new Set(Object.values(workers))].map((provider) => [provider, workerCredentialKeys(provider)]));
  const worktrees = resolve(worktreesRoot ?? process.env.AIDLC_LOCAL_WORKTREES_ROOT ?? join(tmpdir(), "aidlc-local-worktrees"));
  const execute = async (mode) => {
    requireLocalAuthority();
    const record = getRecord();
    if (mode === "run" && record) throw new Error("Local loop record already exists; use resume");
    if (mode === "resume" && !record) throw new Error("Local loop record missing; use start");
    if (record && record.agent !== agent) throw new Error("Resume must use the recorded lead agent");
    let nextMode = mode;
    return runSupervisor({ taskId, authority: "local", ...adapter, pollMs, signal, untilStop, onEvent,
      runTurn: async ({ precondition }) => {
        if (signal?.aborted) return { status: "stopped", taskId };
        requireLocalAuthority();
        let expected = precondition;
        if (!expected) {
          const snapshot = await adapter.readTask({ taskId });
          if (snapshot.task.status !== "active" || snapshot.nextAction.classification !== "run_phase") return { status: "blocked", taskId, reason: "Canonical state changed before runner acquired lease" };
          expected = { taskId, phase: snapshot.task.phase, taskHash: digest(snapshot.task), evidenceHash: digest(snapshot.task.evidence), evidenceCount: snapshot.task.evidence.length };
        }
        const dispatchBuild = async ({ root, taskId, task }) => dispatchLocalBuild({ root, taskId, task, workers, images, credentials, worktreesRoot: worktrees, onEvent, cancelSignal });
        const result = await runner({ root, taskId, agent, mode: nextMode, limits, driver, dispatchBuild, preflight, precondition: expected, onEvent, signal, cancelSignal });
        nextMode = "resume";
        return result;
      }
    });
  };
  return {
    start: () => execute("run"),
    resume: () => execute("resume"),
    async status() {
      requireLocalAuthority();
      const snapshot = await adapter.readTask({ taskId });
      return { taskId, authority: "local", record: getRecord(), nextAction: snapshot.nextAction };
    }
  };
}
