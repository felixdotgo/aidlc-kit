#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requireLocalAuthority } from "./lib/authority.mjs";
import { isLoopProvider } from "./lib/loop-drivers.mjs";
import { deriveTaskIdentity, prepareLoopIntake } from "./lib/loop-intake.mjs";
import { isLoopOwned, runLocalDaemon } from "./lib/loop-daemon.mjs";
import { streamLog } from "./lib/loop-stream.mjs";
import * as localSupervisor from "./lib/loop-supervisor-run-local.mjs";
import { loadState, loadTask, nextAction } from "./lib/store.mjs";
import { buildWorkerImage, defaultWorkerImageTag, recordWorkerImage } from "./lib/loop-worker-image.mjs";

const [action, taskArg, rootArg, modeArg, providerArg, tagArg, titleArg] = process.argv.slice(2);
const root = resolve(rootArg || ".");
const readRequirement = async () => {
  if (stdin.isTTY) { const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question("Requirement: "); } finally { rl.close(); } }
  const chunks = []; for await (const chunk of stdin) { chunks.push(chunk); if (chunks.reduce((n, c) => n + c.length, 0) > 8192) throw new Error("Requirement exceeds 8192 bytes"); } return Buffer.concat(chunks).toString("utf8");
};
/** Local intake: create a loop-owned task from a stdin requirement without
 * running it. The daemon (singleton) picks it up on its next poll. Other
 * actionable loop-owned tasks are acknowledged with --switch-from because the
 * daemon runs them concurrently by design; an actionable task owned by an
 * interactive lead blocks intake so the daemon never strands that work. */
const stateError = (error) => {
  const stderr = String(error?.stderr ?? "").trim();
  try { const parsed = JSON.parse(stderr); if (parsed?.error?.message) return new Error(parsed.error.message); } catch { /* not JSON */ }
  return stderr ? new Error(stderr) : error;
};
async function localIntake() {
  const requirement = await readRequirement();
  if (!requirement.trim() || Buffer.byteLength(requirement) > 8192) throw new Error("Requirement must contain 1–8192 bytes");
  const identity = deriveTaskIdentity(requirement);
  const state = loadState(root);
  let taskId = taskArg || identity.slug;
  const tasksDir = join(root, ".agents", "data", "tasks");
  if (!taskArg) {
    // Resolve case-insensitive collisions against active + archived ids and any
    // existing task directory (e.g. a leftover from an interrupted intake). The
    // base is shortened so a numeric suffix keeps the id within 128 characters.
    const dirs = existsSync(tasksDir) ? readdirSync(tasksDir) : [];
    const existing = new Set([...Object.keys(state.tasks), ...Object.keys(state.archive ?? {}), ...dirs].map((id) => id.toLowerCase()));
    const base = identity.slug.slice(0, 120).replace(/-+$/, "") || "loop-task";
    for (let suffix = 2; existing.has(taskId.toLowerCase()); suffix += 1) taskId = `${base}-${suffix}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Valid task ID required");
  const title = titleArg || identity.title;
  const actionableIds = (current) => Object.values(current.tasks).filter((task) => task.id !== taskId && nextAction(task, root).classification === "run_phase").map((task) => task.id).sort();
  const interactive = actionableIds(state).filter((id) => !isLoopOwned(root, id));
  if (interactive.length) throw new Error(`Task create is blocked while interactive work is actionable: ${interactive.join(", ")}. Finish or pause it before starting loop work`);
  const intakeFiles = [join(tasksDir, taskId, "loop-intake.json"), join(tasksDir, taskId, "requirement.md")];
  const preexisting = intakeFiles.map((path) => existsSync(path));
  try {
    await prepareLoopIntake({ root, taskId, requirement, title, authority: "local", readTask: async (id) => loadTask(root, id), createTask: async ({ taskId: id, title: taskTitle }) => {
      const owned = actionableIds(loadState(root)).filter((other) => isLoopOwned(root, other));
      try {
        execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", id, "--title", taskTitle, ...(owned.length ? ["--switch-from", owned.join(",")] : []), "--root", root], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      } catch (error) { throw stateError(error); }
    } });
  } catch (error) {
    // Roll back intake files this call created when no task came into being:
    // an orphan loop-intake.json would block retries and would mark a task later
    // created with the same id by an interactive lead as loop-owned.
    if (!loadTask(root, taskId)) {
      intakeFiles.forEach((path, index) => { if (!preexisting[index]) { try { unlinkSync(path); } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; } } });
      try { rmdirSync(join(tasksDir, taskId)); } catch { /* not empty or already gone */ }
    }
    throw error;
  }
  return { ok: true, taskId, title };
}

try {
  if (action === "worker-image") {
    // Build (or rebuild) a worker image without requiring loop configuration.
    const provider = providerArg || "opencode";
    if (!isLoopProvider(provider)) throw new Error("Expected --provider codex, claude, or opencode");
    const image = tagArg || defaultWorkerImageTag(provider);
    buildWorkerImage({ root, provider, image });
    recordWorkerImage({ root, provider, image });
    console.log(`Built worker image: ${image}`);
    console.log("Recorded worker image; the loop supervisor will use it automatically.");
  } else {
    if (!["start", "resume", "status", "intake"].includes(action)) throw new Error("Expected loop start, resume, status, intake, or worker-image");
    const config = JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8"));
    const mode = modeArg || config.loop?.mode || "off";
    if (!["local", "fleet"].includes(mode)) throw new Error("Loop mode is off; configure an enabled loop mode first");
    if (mode !== config.loop?.mode) throw new Error("Requested mode does not match configured authority");
    const agent = config.loop?.agents?.lead;
    const workers = config.loop?.agents?.workers ?? {};
    if (!isLoopProvider(agent) || !Object.keys(workers).length || Object.entries(workers).some(([, value]) => !isLoopProvider(value))) throw new Error("Loop requires a configured lead and worker providers");
    if (mode === "fleet") {
      if (action === "intake") throw new Error("loop intake is local-only; fleet uses loop start with a requirement");
      // Fleet one-shot (requirement intake) remains the documented multi-host follow-up.
      const requirement = action === "start" ? await readRequirement() : "";
      const identity = deriveTaskIdentity(requirement);
      const taskId = taskArg || (action === "start" ? identity.slug : "");
      const title = titleArg || identity.title;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Valid task ID required");
      const { callRemoteTool } = await import("./lib/remote-state-client.mjs");
      const { createFleetRemoteRepository } = await import("./lib/loop-fleet-remote.mjs");
      const { runFleetCli } = await import("./lib/loop-fleet-cli.mjs");
      const { readIntegrationCommit } = await import("./remote-state.mjs");
      const requiredEnv = (name) => { const value = process.env[name]; if (typeof value !== "string" || !value.trim()) throw new Error(`Fleet loop requires ${name} for the configured remote authority`); return value; };
      const url = requiredEnv("AIDLC_FLEET_URL"), workspace = requiredEnv("AIDLC_FLEET_WORKSPACE"), token = requiredEnv("AIDLC_FLEET_TOKEN");
      const integrationBranch = requiredEnv("AIDLC_FLEET_INTEGRATION_BRANCH");
      if (process.env.AIDLC_FLEET_PROJECT_ROOT && resolve(process.env.AIDLC_FLEET_PROJECT_ROOT) !== root) throw new Error("AIDLC_FLEET_PROJECT_ROOT does not match the loop root; refusing to run");
      if (process.env.AIDLC_FLEET_WORKER_IDS && process.env.AIDLC_FLEET_WORKER_IDS.split(",").map((value) => value.trim()).filter(Boolean).join(",") !== Object.keys(workers).join(",")) throw new Error("AIDLC_FLEET_WORKER_IDS does not match the configured loop workers");
      if (process.env.AIDLC_FLEET_WORKER_PROVIDERS && process.env.AIDLC_FLEET_WORKER_PROVIDERS !== JSON.stringify(workers)) throw new Error("AIDLC_FLEET_WORKER_PROVIDERS does not match the configured loop workers");
      const env = { ...process.env, AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_WORKER_IDS: Object.keys(workers).join(","), AIDLC_FLEET_WORKER_PROVIDERS: JSON.stringify(workers), AIDLC_FLEET_AGENT: agent };
      const remoteState = join(root, ".agents/aidlc/scripts/remote-state.mjs");
      if (!existsSync(remoteState)) throw new Error(`Remote lifecycle CLI is missing: ${remoteState}`);
      const callTool = ({ url: serviceUrl, token: serviceToken, name, args }) => callRemoteTool({ url: serviceUrl, token: serviceToken }, name, args);
      const repository = createFleetRemoteRepository({ callTool, url, token, workspace, root });
      if (action === "status") {
        let snapshot = null;
        try { snapshot = await repository.readTask({ taskId }); } catch (error) { if (!String(error?.message ?? error).includes("task not found")) throw error; }
        const checkpoint = await repository.readGateCheckpoint({ taskId });
        console.log(JSON.stringify({ taskId, authority: "fleet", task: snapshot?.task ?? null, nextAction: snapshot?.nextAction ?? null, checkpoint }, null, 2));
      } else {
        if (action === "resume") {
          const recordPath = join(root, ".agents/data/tasks", taskId, "loop-intake.json");
          if (!existsSync(recordPath)) throw new Error("Loop record missing; use start");
          const record = JSON.parse(readFileSync(recordPath, "utf8"));
          if (record.taskId !== taskId || record.authority !== "fleet") throw new Error("Loop record authority mismatch; use the recorded authority and task");
        }
        await callRemoteTool({ url, token }, "fleet_get", { workspace });
        await readIntegrationCommit({ projectRoot: root, integrationBranch, gitRemote: env.AIDLC_FLEET_GIT_REMOTE ?? "origin" });
        if (action === "start") {
          const readTask = async (id) => { try { return (await callRemoteTool({ url, token }, "task_get", { workspace, taskId: id, clientProjectRoot: root })).task; } catch { return null; } };
          const current = await callRemoteTool({ url, token }, "state_get", { workspace });
          const actionable = Object.values(current?.state?.tasks ?? {}).filter((task) => task.id !== taskId && task.status === "active" && !task.handoff);
          if (actionable.length) throw new Error(`Task create is blocked while other work is actionable: ${actionable.map((task) => task.id).join(", ")}`);
          await prepareLoopIntake({ root, taskId, requirement, title, authority: "fleet", readTask, createTask: async ({ taskId: id, title }) => {
            const claim = await repository.claimLead({ taskId: id, leaseMs: 60000 });
            try {
              execFileSync(process.execPath, [remoteState, "task", "create", id, "--title", title], { cwd: root, encoding: "utf8", env: { ...env, AIDLC_FLEET_LEAD_EPOCH: String(claim.epoch), AIDLC_FLEET_LEAD_OWNER_TOKEN: repository.leadOwnerToken() } });
            } finally { await repository.releaseLead({ taskId: id, epoch: claim.epoch }); }
          } });
        }
        await runFleetCli(["supervisor", taskId], { callTool, env, out: (line) => console.log(line) });
      }
    } else {
      // Local mode: the daemon is the default (and only) execution. There is no
      // requirement intake and no one-shot resume — the daemon auto-picks and
      // auto-resumes actionable tasks from canonical state.
      requireLocalAuthority();
      if (typeof localSupervisor.createIsolatedLocalSupervisor !== "function") throw new Error("Isolated local worker dispatcher is not integrated; loop execution is unavailable");
      if (action === "intake") {
        console.log(JSON.stringify(await localIntake(), null, 2));
      } else if (action === "start") {
        // Two-stage shutdown: 1st signal stops after the current turn, 2nd cancels
        // the in-flight agent turn, 3rd exits immediately. Runs end as `stopped`
        // (tasks are not paused) and resume on the next daemon start.
        const stop = new AbortController(), cancel = new AbortController();
        let received = 0;
        const onSignal = () => {
          received += 1;
          if (received === 1) { process.stderr.write("\nloop: stopping after the current turn — send the signal again (Ctrl-C) to cancel it\n"); stop.abort(); }
          else if (received === 2) { process.stderr.write("\nloop: cancelling the in-flight turn — send the signal again to exit immediately\n"); cancel.abort(); }
          else process.exit(130);
        };
        for (const name of ["SIGINT", "SIGTERM"]) process.on(name, onSignal);
        const result = await runLocalDaemon({ root, agent, workers, workerImages: config.loop?.workerImage, pollMs: config.loop?.pollMs, limits: config.loop?.limits, signal: stop.signal, cancelSignal: cancel.signal, onEvent: streamLog });
        console.log(JSON.stringify(result, null, 2));
      } else if (action === "status") {
        if (!taskArg) throw new Error("loop status requires a task id");
        const supervisor = await localSupervisor.createIsolatedLocalSupervisor({ root, taskId: taskArg, agent, workers, workerImages: config.loop?.workerImage, onEvent: streamLog });
        console.log(JSON.stringify(await supervisor.status(), null, 2));
      } else {
        throw new Error("Local loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start'");
      }
    }
  }
} catch (error) { console.error(`loop: ${error.message}`); process.exitCode = 1; }
