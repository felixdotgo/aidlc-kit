#!/usr/bin/env node
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { installableAdapters } from "./adapters.js";
import { applyPlan, detectedAgents, doctor, formatPlan, planInit, planUninstall, selectAgents, status } from "./installer.js";
import type { AgentId, InitOptions } from "./model.js";
import { loadProjectConfig, resolveProfiles } from "./profiles.js";
import { applyUpgrade, planUpgrade } from "./upgrade.js";
import { packageVersion } from "./workflow.js";
import { applyMcpSetup, planMcpSetup, type McpSetupOptions } from "./mcp-setup.js";

const usage = `Usage:
  npx @felixdotgo/aidlc-kit init [path] [--agent <name[,name]> | --all] [--yes] [--dry-run] [--force]
  npx @felixdotgo/aidlc-kit upgrade [path] [--dry-run]
  npx @felixdotgo/aidlc-kit uninstall [path] [--yes] [--dry-run]
  npx @felixdotgo/aidlc-kit status [path]
  npx @felixdotgo/aidlc-kit doctor [path] [--strict]
  npx @felixdotgo/aidlc-kit profile validate [path]
  npx @felixdotgo/aidlc-kit mcp setup [path] [--dry-run] [--yes] [--storage sqlite|postgres] [--deployment docker|remote] [--bind localhost|network] [--workspace <id>] [--poll-ms <n>] [--enable]`;

const interactive = (): boolean => Boolean(stdin.isTTY && stdout.isTTY);
const prompts = async () => import("@inquirer/prompts");

const value = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const flags = (args: string[]): Set<string> => new Set(args.filter((item) => item.startsWith("--")));
const valueFlags = new Set(["--agent", "--storage", "--deployment", "--bind", "--workspace", "--poll-ms", "--token-env", "--providers"]);
const positional = (args: string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (valueFlags.has(args[index])) { index += 1; continue; }
    if (!args[index].startsWith("--")) result.push(args[index]);
  }
  return result;
};
const rootArg = (args: string[], fallback = "."): string => positional(args).find((item) => !["init", "upgrade", "uninstall", "status", "doctor", "validate", "run", "list"].includes(item)) ?? fallback;

const initOptions = (args: string[]): InitOptions => ({
  root: rootArg(args),
  agents: (value(args, "--agent") ?? "").split(",").filter(Boolean) as AgentId[],
  all: flags(args).has("--all"),
  dryRun: flags(args).has("--dry-run"),
  yes: flags(args).has("--yes"),
  force: flags(args).has("--force")
});

const chooseAgents = async (options: InitOptions): Promise<InitOptions> => {
  const selected = selectAgents(options);
  if (selected.length) return { ...options, agents: selected };
  const detected = detectedAgents(options.root);
  if (detected.length === 1) return { ...options, agents: detected };
  if (!interactive()) throw new Error(`Unable to select an agent automatically. Use --agent <name> or --all. Detected: ${detected.join(", ") || "none"}`);
  const { checkbox } = await prompts();
  const choices = installableAdapters();
  const agents = await checkbox({
    message: "Select one or more agents",
    choices: choices.map((adapter) => ({
      name: `${adapter.displayName}${detected.includes(adapter.id) ? " (detected)" : ""}`,
      value: adapter.id
    })),
    required: true
  });
  return { ...options, agents };
};

const preview = (operation: string, plan: ReturnType<typeof planInit>): void => {
  console.log(`◆ ${operation} preview — changes have NOT been applied`);
  console.log(formatPlan(plan));
};

const confirmGeneral = async (options: InitOptions, operation: string): Promise<boolean> => {
  if (options.dryRun) return false;
  if (options.yes) return true;
  if (!interactive()) return false;
  const { confirm } = await prompts();
  return confirm({ message: `${operation} this plan?`, default: false });
};

const mcpSetupOptions = async (args: string[]): Promise<McpSetupOptions> => {
  const selected = {
    deployment: value(args, "--deployment") as McpSetupOptions["deployment"] | undefined,
    storage: value(args, "--storage") as McpSetupOptions["storage"] | undefined,
    bind: value(args, "--bind") as McpSetupOptions["bind"] | undefined,
    workspace: value(args, "--workspace"),
    pollMs: Number(value(args, "--poll-ms") ?? 30_000),
    tokenEnv: value(args, "--token-env") ?? "AIDLC_MCP_TOKEN",
    providers: (value(args, "--providers") ?? "").split(",").filter(Boolean)
  };
  if ((!selected.deployment || !selected.storage || !selected.bind || !selected.workspace) && !interactive()) throw new Error("mcp setup outside a TTY requires --deployment, --storage, --bind and --workspace");
  if (interactive()) {
    const { input, select, checkbox } = await prompts();
    selected.deployment ??= await select({ message: "State service deployment", choices: [{ name: "Docker on this machine", value: "docker" }, { name: "Remote service (configure endpoint later)", value: "remote" }] }) as McpSetupOptions["deployment"];
    selected.storage ??= await select({ message: "Database", choices: [{ name: "SQLite (local Docker volume)", value: "sqlite" }, { name: "PostgreSQL (multi-host production)", value: "postgres" }] }) as McpSetupOptions["storage"];
    selected.bind ??= await select({ message: "Network binding", choices: [{ name: "localhost only", value: "localhost" }, { name: "network (requires token/TLS)", value: "network" }] }) as McpSetupOptions["bind"];
    selected.workspace ??= await input({ message: "Workspace ID", default: "default", required: true });
    if (!selected.providers.length) selected.providers = await checkbox({ message: "Project-management connectors to configure", choices: ["jira", "trello", "github-issues"].map((value) => ({ name: value, value })) });
  }
  if (!Number.isInteger(selected.pollMs) || selected.pollMs < 1_000 || selected.pollMs > 3_600_000) throw new Error("--poll-ms must be an integer from 1000 to 3600000");
  return { root: rootArg(args), template: join(fileURLToPath(new URL("../services/aidlc-coordination", import.meta.url))), dryRun: flags(args).has("--dry-run"), deployment: selected.deployment!, storage: selected.storage!, bind: selected.bind!, workspace: selected.workspace!, pollMs: selected.pollMs, tokenEnv: selected.tokenEnv, providers: selected.providers, enable: flags(args).has("--enable") };
};

const main = async (): Promise<void> => {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help") return void console.log(usage);
  if (command === "status") return void console.log(status(rootArg(args)));
  if (command === "doctor") {
    const result = doctor(rootArg(args), flags(args).has("--strict"));
    console.log(result); if (result.startsWith("ERROR:")) process.exitCode = 1; return;
  }
  if (command === "init") {
    const options = await chooseAgents(initOptions(args)); const plan = planInit(options); preview("INIT", plan);
    if (plan.some((item) => item.action === "conflict")) throw new Error("No files were written because the plan contains conflicts.");
    if (!await confirmGeneral(options, "Apply")) return;
    const migratesLegacyData = plan.some((item) => item.action === "migrate" || item.action === "delete");
    if (migratesLegacyData) {
      const result = applyUpgrade(options.root, plan);
      console.log(`Installed local AI-DLC workflow assets and migrated legacy data. Backup: ${result.backup}; changed: ${result.changed}`);
    } else {
      applyPlan(options.root, plan); console.log("Installed local AI-DLC workflow assets.");
    }
    return;
  }
  if (command === "uninstall") {
    const options = initOptions(args); const plan = planUninstall(options.root); preview("UNINSTALL", plan);
    if (!await confirmGeneral(options, "Remove")) return;
    applyPlan(options.root, plan); console.log("Removed eligible managed assets; project config and state were preserved."); return;
  }
  if (command === "upgrade") {
    if (flags(args).has("--yes") || flags(args).has("--force")) throw new Error("upgrade does not support --yes or --force; apply requires a human interactive TTY confirmation");
    const root = rootArg(args); const plan = planUpgrade(root); preview("UPGRADE", plan);
    if (plan.some((item) => item.action === "conflict")) throw new Error("Upgrade contains conflicts; no files were written.");
    if (flags(args).has("--dry-run")) return;
    if (!interactive()) throw new Error("Upgrade apply requires an interactive TTY. AI and non-interactive processes must not apply upgrades.");
    const expected = packageVersion();
    const { input } = await prompts();
    if ((await input({ message: `Type ${expected} to apply this user-initiated upgrade` })).trim() !== expected) throw new Error("Upgrade confirmation did not match the target version");
    const result = applyUpgrade(root, plan); console.log(`Upgrade complete. Backup: ${result.backup}; changed: ${result.changed}`); return;
  }
  if (command === "mcp" && args[0] === "setup") {
    const options = await mcpSetupOptions(args.slice(1)); const plan = planMcpSetup(options);
    console.log(`◆ MCP SETUP preview — ${options.dryRun ? "no files will be written" : "review before applying"}`); console.log(JSON.stringify(plan, null, 2));
    if (options.dryRun) return;
    if (!await confirmGeneral({ ...initOptions(args), root: options.root }, "Apply MCP setup")) return;
    applyMcpSetup(options); console.log(`MCP setup written to ${plan.target}. MCP remains ${options.enable ? "enabled" : "disabled"}; start Docker explicitly with docker compose --env-file .env -f ${join(plan.target, "compose.yaml")} up -d.`); return;
  }
  if (command === "profile" && args[0] === "validate") { const root = rootArg(args.slice(1)); const config = loadProjectConfig(root); const profiles = resolveProfiles(root, config.extends); console.log(`OK: ${profiles.map((item) => item.id).join(" → ")}`); return; }
  throw new Error(`Unknown command: ${command}`);
};

main().catch((error: unknown) => { console.error(`aidlc-workflow: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
