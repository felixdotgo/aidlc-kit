/**
 * Command handlers for loop, MCP setup, status, doctor, and profile validate.
 * Interactive prompting stays in ./prompt.ts and is invoked from here after
 * argv parsing.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, doctorData, status, statusData } from "../installer.js";
import { applyMcpSetup, planMcpSetup, type McpSetupOptions } from "../mcp-setup.js";
import { loadProjectConfig, resolveProfiles } from "../profiles.js";
import { assertKnownOptions, DOCTOR_FLAGS, flags, MCP_FLAGS, rootArg, STATUS_FLAGS, UI_FLAGS, value } from "./argv.js";
import { loopDown, loopEnv, loopOverview, loopStop, loopUp, serveDashboard } from "./loop-launcher.js";
import { confirmPlan, mcpSetupSelections } from "./prompt.js";

/** `loop leases [--task-id ID] [--root PATH] [--json] [--clear-stale]` and
 * `loop migrate-data [--root PATH] [--json] [--dry-run]`: forwarded to
 * loop-entry.mjs as `<action> [task-id] <root> [switches]`. */
const loopDiagnosticArgs = (action: "leases" | "migrate-data", args: string[]): { root: string; argv: string[] } => {
  const allowedSwitches = action === "leases" ? ["--json", "--clear-stale"] : ["--json", "--dry-run"];
  const allowedValues = action === "leases" ? ["--task-id", "--root"] : ["--root"];
  const parsed = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index] ?? "";
    if (allowedSwitches.includes(key)) { if (switches.has(key)) throw new Error("Invalid or duplicate loop option"); switches.add(key); continue; }
    const entry = args[index + 1];
    if (!allowedValues.includes(key) || !entry || entry.startsWith("--") || parsed.has(key)) throw new Error("Invalid or duplicate loop option");
    parsed.set(key, entry);
    index += 1;
  }
  const root = resolve(parsed.get("--root") ?? ".");
  return { root, argv: action === "leases" ? ["leases", parsed.get("--task-id") ?? "", root, ...switches] : ["migrate-data", root, ...switches] };
};

export const runLoopCommand = async (args: string[]): Promise<void> => {
  const action = args[0] ?? "";
  if (!["up", "down", "stop", "env", "start", "status", "resume", "intake", "worker-image", "leases", "migrate-data"].includes(action)) throw new Error("Expected loop up, down, stop, env, start, status, intake, leases, migrate-data, or worker-image");
  if (action === "up") return loopUp(args.slice(1));
  if (action === "down") return loopDown(args.slice(1));
  if (action === "stop") return loopStop(args.slice(1));
  if (action === "env") return loopEnv(args.slice(1));
  if (action === "status" && !args.includes("--task-id")) return loopOverview(args.slice(1));
  if (action === "leases" || action === "migrate-data") {
    const { root, argv } = loopDiagnosticArgs(action, args.slice(1));
    const child = spawn(process.execPath, [join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs"), ...argv], { stdio: "inherit" });
    const code = await new Promise<number | null>((resolveExit, rejectExit) => { child.once("error", rejectExit); child.once("exit", (exitCode) => resolveExit(exitCode)); });
    if (code !== 0) process.exitCode = code ?? 1;
    return;
  }
  const parsed = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const entry = args[index + 1];
    if (key === undefined || !["--task-id", "--title", "--root", "--mode", "--provider", "--tag", "--loop-env"].includes(key) || !entry || entry.startsWith("--") || parsed.has(key)) throw new Error("Invalid or duplicate loop option");
    parsed.set(key, entry);
  }
  const root = resolve(parsed.get("--root") ?? ".");
  const script = join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs");
  const child = spawn(process.execPath, [script, action, parsed.get("--task-id") ?? "", root, parsed.get("--mode") ?? "", parsed.get("--provider") ?? "", parsed.get("--tag") ?? "", parsed.get("--title") ?? ""], { stdio: "inherit", env: { ...process.env, ...(parsed.has("--loop-env") ? { AIDLC_ENV_FILE: resolve(parsed.get("--loop-env") ?? "") } : {}) } });
  // Stay alive while the child runs so its own staged shutdown (stop after the
  // current turn → cancel the turn → exit) stays reachable. A terminal Ctrl-C
  // already reaches the child through the process group, so SIGINT is only
  // swallowed here (forwarding it would count twice); SIGTERM sent to this
  // wrapper alone (e.g. `kill <pid>`) is forwarded instead of orphaning the child.
  const onInterrupt = (): void => {};
  const onTerminate = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (exitCode, exitSignal) => resolveExit({ code: exitCode, signal: exitSignal }));
    });
    if (code !== 0) process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
};

export const runUi = async (args: string[]): Promise<void> => {
  assertKnownOptions(args, UI_FLAGS);
  const reviewerTokenFile = value(args, "--reviewer-token-file");
  const port = Number(value(args, "--port") ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  await serveDashboard({
    root: resolve(rootArg(args)), host: value(args, "--host") ?? "127.0.0.1", port, open: flags(args).has("--open"),
    ...(reviewerTokenFile ? { reviewerTokenFile } : {}),
  });
};

const mcpSetupOptions = async (args: string[]): Promise<McpSetupOptions> => {
  const selected = await mcpSetupSelections(args);
  return { root: rootArg(args), template: join(fileURLToPath(new URL("../../services/aidlc-coordination", import.meta.url))), dryRun: flags(args).has("--dry-run"), deployment: selected.deployment!, storage: selected.storage!, bind: selected.bind!, workspace: selected.workspace!, pollMs: selected.pollMs!, tokenEnv: selected.tokenEnv!, providers: selected.providers!, enable: flags(args).has("--enable") };
};

export const runMcpSetup = async (args: string[]): Promise<void> => {
  assertKnownOptions(args.slice(1), MCP_FLAGS);
  const options = await mcpSetupOptions(args.slice(1));
  const plan = planMcpSetup(options);
  console.log(`◆ MCP SETUP preview — ${options.dryRun ? "no files will be written" : "review before applying"}`);
  console.log(JSON.stringify(plan, null, 2));
  if (options.dryRun) return;
  if (!await confirmPlan({ dryRun: options.dryRun, yes: flags(args.slice(1)).has("--yes") }, "Apply MCP setup", true)) return;
  applyMcpSetup(options);
  console.log(`MCP setup written to ${plan.target}. MCP remains ${options.enable ? "enabled" : "disabled"}; start Docker explicitly with docker compose --env-file .env -f ${join(plan.target, "compose.yaml")} up -d.`);
};

export const runMcp = async (args: string[]): Promise<void> => { if (args[0] !== "setup") throw new Error("Unknown command: mcp"); return runMcpSetup(args); };

export const runStatus = (args: string[]): void => {
  assertKnownOptions(args, STATUS_FLAGS);
  const root = rootArg(args);
  if (flags(args).has("--json")) console.log(JSON.stringify(statusData(root)));
  else console.log(status(root));
};

export const runDoctor = (args: string[]): void => {
  assertKnownOptions(args, DOCTOR_FLAGS);
  const root = rootArg(args);
  const strict = flags(args).has("--strict");
  if (flags(args).has("--json")) {
    const data = doctorData(root, strict);
    console.log(JSON.stringify(data));
    if (data.level === "error") process.exitCode = 1;
  } else {
    const result = doctor(root, strict);
    console.log(result);
    if (result.startsWith("ERROR:")) process.exitCode = 1;
  }
};

export const runProfileValidate = (args: string[]): void => {
  assertKnownOptions(args.slice(1), new Set());
  const root = rootArg(args.slice(1));
  const config = loadProjectConfig(root);
  const profiles = resolveProfiles(root, config.extends);
  console.log(`OK: ${profiles.map((item) => item.id).join(" → ")}`);
};

export const runProfile = (args: string[]): void => { if (args[0] !== "validate") throw new Error("Unknown command: profile"); return runProfileValidate(args); };
