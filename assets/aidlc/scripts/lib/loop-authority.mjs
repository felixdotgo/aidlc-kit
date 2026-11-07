/**
 * Loop authority adapters: one interface the shared loop daemon, intake, and
 * dashboard actions use for both `local` and `fleet` modes.
 *
 *   mode                                  "local" | "fleet"
 *   listActionable()                      loop-owned tasks whose nextAction is run_phase (oldest first)
 *   runTask({ taskId, signal, cancelSignal, onEvent })
 *                                         one supervised run until a gate, block, pause, completion or stop
 *   intake({ requirement, taskId?, title? })  create a loop-owned task without running it
 *   resumeTask(taskId)                    re-activate a paused task
 *   listTasks() / getTask(id) / gate(id)  read models for the dashboard (fleet)
 *   approve({ taskId, source, reviewerToken })  fleet reviewer approval of the current snapshot
 *   feedback({ taskId, reason, source })  fleet human feedback that keeps the task at its gate
 *                                         (local dashboards call `state.mjs task status` directly)
 *
 * The adapters never approve a gate on their own and never fall back from one
 * authority to the other. Fleet credentials are scoped: the reviewer token is
 * stripped from every lead/worker environment and is passed only to the single
 * `remote-state.mjs gate approve` child of `approve`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireLocalAuthority } from "./authority.mjs";
import { isLoopProvider } from "./loop-drivers.mjs";
import { deriveTaskIdentity, prepareLoopIntake } from "./loop-intake.mjs";
import { readLoopRecord, validateLimits } from "./loop-runtime.mjs";
import { createIsolatedLocalSupervisor } from "./loop-supervisor-run-local.mjs";
import { loadState, loadTask, nextAction } from "./store.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const byUpdatedAt = (a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")) || a.id.localeCompare(b.id);
const tasksDir = (root) => join(root, ".agents", "data", "tasks");

/** The intake record written by `prepareLoopIntake`, or null. */
export function readIntakeRecord(root, taskId) {
  if (!ID.test(taskId ?? "")) return null;
  const path = join(tasksDir(root), taskId, "loop-intake.json");
  try { if (!lstatSync(path).isFile()) return null; return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

const stateError = (error) => {
  const stderr = String(error?.stderr ?? "").trim();
  try { const parsed = JSON.parse(stderr); if (parsed?.error?.message) return new Error(parsed.error.message); } catch { /* not JSON */ }
  return stderr ? new Error(stderr.split("\n").filter(Boolean).at(-1)) : error;
};

/** Pick a unique, case-insensitive task id for an intake that did not name one. */
const uniqueTaskId = (root, slug, takenIds) => {
  const dirs = existsSync(tasksDir(root)) ? readdirSync(tasksDir(root)) : [];
  const existing = new Set([...takenIds, ...dirs].map((id) => id.toLowerCase()));
  const base = slug.slice(0, 120).replace(/-+$/, "") || "loop-task";
  let taskId = slug;
  for (let suffix = 2; existing.has(taskId.toLowerCase()); suffix += 1) taskId = `${base}-${suffix}`;
  return taskId;
};

/** Run intake and roll back the intake files this call created when no task came into being. */
const guardedIntake = async (root, taskId, readTask, body) => {
  const files = [join(tasksDir(root), taskId, "loop-intake.json"), join(tasksDir(root), taskId, "requirement.md")];
  const preexisting = files.map((path) => existsSync(path));
  try { return await body(); }
  catch (error) {
    if (!(await readTask(taskId))) {
      files.forEach((path, index) => { if (!preexisting[index]) { try { unlinkSync(path); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; } } });
      try { rmdirSync(join(tasksDir(root), taskId)); } catch { /* not empty or already gone */ }
    }
    throw error;
  }
};

const validRequirement = (requirement) => {
  if (typeof requirement !== "string" || !requirement.trim() || Buffer.byteLength(requirement) > 8192) throw new Error("Requirement must contain 1–8192 bytes");
};

/* ---------------------------------------------------------------- local */

/** A task is loop-owned locally when it has an intake record or a loop run record. */
export function isLocalLoopOwned(root, taskId) {
  if (!ID.test(taskId ?? "")) return false;
  const record = readIntakeRecord(root, taskId);
  if (record) return record.authority !== "fleet";
  return readLoopRecord(root, taskId) !== null;
}

export function createLocalAuthority({ root, agent, workers = {}, workerImages = {}, limits, pollMs, supervisor = createIsolatedLocalSupervisor } = {}) {
  requireLocalAuthority();
  const stateScript = join(root, ".agents/aidlc/scripts/state.mjs");
  const owned = (id) => { try { return isLocalLoopOwned(root, id); } catch { return true; } };
  return {
    mode: "local",
    isOwned: owned,
    async listActionable() {
      return Object.values(loadState(root).tasks).filter((task) => nextAction(task, root).classification === "run_phase" && owned(task.id)).sort(byUpdatedAt);
    },
    async runTask({ taskId, signal, cancelSignal, onEvent }) {
      const run = supervisor({ root, taskId, agent, workers, workerImages, limits, pollMs, signal, cancelSignal, untilStop: true, onEvent });
      return readLoopRecord(root, taskId) ? run.resume() : run.start();
    },
    /** Interactive work keeps priority: intake refuses while a non-loop task is actionable. */
    async intake({ requirement, taskId: requested, title: requestedTitle }) {
      validRequirement(requirement);
      const identity = deriveTaskIdentity(requirement);
      const state = loadState(root);
      const taskId = requested || uniqueTaskId(root, identity.slug, [...Object.keys(state.tasks), ...Object.keys(state.archive ?? {})]);
      if (!ID.test(taskId)) throw new Error("Valid task ID required");
      const title = requestedTitle || identity.title;
      const actionableIds = (current) => Object.values(current.tasks).filter((task) => task.id !== taskId && nextAction(task, root).classification === "run_phase").map((task) => task.id).sort();
      const interactive = actionableIds(state).filter((id) => !owned(id));
      if (interactive.length) throw new Error(`Task create is blocked while interactive work is actionable: ${interactive.join(", ")}. Finish or pause it before starting loop work`);
      const readTask = async (id) => loadTask(root, id);
      await guardedIntake(root, taskId, readTask, () => prepareLoopIntake({ root, taskId, requirement, title, authority: "local", readTask, createTask: async ({ taskId: id, title: taskTitle }) => {
        const loopOwned = actionableIds(loadState(root)).filter((other) => owned(other));
        try { execFileSync(process.execPath, [stateScript, "task", "create", id, "--title", taskTitle, ...(loopOwned.length ? ["--switch-from", loopOwned.join(",")] : []), "--root", root], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }); }
        catch (error) { throw stateError(error); }
      } }));
      return { ok: true, taskId, title, authority: "local" };
    },
    async resumeTask(taskId) {
      const task = loadTask(root, taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.status !== "paused" || task.handoff) throw new Error(`Only a paused task without a handoff can be resumed (status: ${task.status})`);
      try { return JSON.parse(execFileSync(process.execPath, [stateScript, "task", "status", taskId, "--status", "active", "--root", root], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })); }
      catch (error) { throw stateError(error); }
    }
  };
}

/* ---------------------------------------------------------------- fleet */

const FLEET_REQUIRED = ["AIDLC_FLEET_URL", "AIDLC_FLEET_WORKSPACE", "AIDLC_FLEET_TOKEN", "AIDLC_FLEET_INTEGRATION_BRANCH"];
/** Credentials that must never reach a lead or worker process. */
const REVIEWER_SECRETS = ["AIDLC_FLEET_REVIEWER_TOKEN", "AIDLC_UI_TOKEN", "AIDLC_UI_TOKEN_FILE", "AIDLC_UI_REVIEWER_TOKEN_FILE"];
const LIMIT_ENV = { maxTurns: "AIDLC_FLEET_MAX_TURNS", turnTimeoutMs: "AIDLC_FLEET_TURN_TIMEOUT_MS", maxStallTurns: "AIDLC_FLEET_MAX_STALL_TURNS" };

/** Build the lead environment for fleet runs: validated service settings, the
 * configured roster, `loop.limits`/`loop.pollMs` as defaults (explicit
 * `AIDLC_FLEET_*` env wins), and no reviewer credentials. */
export function fleetLeadEnv({ root, agent, workers, limits, pollMs, env = process.env }) {
  for (const name of FLEET_REQUIRED) if (typeof env[name] !== "string" || !env[name].trim()) throw new Error(`Fleet loop requires ${name} for the configured remote authority`);
  if (env.AIDLC_FLEET_PROJECT_ROOT && resolve(env.AIDLC_FLEET_PROJECT_ROOT) !== root) throw new Error("AIDLC_FLEET_PROJECT_ROOT does not match the loop root; refusing to run");
  const workerIds = Object.keys(workers).join(",");
  if (env.AIDLC_FLEET_WORKER_IDS && env.AIDLC_FLEET_WORKER_IDS.split(",").map((value) => value.trim()).filter(Boolean).join(",") !== workerIds) throw new Error("AIDLC_FLEET_WORKER_IDS does not match the configured loop workers");
  if (env.AIDLC_FLEET_WORKER_PROVIDERS) {
    // Compare content, not the JSON string: key order and spacing do not matter.
    let mapping; try { mapping = JSON.parse(env.AIDLC_FLEET_WORKER_PROVIDERS); } catch { mapping = null; }
    const same = mapping && typeof mapping === "object" && !Array.isArray(mapping) && Object.keys(mapping).length === Object.keys(workers).length && Object.entries(workers).every(([id, provider]) => mapping[id] === provider);
    if (!same) throw new Error("AIDLC_FLEET_WORKER_PROVIDERS does not match the configured loop workers");
  }
  const lead = { ...env, AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_WORKER_IDS: workerIds, AIDLC_FLEET_WORKER_PROVIDERS: JSON.stringify(workers), AIDLC_FLEET_AGENT: agent };
  for (const name of REVIEWER_SECRETS) delete lead[name];
  for (const [key, name] of Object.entries(LIMIT_ENV)) if (limits?.[key] !== undefined && lead[name] === undefined) lead[name] = String(limits[key]);
  if (pollMs !== undefined && lead.AIDLC_FLEET_POLL_MS === undefined) lead.AIDLC_FLEET_POLL_MS = String(pollMs);
  return lead;
}

export async function createFleetAuthority({ root, agent, workers = {}, limits, pollMs, env = process.env, callTool: callToolOverride, runCli } = {}) {
  if (!isLoopProvider(agent)) throw new Error("Loop requires a configured lead and worker providers");
  const leadEnv = fleetLeadEnv({ root, agent, workers, limits, pollMs, env });
  const url = leadEnv.AIDLC_FLEET_URL, token = leadEnv.AIDLC_FLEET_TOKEN, workspace = leadEnv.AIDLC_FLEET_WORKSPACE;
  const remoteState = join(root, ".agents/aidlc/scripts/remote-state.mjs");
  if (!existsSync(remoteState)) throw new Error(`Remote lifecycle CLI is missing: ${remoteState}`);
  const { callRemoteTool } = await import("./remote-state-client.mjs");
  const { createFleetRemoteRepository } = await import("./loop-fleet-remote.mjs");
  const callTool = callToolOverride ?? (({ url: serviceUrl, token: serviceToken, name, args }) => callRemoteTool({ url: serviceUrl, token: serviceToken }, name, args));
  const repository = createFleetRemoteRepository({ callTool, url, token, workspace, root });
  const fleetCli = runCli ?? (await import("./loop-fleet-cli.mjs")).runFleetCli;
  const owned = (id) => readIntakeRecord(root, id)?.authority === "fleet";
  /** Run one remote lifecycle command under a short lead claim (task create/status). */
  const withLead = async (taskId, args) => {
    const claim = await repository.claimLead({ taskId, leaseMs: 60000 });
    try { return JSON.parse(execFileSync(process.execPath, [remoteState, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...leadEnv, AIDLC_FLEET_LEAD_EPOCH: String(claim.epoch), AIDLC_FLEET_LEAD_OWNER_TOKEN: repository.leadOwnerToken() } })); }
    catch (error) { throw stateError(error); }
    finally { await repository.releaseLead({ taskId, epoch: claim.epoch }); }
  };
  const readTask = async (id) => { try { return (await repository.readTask({ taskId: id }))?.task ?? null; } catch (error) { if (String(error?.message ?? error).includes("task not found")) return null; throw error; } };
  return {
    mode: "fleet",
    repository,
    isOwned: owned,
    /** Fail closed before starting: the service must answer and the integration branch must exist on the remote. */
    async preflight() {
      await callTool({ url, token, name: "fleet_get", args: { workspace } });
      const { readIntegrationCommit } = await import("../remote-state.mjs");
      await readIntegrationCommit({ projectRoot: root, integrationBranch: leadEnv.AIDLC_FLEET_INTEGRATION_BRANCH, gitRemote: leadEnv.AIDLC_FLEET_GIT_REMOTE ?? "origin" });
    },
    async listActionable() {
      return (await repository.listTasks()).filter((task) => task.status === "active" && !task.handoff && owned(task.id) && nextAction(task, root).classification === "run_phase").sort(byUpdatedAt);
    },
    /** Bounded supervised run: returns at a gate (`gate`/`waiting`) instead of waiting for the reviewer. */
    async runTask({ taskId, signal, cancelSignal, onEvent }) {
      const result = await fleetCli(["supervisor", taskId], { callTool, env: leadEnv, signal, cancelSignal, untilStop: true, onEvent });
      // The fleet supervisor already emitted its `gate` event through onEvent.
      return result && typeof result === "object" ? { ...result, gateEmitted: true } : result;
    },
    async intake({ requirement, taskId: requested, title: requestedTitle }) {
      validRequirement(requirement);
      const identity = deriveTaskIdentity(requirement);
      const taskId = requested || uniqueTaskId(root, identity.slug, (await repository.listTasks()).map((task) => task.id));
      if (!ID.test(taskId)) throw new Error("Valid task ID required");
      const title = requestedTitle || identity.title;
      await guardedIntake(root, taskId, readTask, () => prepareLoopIntake({ root, taskId, requirement, title, authority: "fleet", readTask, createTask: async ({ taskId: id, title: taskTitle }) => { await withLead(id, ["task", "create", id, "--title", taskTitle]); } }));
      return { ok: true, taskId, title, authority: "fleet" };
    },
    async resumeTask(taskId) {
      const task = await readTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.status !== "paused" || task.handoff) throw new Error(`Only a paused task without a handoff can be resumed (status: ${task.status})`);
      return withLead(taskId, ["task", "status", taskId, "--status", "active"]);
    },
    async listTasks() { return (await repository.listTasks()).map((task) => ({ ...task, loopOwned: owned(task.id) })); },
    async getTask(taskId) { const snapshot = await repository.readTask({ taskId }); return { task: snapshot?.task ?? null, nextAction: snapshot?.nextAction ?? null, revision: snapshot?.revision ?? null }; },
    /** The current review snapshot for a waiting task (lead-readable inbox + checkpoint). */
    async gate(taskId) {
      const task = await readTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      const checkpoint = await repository.readGateCheckpoint({ taskId });
      const inbox = await callTool({ url, token, name: "gate_inbox_get", args: { workspace } });
      const snapshot = Array.isArray(inbox) ? inbox.find((entry) => entry.taskId === taskId && entry.gate === task.gate && (!checkpoint?.snapshotId || entry.id === checkpoint.snapshotId)) ?? null : null;
      return { taskId, status: task.status, gate: task.gate, checkpoint, snapshot };
    },
    /** Reviewer approval of the current snapshot. The reviewer token reaches only this child process. */
    async approve({ taskId, source, reviewerToken }) {
      if (typeof reviewerToken !== "string" || reviewerToken.length < 16) throw new Error("Fleet gate approval requires the reviewer credential (AIDLC_FLEET_REVIEWER_TOKEN)");
      if (typeof source !== "string" || !source.trim()) throw new Error("Approval source is required");
      const { snapshot, status } = await this.gate(taskId);
      if (status !== "blocked_on_user" || !snapshot) throw new Error("Task has no current gate snapshot to approve");
      try { return JSON.parse(execFileSync(process.execPath, [remoteState, "gate", "approve", taskId, "--snapshot", snapshot.id, "--source", source], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...leadEnv, AIDLC_FLEET_REVIEWER_TOKEN: reviewerToken } })); }
      catch (error) { throw stateError(error); }
    },
    /** Human feedback at a gate: records the `Cancelled gate wait` evidence and re-activates the task
     * so the loop revises and re-presents the same gate. Runs as the lead; never needs the reviewer credential. */
    async feedback({ taskId, reason, source }) {
      if (typeof reason !== "string" || !reason.trim()) throw new Error("Feedback reason is required");
      if (typeof source !== "string" || !source.trim()) throw new Error("Feedback source is required");
      const task = await readTask(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.status !== "blocked_on_user" || task.gate === "none") throw new Error("Task is not waiting at a human gate");
      return withLead(taskId, ["task", "status", taskId, "--status", "active", "--mode", "audited", "--reason", reason, "--source", source]);
    }
  };
}

/** Create the authority for the configured loop mode; never falls back to the other mode. */
export async function createLoopAuthority({ root, config, env = process.env, ...overrides }) {
  const mode = config?.loop?.mode;
  const agent = config?.loop?.agents?.lead;
  const workers = config?.loop?.agents?.workers ?? {};
  // Fail fast on a bad roster or `loop.limits` instead of failing every task run.
  if (!isLoopProvider(agent) || !workers || typeof workers !== "object" || Array.isArray(workers) || !Object.keys(workers).length || Object.entries(workers).some(([id, provider]) => !ID.test(id) || !isLoopProvider(provider))) throw new Error("Loop requires a configured lead and worker providers");
  if (config?.loop?.limits !== undefined) validateLimits(config.loop.limits);
  const options = { root, agent, workers, workerImages: config?.loop?.workerImage ?? {}, limits: config?.loop?.limits, pollMs: config?.loop?.pollMs, ...overrides };
  if (mode === "local") return createLocalAuthority(options);
  if (mode === "fleet") return createFleetAuthority({ ...options, env });
  throw new Error("Loop mode is off; configure an enabled loop mode first");
}
