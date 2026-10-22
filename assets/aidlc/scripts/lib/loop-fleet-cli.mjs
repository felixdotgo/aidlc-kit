import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runAgentTurn } from "./loop-drivers.mjs";
import { runFleetCoordinator, runFleetWorker, validateFleetLimits } from "./loop-fleet.mjs";
import { createFleetRemoteRepository } from "./loop-fleet-remote.mjs";
import { createLeadGitHandoff, createWorkerGitHandoff } from "./loop-git.mjs";

const required = (env, name) => { const value = env[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Package-local entrypoint. The service wrapper supplies its MCP HTTP client. */
export async function runFleetCli(argv, { callTool, env = process.env, out = console.log, signal } = {}) {
  const [role, targetId, ...flags] = argv;
  if (!["coordinator", "feature", "worker"].includes(role) || ((role === "coordinator" || role === "feature") && !targetId) || flags.some((arg) => arg !== "--once")) throw new Error("Usage: aidlc-fleet coordinator <task-id> [--once] | feature <feature-id> [--once] | worker [--once]");
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
  const emit = (event) => out(JSON.stringify(event));
  if (role === "worker") {
    const workerId = required(env, "AIDLC_FLEET_WORKER_ID");
    const handoff = createWorkerGitHandoff({ root, worktreesRoot: resolve(required(env, "AIDLC_FLEET_WORKTREES_ROOT")), remote });
    for (;;) {
      if (signal?.aborted) return { status: "stopped" };
      const result = await runFleetWorker({ repository, workerId, limits, driver: runAgentTurn, handoff, packet: async ({ job, snapshot }) => [
        `AI-DLC worker assignment ${job.assignmentId}, attempt ${job.attempt}.`,
        `Task: ${snapshot.task.title} (${job.taskId}). Item: ${job.itemId}.`,
        `Only change these owned paths: ${job.ownedPaths.join(", ")}.`,
        `Base commit: ${job.baseCommit}. Assigned branch: ${job.branch}.`,
        "Complete the scoped item and report remaining risks. The supervisor handles the Git commit and push.",
        ...(env.AIDLC_FLEET_CODE_ONLY_RETRY === "1" ? ["This assignment is declared code-only: perform no external side effects beyond the supervisor's Git handoff."] : [])
      ].join("\n"), onEvent: emit });
      emit(result);
      if (once) return result;
      await pause(pollMs);
    }
  }
  const workerIds = required(env, "AIDLC_FLEET_WORKER_IDS").split(",").map((value) => value.trim()).filter(Boolean);
  const agent = env.AIDLC_FLEET_AGENT ?? "codex";
  if (!["codex", "claude"].includes(agent)) throw new Error("AIDLC_FLEET_AGENT must be codex or claude");
  const handoff = createLeadGitHandoff({ root, integrationBranch: required(env, "AIDLC_FLEET_INTEGRATION_BRANCH"), remote, agent });
  const remoteState = join(root, ".agents/aidlc/scripts/remote-state.mjs");
  if (!existsSync(remoteState)) throw new Error(`Remote lifecycle CLI is missing: ${remoteState}`);
  const runTask = async (taskId, reservedJobs = []) => runFleetCoordinator({ repository, taskId, ownerId: env.AIDLC_FLEET_LEAD_ID ?? "lead", workerIds, reservedJobs, allowCodeOnlyRetry: env.AIDLC_FLEET_CODE_ONLY_RETRY === "1", pollMs, limits, handoff, completeItem: repository.completeItem,
      packet: async (snapshot, leadEpoch) => {
        const fleetEnv = { ...env, AIDLC_FLEET_LEAD_EPOCH: String(leadEpoch) };
        const raw = execFileSync(process.execPath, [remoteState, "phase", "context", taskId], { cwd: root, env: fleetEnv, encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        const packet = JSON.parse(raw);
        if (packet?.ok !== true || typeof packet.result?.content !== "string" || !packet.result.content) throw new Error("Remote phase context is empty or invalid");
        return `${packet.result.content}\n\nFleet supervisor: canonical nextAction is ${JSON.stringify(snapshot.nextAction)}. Use only remote-state.mjs for lifecycle commands. Never approve a gate.`;
      },
      driver: async ({ leadEpoch, prompt, timeoutMs, signal: turnSignal }) => {
        return runAgentTurn({ agent, root, prompt, timeoutMs, signal: turnSignal, env: { ...env, AIDLC_FLEET_LEAD_EPOCH: String(leadEpoch) }, onEvent: emit });
      }, onEvent: emit });
  for (;;) {
    if (signal?.aborted) return { status: "stopped" };
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
      }
      const stopped = results.some((entry) => ["blocked", "reconcile", "paused", "terminal"].includes(entry.status));
      const result = { status: !ready.length || stopped ? "blocked" : "active", featureId: targetId, results, blockedTaskIds: readiness.items.filter((member) => !member.ready && member.blockers.length).map((member) => member.taskId) };
      if (once || result.status === "blocked") return result;
      await pause(pollMs);
      continue;
    }
    const result = await runTask(targetId);
    emit(result);
    if (once || ["terminal", "complete", "blocked", "paused", "reconcile"].includes(result.status)) return result;
    await pause(pollMs);
  }
}
