#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requireLocalAuthority } from "./lib/authority.mjs";
import { prepareLoopIntake } from "./lib/loop-intake.mjs";
import * as localSupervisor from "./lib/loop-supervisor-run-local.mjs";
import { loadTask } from "./lib/store.mjs";

const [action, taskArg, rootArg, modeArg] = process.argv.slice(2);
const root = resolve(rootArg || ".");
const readRequirement = async () => {
  if (stdin.isTTY) { const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question("Requirement: "); } finally { rl.close(); } }
  const chunks = []; for await (const chunk of stdin) { chunks.push(chunk); if (chunks.reduce((n, c) => n + c.length, 0) > 8192) throw new Error("Requirement exceeds 8192 bytes"); } return Buffer.concat(chunks).toString("utf8");
};
try {
  if (!["start", "resume", "status"].includes(action)) throw new Error("Expected loop start, resume, or status");
  const config = JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8"));
  const mode = modeArg || config.loop?.mode || "off";
  if (!["local", "fleet"].includes(mode)) throw new Error("Loop mode is off; configure an enabled loop mode first");
  if (mode !== config.loop?.mode) throw new Error("Requested mode does not match configured authority");
  const agent = config.loop?.agents?.lead;
  const workers = config.loop?.agents?.workers ?? {};
  if (!["codex", "claude"].includes(agent) || !Object.keys(workers).length || Object.entries(workers).some(([, value]) => !["codex", "claude"].includes(value))) throw new Error("Loop requires a configured lead and worker providers");
  const taskId = taskArg || (action === "start" ? `loop-${randomUUID()}` : "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId)) throw new Error("Valid task ID required");
  if (mode === "fleet") {
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
        const requirement = await readRequirement();
        const readTask = async (id) => { try { return (await callRemoteTool({ url, token }, "task_get", { workspace, taskId: id, clientProjectRoot: root })).task; } catch { return null; } };
        const current = await callRemoteTool({ url, token }, "state_get", { workspace });
        const actionable = Object.values(current?.state?.tasks ?? {}).filter((task) => task.id !== taskId && task.status === "active" && !task.handoff);
        if (actionable.length) throw new Error(`Task create is blocked while other work is actionable: ${actionable.map((task) => task.id).join(", ")}`);
        await prepareLoopIntake({ root, taskId, requirement, authority: "fleet", readTask, createTask: async ({ taskId: id, title }) => {
          const claim = await repository.claimLead({ taskId: id, leaseMs: 60000 });
          try {
            execFileSync(process.execPath, [remoteState, "task", "create", id, "--title", title], { cwd: root, encoding: "utf8", env: { ...env, AIDLC_FLEET_LEAD_EPOCH: String(claim.epoch), AIDLC_FLEET_LEAD_OWNER_TOKEN: repository.leadOwnerToken() } });
          } finally { await repository.releaseLead({ taskId: id, epoch: claim.epoch }); }
        } });
      }
      await runFleetCli(["supervisor", taskId], { callTool, env, out: (line) => console.log(line) });
    }
  } else {
    requireLocalAuthority();
    // The factory contract guarantees that the dispatcher is actually wired into
    // the supervisor, not merely present in the package. No host fallback.
    if (typeof localSupervisor.createIsolatedLocalSupervisor !== "function") throw new Error("Isolated local worker dispatcher is not integrated; loop execution is unavailable");
    const supervisor = await localSupervisor.createIsolatedLocalSupervisor({ root, taskId, agent, workers: config.loop.agents.workers });
    if (action === "status") {
      console.log(JSON.stringify(await supervisor.status(), null, 2));
    } else if (action === "start") {
      const requirement = await readRequirement();
      await prepareLoopIntake({ root, taskId, requirement, authority: "local", readTask: async (id) => loadTask(root, id), createTask: async ({ taskId: id, title }) => { execFileSync(process.execPath, [join(root, ".agents/aidlc/scripts/state.mjs"), "task", "create", id, "--title", title, "--root", root], { stdio: ["ignore", "pipe", "pipe"] }); } });
      console.log(JSON.stringify(await supervisor.start(), null, 2));
    } else console.log(JSON.stringify(await supervisor.resume(), null, 2));
  }
} catch (error) { console.error(`loop: ${error.message}`); process.exitCode = 1; }
