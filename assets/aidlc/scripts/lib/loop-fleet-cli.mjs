import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { isLoopProvider, LOOP_PROVIDER_LIST, runAgentTurn } from "./loop-drivers.mjs";
import { runFleetCoordinator, runFleetWorker, validateFleetLimits } from "./loop-fleet.mjs";
import { runFleetSupervisor } from "./loop-fleet-supervisor.mjs";
import { createFleetRemoteRepository } from "./loop-fleet-remote.mjs";
import { createLeadGitHandoff, createIsolatedWorkerGitHandoff } from "./loop-git.mjs";
import { workerDockerInvocation, workerCredentialKeys } from "./loop-worker-docker.mjs";
import { defaultWorkerImageTag, ensureWorkerImage, validWorkerImageTag } from "./loop-worker-image.mjs";

const required = (env, name) => { const value = env[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; };
/** Sleep `ms`, resolving early once any given signal aborts. */
const pause = (ms, ...signals) => new Promise((resolve) => {
  const live = signals.filter(Boolean);
  if (live.some((signal) => signal.aborted)) return resolve();
  const done = () => { clearTimeout(timer); for (const signal of live) signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  for (const signal of live) signal.addEventListener("abort", done, { once: true });
});
const provider = (value, name) => { if (!isLoopProvider(value)) throw new Error(`${name} must be ${LOOP_PROVIDER_LIST}`); return value; };
const pendingFeedback = (task) => {
  const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
  const pending = [];
  for (let i = 0; i < evidence.length; i++) {
    const entry = evidence[i];
    if (entry?.kind !== "diagnostic" || typeof entry.detail !== "string") continue;
    const match = entry.detail.match(/^Cancelled gate wait at (G0_confirm|G1_review|G2_codereview): /);
    if (!match) continue;
    const approvedAfter = evidence.slice(i + 1).some((later) => later?.kind === "approval" && later.result === "pass" && later.gate === match[1]);
    if (!approvedAfter) pending.push(entry.detail);
  }
  return pending;
};
function workerMapping(env, workerIds, defaultAgent) {
  if (!env.AIDLC_FLEET_WORKER_PROVIDERS) return Object.fromEntries(workerIds.map((id) => [id, defaultAgent]));
  let mapping;
  try { mapping = JSON.parse(env.AIDLC_FLEET_WORKER_PROVIDERS); } catch { throw new Error("AIDLC_FLEET_WORKER_PROVIDERS must be a JSON object"); }
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || Object.keys(mapping).length !== workerIds.length || workerIds.some((id) => !Object.hasOwn(mapping, id) || !isLoopProvider(mapping[id])) || Object.keys(mapping).some((id) => !workerIds.includes(id))) throw new Error(`AIDLC_FLEET_WORKER_PROVIDERS must map every configured worker ID to ${LOOP_PROVIDER_LIST}`);
  return mapping;
}
/** This worker's provider: AIDLC_FLEET_WORKER_AGENT, else its entry in
 * AIDLC_FLEET_WORKER_PROVIDERS (keyed by worker ID), else AIDLC_FLEET_AGENT
 * (the lead's provider — only a last resort, so a copied lead env cannot
 * override this worker's own mapping), else undefined. */
function workerProvider(env, workerId) {
  if (env.AIDLC_FLEET_WORKER_AGENT !== undefined) return provider(env.AIDLC_FLEET_WORKER_AGENT, "AIDLC_FLEET_WORKER_AGENT");
  if (env.AIDLC_FLEET_WORKER_PROVIDERS) {
    let mapping;
    try { mapping = JSON.parse(env.AIDLC_FLEET_WORKER_PROVIDERS); } catch { throw new Error("AIDLC_FLEET_WORKER_PROVIDERS must be a JSON object"); }
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("AIDLC_FLEET_WORKER_PROVIDERS must be a JSON object");
    if (Object.hasOwn(mapping, workerId)) return provider(mapping[workerId], `AIDLC_FLEET_WORKER_PROVIDERS["${workerId}"]`);
  }
  return env.AIDLC_FLEET_AGENT === undefined ? undefined : provider(env.AIDLC_FLEET_AGENT, "AIDLC_FLEET_AGENT");
}

/** Worker image tag: explicit AIDLC_WORKER_DOCKER_IMAGE, else the project's
 * `.agents/config.json` `loop.workerImage[provider]`, else the default tag
 * (built from the shipped Dockerfile when missing). */
function workerImageTag({ env, root, agent, onEvent }) {
  const requested = env.AIDLC_WORKER_DOCKER_IMAGE;
  if (typeof requested === "string" && requested.trim()) return requested;
  if (!agent) throw new Error("AIDLC_WORKER_DOCKER_IMAGE is required when the worker provider is unknown; set AIDLC_FLEET_WORKER_AGENT (or this worker's AIDLC_FLEET_WORKER_PROVIDERS entry) to use the default worker image, or build one with `aidlc-kit loop worker-image --provider <provider>` and set the env var");
  const configPath = join(root, ".agents", "config.json");
  let configured;
  if (existsSync(configPath)) {
    let config;
    try { config = JSON.parse(readFileSync(configPath, "utf8")); } catch { throw new Error(`Invalid project config: ${configPath}`); }
    configured = config?.loop?.workerImage?.[agent];
    if (configured !== undefined && !validWorkerImageTag(configured)) throw new Error(`Invalid loop.workerImage.${agent} in ${configPath}`);
  }
  const image = configured ?? defaultWorkerImageTag(agent);
  return ensureWorkerImage({ root, provider: agent, image, env, onEvent });
}

/** Package-local entrypoint. The service wrapper supplies its MCP HTTP client.
 * `signal` stops after the current turn; `cancelSignal` also aborts the
 * in-flight agent turn (result status `stopped`). `onEvent(event)` receives
 * every emitted event object instead of `out(JSON.stringify(event))`.
 * `untilStop` applies to role `supervisor` only (see runFleetSupervisor). */
export async function runFleetCli(argv, { callTool, env = process.env, out = console.log, onEvent, signal, cancelSignal, untilStop = false, coordinator: coordinatorOverride } = {}) {
  const [role, targetId, ...flags] = argv;
  if (!["coordinator", "feature", "worker", "supervisor"].includes(role) || ((role === "coordinator" || role === "feature" || role === "supervisor") && !targetId) || flags.some((arg) => arg !== "--once") || (role === "supervisor" && flags.length) || (role === "worker" && targetId && targetId !== "--once")) throw new Error("Usage: aidlc-fleet coordinator <task-id> [--once] | feature <feature-id> [--once] | supervisor <task-id> | worker [--once]");
  const once = flags.includes("--once") || (role === "worker" && targetId === "--once");
  if (role === "worker" && targetId && targetId !== "--once") throw new Error("worker accepts no task ID");
  const root = resolve(required(env, "AIDLC_FLEET_PROJECT_ROOT"));
  const url = required(env, "AIDLC_FLEET_URL");
  const token = required(env, "AIDLC_FLEET_TOKEN");
  const workspace = required(env, "AIDLC_FLEET_WORKSPACE");
  const remote = env.AIDLC_FLEET_GIT_REMOTE ?? "origin";
  const limits = validateFleetLimits({
    ...(env.AIDLC_FLEET_MAX_TURNS ? { maxTurns: Number(env.AIDLC_FLEET_MAX_TURNS) } : {}),
    ...(env.AIDLC_FLEET_TURN_TIMEOUT_MS ? { turnTimeoutMs: Number(env.AIDLC_FLEET_TURN_TIMEOUT_MS) } : {}),
    ...(env.AIDLC_FLEET_MAX_STALL_TURNS ? { maxStallTurns: Number(env.AIDLC_FLEET_MAX_STALL_TURNS) } : {}),
    ...(env.AIDLC_FLEET_MAX_WORKERS ? { maxWorkers: Number(env.AIDLC_FLEET_MAX_WORKERS) } : {}),
    ...(env.AIDLC_FLEET_LEASE_MS ? { leaseMs: Number(env.AIDLC_FLEET_LEASE_MS) } : {}),
    ...(env.AIDLC_FLEET_HEARTBEAT_MS ? { heartbeatMs: Number(env.AIDLC_FLEET_HEARTBEAT_MS) } : {})
  });
  const repository = createFleetRemoteRepository({ callTool, url, token, workspace, root, workerId: env.AIDLC_FLEET_WORKER_ID });
  const pollMs = env.AIDLC_FLEET_POLL_MS ? Number(env.AIDLC_FLEET_POLL_MS) : 5000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 300000) throw new Error("AIDLC_FLEET_POLL_MS must be 1000..300000");
  if (env.AIDLC_FLEET_CODE_ONLY_RETRY && !["0", "1"].includes(env.AIDLC_FLEET_CODE_ONLY_RETRY)) throw new Error("AIDLC_FLEET_CODE_ONLY_RETRY must be 0 or 1");
  const emit = typeof onEvent === "function" ? (event) => onEvent(event) : (event) => out(JSON.stringify(event));
  const stopRequested = () => Boolean(signal?.aborted || cancelSignal?.aborted);
  if (role === "worker") {
    const workerId = required(env, "AIDLC_FLEET_WORKER_ID");
    const workerAgent = workerProvider(env, workerId);
    const requestedImage = workerImageTag({ env, root, agent: workerAgent, onEvent: emit });
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(requestedImage)) throw new Error("Invalid Docker worker image");
    const image = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", requestedImage], {env:{PATH:env.PATH ?? "/usr/bin:/bin"},encoding:"utf8",timeout:30000,stdio:["ignore","pipe","ignore"]}).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Docker worker image lacks immutable image ID");
    const uid = process.getuid?.(), gid = process.getgid?.();
    if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new Error("Docker worker requires a non-root host uid and gid");
    const preflight = async (agent) => {
      const empty = mkdtempSync(join(tmpdir(), "aidlc-worker-preflight-"));
      try {
        const invocation = workerDockerInvocation({workspace:empty,image,command:agent,args:["--version"],credentialEnv:workerCredentialKeys(agent, env),hostEnv:env,uid,gid});
        execFileSync("docker", ["info"], {env:{PATH:invocation.env.PATH},stdio:"ignore",timeout:30000});
        execFileSync("docker", ["image","inspect",image], {env:{PATH:invocation.env.PATH},stdio:"ignore",timeout:30000});
        const name = `aidlc-worker-preflight-${randomUUID()}`;
        const args = invocation.args.filter((arg,index) => !(index===1 && arg==="--rm"));
        args.splice(1,0,"--name",name);
        let failure;
        try { execFileSync(invocation.command, args, {env:invocation.env,stdio:"ignore",timeout:30000}); }
        catch (error) { failure = error; }
        try { execFileSync("docker",["rm","--force",name],{env:{PATH:invocation.env.PATH},stdio:"ignore",timeout:30000}); }
        catch { throw new Error("Could not confirm Docker preflight container removal"); }
        if (failure) throw failure;
      } finally { rmSync(empty,{recursive:true,force:true}); }
    };
    if (workerAgent) await preflight(workerAgent);
    const baseHandoff = createIsolatedWorkerGitHandoff({ root, worktreesRoot: resolve(required(env, "AIDLC_FLEET_WORKTREES_ROOT")), remote });
    const sessions = new Map();
    const cleanupSession = (workspace) => { const current=sessions.get(workspace.root); if(current) { rmSync(current.home,{recursive:true,force:true}); sessions.delete(workspace.root); } };
    const handoff = {
      ...baseHandoff,
      async prepare(job) {
        const workspace=await baseHandoff.prepare(job);
        const home=mkdtempSync(join(tmpdir(),"aidlc-worker-home-")); chmodSync(home,0o700);
        sessions.set(workspace.root,{home,agent:job.agent,assignmentId:job.assignmentId,attempt:job.attempt,epoch:job.epoch,workerId,image,sessionId:null});
        return workspace;
      },
      async finish(args) { try { return await baseHandoff.finish(args); } finally { cleanupSession(args.workspace); } },
      async discard(args) { try { return await baseHandoff.discard(args); } finally { cleanupSession(args.workspace); } }
    };
    const isolatedDriver = async (turn) => {
      const session=sessions.get(turn.root);
      if (!session || session.agent !== turn.agent || (turn.sessionId && turn.sessionId !== session.sessionId)) throw new Error("Docker worker session is not recoverable; reconcile this assignment");
      const credentialEnv = workerCredentialKeys(turn.agent, env);
      const name = `aidlc-worker-${randomUUID()}`;
      let started = false;
      try {
        const result = await runAgentTurn({...turn, root:"/workspace", env, spawnProcess: (command,args,options) => {
          const invocation=workerDockerInvocation({workspace:turn.root,image,command,args,credentialEnv,hostEnv:env,uid,gid,sessionHome:session.home});
          const dockerArgs=invocation.args.filter((arg,index) => !(index===1 && arg==="--rm"));
          dockerArgs.splice(1,0,"--name",name);
          started = true;
          return spawn(invocation.command,dockerArgs,{...options,cwd:turn.root,env:invocation.env});
        }});
        session.sessionId=result.sessionId;
        return result;
      } finally {
        if (started) {
          try { execFileSync("docker",["rm","--force",name],{env:{PATH:env.PATH ?? "/usr/bin:/bin"},stdio:"ignore",timeout:30000}); }
          catch { throw new Error("Could not confirm isolated Docker worker removal; reconcile before continuing"); }
        }
      }
    };
    for (;;) {
      if (stopRequested()) return { status: "stopped" };
      let result;
      try { result = await runFleetWorker({ repository, workerId, workerAgent, preflight, limits, driver: isolatedDriver, handoff, cancelSignal, packet: async ({ job, snapshot }) => [
        `AI-DLC worker assignment ${job.assignmentId}, attempt ${job.attempt}.`,
        `Task: ${snapshot.task.title} (${job.taskId}). Item: ${job.itemId}.`,
        `Only change these owned paths: ${job.ownedPaths.join(", ")}.`,
        `Base commit: ${job.baseCommit}. Assigned branch: ${job.branch}.`,
        "Complete the scoped item and report remaining risks. The supervisor handles the Git commit and push. End the final answer with a Conventional Commits message on its own line as AI-DLC-COMMIT: type(scope): subject (for example AI-DLC-COMMIT: docs(ui): add web UI improvement proposal), followed by AI-DLC-ITEM-COMPLETE on its own line.",
        ...(env.AIDLC_FLEET_CODE_ONLY_RETRY === "1" ? ["This assignment is declared code-only: perform no external side effects beyond the supervisor's Git handoff."] : [])
      ].join("\n"), onEvent: emit }); }
      finally { for (const [workspace, entry] of sessions) { rmSync(entry.home,{recursive:true,force:true}); sessions.delete(workspace); } }
      emit(result);
      if (once || result.status === "stopped") return result;
      await pause(pollMs, signal, cancelSignal);
    }
  }
  const workerIds = required(env, "AIDLC_FLEET_WORKER_IDS").split(",").map((value) => value.trim()).filter(Boolean);
  const agent = provider(env.AIDLC_FLEET_AGENT ?? "codex", "AIDLC_FLEET_AGENT");
  const workerProviders = workerMapping(env, workerIds, agent);
  const handoff = createLeadGitHandoff({ root, integrationBranch: required(env, "AIDLC_FLEET_INTEGRATION_BRANCH"), remote, agent });
  const remoteState = join(root, ".agents/aidlc/scripts/remote-state.mjs");
  if (!existsSync(remoteState)) throw new Error(`Remote lifecycle CLI is missing: ${remoteState}`);
  const leadTaskFor = (taskId) => ({ ownerId: env.AIDLC_FLEET_LEAD_ID ?? "lead", workerIds, workerProviders, allowCodeOnlyRetry: env.AIDLC_FLEET_CODE_ONLY_RETRY === "1", pollMs, limits, handoff, completeItem: repository.completeItem,
      packet: async (snapshot, leadEpoch) => {
        const fleetEnv = { ...env, AIDLC_FLEET_LEAD_EPOCH: String(leadEpoch), AIDLC_FLEET_LEAD_OWNER_TOKEN: repository.leadOwnerToken() };
        const raw = execFileSync(process.execPath, [remoteState, "phase", "context", taskId], { cwd: root, env: fleetEnv, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        const packet = JSON.parse(raw);
        if (packet?.ok !== true || typeof packet.result?.content !== "string" || !packet.result.content) throw new Error("Remote phase context is empty or invalid");
        const feedback = pendingFeedback(snapshot.task);
        const feedbackBlock = feedback.length ? `Human feedback (revise the current review artifact accordingly, then re-present the gate):\n${feedback.map((text) => `- ${text}`).join("\n")}\n\n` : "";
        return `${feedbackBlock}${packet.result.content}\n\nFleet supervisor: canonical nextAction is ${JSON.stringify(snapshot.nextAction)}. Use only remote-state.mjs for lifecycle commands. Never approve a gate.`;
      },
      driver: async ({ leadEpoch, prompt, timeoutMs, signal: turnSignal }) => {
        return runAgentTurn({ agent, root, prompt, timeoutMs, signal: turnSignal, env: { ...env, AIDLC_FLEET_LEAD_EPOCH: String(leadEpoch), AIDLC_FLEET_LEAD_OWNER_TOKEN: repository.leadOwnerToken() }, onEvent: emit });
      } });
  const runTask = async (taskId, reservedJobs = []) => runFleetCoordinator({ repository, taskId, ...leadTaskFor(taskId), reservedJobs, stopSignal: signal, cancelSignal, onEvent: emit });
  if (role === "supervisor") {
    const result = await runFleetSupervisor({ repository, taskId: targetId, ...leadTaskFor(targetId), signal, cancelSignal, untilStop, onEvent: emit, ...(coordinatorOverride ? { coordinator: coordinatorOverride } : {}) });
    emit(result);
    return result;
  }
  for (;;) {
    if (stopRequested()) return { status: "stopped" };
    if (role === "feature") {
      const feature = await repository.getFeature({ featureId: targetId });
      if (!feature) throw new Error(`Unknown feature ${targetId}`);
      if (feature.integrationBranch !== env.AIDLC_FLEET_INTEGRATION_BRANCH) throw new Error("Feature integration branch differs from configured checkout");
      const readiness = await repository.featureReady({ featureId: targetId });
      const ready = readiness.items.filter((item) => item.ready);
      if (!ready.length && readiness.items.every((item) => !item.blockers.length)) return { status: "complete", featureId: targetId };
      const results = [];
      for (const member of ready) {
        const reservedJobs = (await repository.listAllJobs()).filter((job) => job.taskId !== member.taskId);
        const result = await runTask(member.taskId, reservedJobs);
        results.push(result); emit(result);
        if (result.status === "stopped") return { status: "stopped", featureId: targetId, results };
        if (result.status === "gate") return { status: "gate", featureId: targetId, results, blockedTaskIds: readiness.items.filter((item) => !item.ready && item.blockers.length).map((item) => item.taskId) };
      }
      const stopped = results.some((entry) => ["blocked", "reconcile", "paused", "terminal"].includes(entry.status));
      const result = { status: !ready.length || stopped ? "blocked" : "active", featureId: targetId, results, blockedTaskIds: readiness.items.filter((member) => !member.ready && member.blockers.length).map((member) => member.taskId) };
      if (once || result.status === "blocked") return result;
      await pause(pollMs, signal, cancelSignal);
      continue;
    }
    const result = await runTask(targetId);
    emit(result);
    if (once || ["terminal", "complete", "blocked", "paused", "reconcile", "gate", "stopped"].includes(result.status)) return result;
    await pause(pollMs, signal, cancelSignal);
  }
}
