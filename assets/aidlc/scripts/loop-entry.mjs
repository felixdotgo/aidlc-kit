#!/usr/bin/env node
/**
 * Loop entry point shared by `aidlc-kit loop`, the web dashboard, and operators.
 *
 *   start         start the singleton loop daemon for the configured mode (local or fleet)
 *   intake        create a loop-owned task from a stdin requirement (≤ 8192 bytes) without running it
 *   status        print the canonical task, loop record/checkpoint, and next action
 *   worker-image  build and record a provider worker image
 *   env           report the daemon environment: providers, env file, each variable's
 *                 source (shell/file/derived) and missing values; secrets are never
 *                 printed. `env [root] [--json]`; exits 1 when the daemon could not start.
 *   leases        list loop leases, locks and claims: who holds what, until when,
 *                 what it blocks, and how to clear it. Works with any loop mode.
 *                 `leases [task-id] [root] [--json] [--clear-stale]`; --clear-stale
 *                 removes only stale/old-corrupt lease, lock and guard files.
 *   migrate-data  move per-task runtime files of older versions (loop assignments,
 *                 events, run records, intake) under .agents/data/tasks/<id>/runtime/.
 *                 `migrate-data [root] [--dry-run] [--json]`; idempotent, never
 *                 overwrites or deletes (the daemon also runs it at start).
 * Dashboard JSON actions (fleet authority; local dashboards read local state in-process):
 *   tasks | task <id> | gate <id> | resume-task <id> | approve <id> (source on stdin,
 *   reviewer credential only from AIDLC_FLEET_REVIEWER_TOKEN of this process) |
 *   feedback <id> (JSON `{ reason, source }` on stdin; keeps the task at its gate
 *   and never needs the reviewer credential)
 *
 * Positional arguments: [action, taskId, root, mode, provider, tag, title].
 * Gate approval for local tasks stays on the trusted terminal (`loop-gate.mjs`).
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { requireLocalAuthority } from "./lib/authority.mjs";
import { isLoopProvider } from "./lib/loop-drivers.mjs";
import { createLoopAuthority } from "./lib/loop-authority.mjs";
import { runLoopDaemon } from "./lib/loop-daemon.mjs";
import { streamLog } from "./lib/loop-stream.mjs";
import * as localSupervisor from "./lib/loop-supervisor-run-local.mjs";
import { buildWorkerImage, defaultWorkerImageTag, recordWorkerImage } from "./lib/loop-worker-image.mjs";
import { formatLeases, runLeases } from "./lib/loop-leases.mjs";
import { migrateAllTaskRuntime } from "./lib/task-runtime-migrate.mjs";
import { formatLoopEnvReport, loadLoopEnv, publicReport } from "./lib/loop-env.mjs";
import { callRemoteTool } from "./lib/remote-state-client.mjs";

const [action, taskArg, rootArg, modeArg, providerArg, tagArg, titleArg] = process.argv.slice(2);
const root = resolve(rootArg || ".");
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIONS = ["start", "resume", "status", "intake", "tasks", "task", "gate", "resume-task", "approve", "feedback"];
const readStdin = async (prompt) => {
  if (stdin.isTTY) { const rl = createInterface({ input: stdin, output: stdout }); try { return await rl.question(prompt); } finally { rl.close(); } }
  const chunks = []; for await (const chunk of stdin) { chunks.push(chunk); if (chunks.reduce((n, c) => n + c.length, 0) > 8192) throw new Error("Input exceeds 8192 bytes"); } return Buffer.concat(chunks).toString("utf8");
};
const requireTaskId = () => { if (!ID.test(taskArg ?? "")) throw new Error("Valid task ID required"); return taskArg; };
const print = (value) => console.log(JSON.stringify(value, null, 2));

/** `leases [task-id] [root] [--json] [--clear-stale]`; empty positionals are skipped. */
async function runLeasesAction(argv) {
  const flagSet = new Set(argv.filter((value) => value.startsWith("--")));
  for (const flag of flagSet) if (!["--json", "--clear-stale"].includes(flag)) throw new Error(`Unknown leases option: ${flag}`);
  const [taskValue = "", rootValue = ""] = argv.filter((value) => !value.startsWith("--"));
  if (taskValue && !ID.test(taskValue)) throw new Error("Valid task ID required");
  const leasesRoot = resolve(rootValue || ".");
  let config = null;
  try { config = JSON.parse(readFileSync(join(leasesRoot, ".agents", "config.json"), "utf8")); } catch { config = null; }
  const env = process.env;
  const fleetReader = config?.loop?.mode === "fleet" && env.AIDLC_FLEET_URL && env.AIDLC_FLEET_TOKEN && env.AIDLC_FLEET_WORKSPACE
    ? () => callRemoteTool({ url: env.AIDLC_FLEET_URL, token: env.AIDLC_FLEET_TOKEN }, "fleet_get", { workspace: env.AIDLC_FLEET_WORKSPACE })
    : undefined;
  const report = await runLeases({ root: leasesRoot, taskId: taskValue || undefined, clearStale: flagSet.has("--clear-stale"), fleetReader });
  if (config?.loop?.mode === "fleet" && !fleetReader) report.fleet = { revision: null, entries: [], error: "lead credential not set (AIDLC_FLEET_URL, AIDLC_FLEET_TOKEN, AIDLC_FLEET_WORKSPACE); fleet leases not shown" };
  if (flagSet.has("--json")) print(report);
  else console.log(formatLeases(report));
}

/** `migrate-data [root] [--dry-run] [--json]`: move pre-runtime per-task files under `runtime/`. */
function runMigrateDataAction(argv) {
  const flagSet = new Set(argv.filter((value) => value.startsWith("--")));
  for (const flag of flagSet) if (!["--json", "--dry-run"].includes(flag)) throw new Error(`Unknown migrate-data option: ${flag}`);
  const [rootValue = ""] = argv.filter((value) => !value.startsWith("--"));
  const migrateRoot = resolve(rootValue || ".");
  const result = migrateAllTaskRuntime(migrateRoot, { dryRun: flagSet.has("--dry-run") });
  if (flagSet.has("--json")) { print({ schemaVersion: 1, root: migrateRoot, ...result }); return; }
  const verb = result.dryRun ? "would move" : "moved";
  if (!result.entries.length) { console.log(`Nothing to migrate: every task runtime file is already under .agents/data/tasks/<id>/runtime/ (${migrateRoot})`); return; }
  for (const entry of result.entries) console.log(`${entry.action === "skipped" ? "skipped" : verb}: ${entry.from} -> ${entry.to}${entry.reason ? ` (${entry.reason})` : ""}`);
  console.log(`${result.dryRun ? "Would move" : "Moved"} ${result.entries.filter((entry) => entry.action !== "skipped").length} file(s), skipped ${result.skipped}.`);
}

/** `env [root] [--json]`: the local daemon environment report (no secret values). */
function runEnvAction(argv) {
  const flagSet = new Set(argv.filter((value) => value.startsWith("--")));
  for (const flag of flagSet) if (flag !== "--json") throw new Error(`Unknown env option: ${flag}`);
  const [rootValue = ""] = argv.filter((value) => !value.startsWith("--"));
  const envRoot = resolve(rootValue || ".");
  let config = null;
  try { config = JSON.parse(readFileSync(join(envRoot, ".agents", "config.json"), "utf8")); } catch { config = null; }
  const report = publicReport(loadLoopEnv({ root: envRoot, config }));
  if (flagSet.has("--json")) print(report); else console.log(formatLoopEnvReport(report));
  if (!report.ok) process.exitCode = 1;
}

try {
  if (action === "env") {
    runEnvAction(process.argv.slice(3));
  } else if (action === "leases") {
    await runLeasesAction(process.argv.slice(3));
  } else if (action === "migrate-data") {
    runMigrateDataAction(process.argv.slice(3));
  } else if (action === "worker-image") {
    // Build (or rebuild) a worker image without requiring loop configuration.
    const provider = providerArg || "opencode";
    if (!isLoopProvider(provider)) throw new Error("Expected --provider codex, claude, or opencode");
    const image = tagArg || defaultWorkerImageTag(provider);
    buildWorkerImage({ root, provider, image });
    recordWorkerImage({ root, provider, image });
    console.log(`Built worker image: ${image}`);
    console.log("Recorded worker image; the loop supervisor will use it automatically.");
  } else {
    if (!ACTIONS.includes(action)) throw new Error("Expected loop start, status, intake, env, leases, migrate-data, or worker-image");
    const config = JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8"));
    const mode = modeArg || config.loop?.mode || "off";
    if (!["local", "fleet"].includes(mode)) throw new Error("Loop mode is off; configure an enabled loop mode first");
    if (mode !== config.loop?.mode) throw new Error("Requested mode does not match configured authority");
    const agent = config.loop?.agents?.lead;
    const workers = config.loop?.agents?.workers ?? {};
    if (!isLoopProvider(agent) || !Object.keys(workers).length || Object.entries(workers).some(([, value]) => !isLoopProvider(value))) throw new Error("Loop requires a configured lead and worker providers");
    if (action === "resume") throw new Error("loop resume is removed; the daemon auto-resumes actionable tasks — run 'loop start', and re-activate a paused task from the dashboard (resume) or with the task status command");
    if (mode === "local") requireLocalAuthority();
    if (mode === "local" && action === "start") {
      // Zero-config start: shell > AIDLC env file > values derived from the providers' own config.
      const loaded = loadLoopEnv({ root, config });
      for (const problem of loaded.problems) process.stderr.write(`loop: ${problem.level === "error" ? "error" : "warning"}: ${problem.message}\n`);
      if (!loaded.ok) throw new Error("environment is incomplete; fix the errors above (check with: aidlc-kit loop env)");
      Object.assign(process.env, loaded.applied);
    }
    if (mode === "local" && action === "status") {
      const supervisor = await localSupervisor.createIsolatedLocalSupervisor({ root, taskId: requireTaskId(), agent, workers, workerImages: config.loop?.workerImage, onEvent: streamLog });
      print(await supervisor.status());
    } else {
      const authority = await createLoopAuthority({ root, config });
      if (action === "start") {
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
        if (typeof authority.preflight === "function") await authority.preflight();
        print(await runLoopDaemon({ root, authority, pollMs: config.loop?.pollMs, signal: stop.signal, cancelSignal: cancel.signal, onEvent: streamLog }));
      } else if (action === "intake") {
        print(await authority.intake({ requirement: await readStdin("Requirement: "), taskId: taskArg || undefined, title: titleArg || undefined }));
      } else if (action === "resume-task") {
        print(await authority.resumeTask(requireTaskId()));
      } else if (mode !== "fleet") {
        throw new Error(`loop ${action} is a fleet dashboard action; local dashboards read canonical local state directly`);
      } else if (action === "status") {
        const taskId = requireTaskId();
        const snapshot = await authority.getTask(taskId);
        print({ taskId, authority: "fleet", task: snapshot.task, nextAction: snapshot.nextAction, checkpoint: await authority.repository.readGateCheckpoint({ taskId }) });
      } else if (action === "tasks") {
        print({ ok: true, authority: "fleet", tasks: await authority.listTasks() });
      } else if (action === "task") {
        print({ ok: true, authority: "fleet", ...(await authority.getTask(requireTaskId())) });
      } else if (action === "gate") {
        print({ ok: true, authority: "fleet", ...(await authority.gate(requireTaskId())) });
      } else if (action === "approve") {
        const taskId = requireTaskId();
        print(await authority.approve({ taskId, source: (await readStdin("Approval source: ")).trim(), reviewerToken: process.env.AIDLC_FLEET_REVIEWER_TOKEN }));
      } else if (action === "feedback") {
        // Human guidance that keeps the task at its current gate; no reviewer credential is involved.
        const taskId = requireTaskId();
        let input; try { input = JSON.parse(await readStdin("Feedback JSON: ")); } catch { throw new Error("Feedback must be a JSON object { reason, source }"); }
        const reason = typeof input?.reason === "string" ? input.reason.trim() : "", source = typeof input?.source === "string" ? input.source.trim() : "";
        if (!input || typeof input !== "object" || Array.isArray(input) || !reason || !source) throw new Error("Feedback must be a JSON object { reason, source } with non-empty strings");
        print(await authority.feedback({ taskId, reason, source }));
      }
    }
  }
} catch (error) { console.error(`loop: ${error.message}`); process.exitCode = 1; }
