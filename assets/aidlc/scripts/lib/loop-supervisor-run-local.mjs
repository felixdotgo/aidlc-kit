import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireLocalAuthority } from "./authority.mjs";
import { runAgentTurn, isLoopProvider, LOOP_PROVIDER_LIST } from "./loop-drivers.mjs";
import { readLoopRecord, runLoop, validateRoot } from "./loop-runtime.mjs";
import { runSupervisor } from "./loop-supervisor.mjs";
import { createLocalSupervisorAdapter } from "./loop-supervisor-local.mjs";
import { readyTaskItems } from "./store.mjs";
import { runLocalWorkerBatch } from "./loop-local-workers.mjs";
import { ensureWorkerImage, defaultWorkerImageTag } from "./loop-worker-image.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Bind the canonical local store, distinct supervisor lease and the existing
 * leased runner. The caller owns process supervision and human gate approval.
 * Abort stops polling or the next turn; the current runLoop call is bounded by
 * its existing timeouts and is not cancelled by this wrapper.
 */
export function createLocalLoopSupervisor({ root: rootInput, taskId, agent, limits, driver = runAgentTurn, preflight = true, pollMs, signal, untilStop = false, onEvent = () => {}, runner = runLoop } = {}) {
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
        const result = await runner({ root, taskId, agent, mode: nextMode, limits, driver, preflight, precondition: expected, onEvent });
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

const workerCredentialKeys = (agent, env = process.env) => {
  if (agent === "codex") return ["OPENAI_API_KEY"];
  if (agent === "claude") return ["ANTHROPIC_API_KEY"];
  // OpenCode authenticates from the environment like codex/claude; the key
  // follows the configured model's provider (opencode-go → OPENCODE_API_KEY).
  const model = env.AIDLC_OPENCODE_MODEL ?? "";
  if (model.startsWith("openai/")) return ["OPENAI_API_KEY"];
  if (model.startsWith("anthropic/")) return ["ANTHROPIC_API_KEY"];
  return ["OPENCODE_API_KEY"];
};

const itemPrompt = (root, taskId, itemId) => {
  const packet = JSON.parse(execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/context.mjs"), taskId, "--phase", "build", "--item", itemId, "--format", "json", "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  if (typeof packet?.content !== "string" || !packet.content.trim()) throw new Error(`Context packet for ${itemId} was empty or invalid`);
  return `${packet.content}\n\nOnly modify the assigned owned paths. Do not modify AI-DLC lifecycle state or approve gates. End with a Conventional Commits message on its own line as AI-DLC-COMMIT: type(scope): subject (for example AI-DLC-COMMIT: docs(ui): add web UI improvement proposal), followed by AI-DLC-ITEM-COMPLETE on its own line.`;
};

/** Fan dependency-ready build items out to Docker-isolated workers, then record
 * each integrated item as done. No worker ever marks canonical progress itself. */
async function dispatchLocalBuild({ root, taskId, task, workers, images, credentials, worktreesRoot, onEvent }) {
  const ready = readyTaskItems(task).ready;
  if (!ready.length) return;
  const providers = Object.entries(workers);
  if (!providers.length) throw new Error("Loop requires a configured lead and worker providers");
  const jobs = ready.map((itemId, index) => {
    const item = task.tasks.find((entry) => entry.id === itemId);
    if (!item || !Array.isArray(item.ownedPaths) || !item.ownedPaths.length) throw new Error(`Build item ${itemId} requires an owned path scope for Docker dispatch`);
    const [workerId, provider] = providers[index % providers.length];
    return { itemId, workerId, agent: provider, prompt: itemPrompt(root, taskId, itemId), ownedPaths: item.ownedPaths };
  });
  // Auto-build any missing per-provider image before dispatch so the user never
  // has to build the worker image by hand.
  const resolvedImages = {};
  for (const provider of new Set(jobs.map((job) => job.agent))) {
    resolvedImages[provider] = ensureWorkerImage({ root, provider, image: images[provider] ?? defaultWorkerImageTag(provider), onEvent });
  }
  const completed = await runLocalWorkerBatch({ root, taskId, jobs, worktreesRoot, docker: { images: resolvedImages, credentials } });
  const lifecycle = (args) => execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), ...args, "--root", root], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  for (const result of completed) {
    const envelope = JSON.parse(lifecycle(["task", "item", taskId, result.itemId, "--status", "done"]));
    if (envelope?.ok !== true) throw new Error(`Failed to mark item ${result.itemId} done`);
  }
}

/**
 * Local end-to-end supervisor: host-executed lead (Codex, Claude Code, or
 * OpenCode) for clarify/plan/wrap, and Docker-isolated workers for build items.
 * Reuses the local supervisor adapter + runSupervisor and the leased runLoop
 * with a build dispatcher wired to runLocalWorkerBatch. Workers only ever
 * receive environment credentials; the host lead and the trusted terminal own
 * gates and lifecycle state.
 */
export function createIsolatedLocalSupervisor({ root: rootInput, taskId, agent, workers = {}, limits, docker, worktreesRoot, workerImages = {}, pollMs, signal, untilStop = false, onEvent = () => {}, runner = runLoop, driver = runAgentTurn, preflight = true } = {}) {
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
        const dispatchBuild = async ({ root, taskId, task }) => dispatchLocalBuild({ root, taskId, task, workers, images, credentials, worktreesRoot: worktrees, onEvent });
        const result = await runner({ root, taskId, agent, mode: nextMode, limits, driver, dispatchBuild, preflight, precondition: expected, onEvent });
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
