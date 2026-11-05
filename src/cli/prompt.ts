/**
 * Interactive layer: TTY detection, dynamic @inquirer/prompts loading, and the
 * prompting flows (loop configuration, MCP setup selections, confirmations).
 * Parsing of argv into options happens in ./argv.ts and ./options.ts.
 */
import { stdin, stdout } from "node:process";
import type { LoopConfig } from "../model.js";
import { LOOP_PROVIDERS } from "../model.js";
import type { McpSetupOptions } from "../mcp-setup.js";
import { validateLoopConfig } from "../profiles.js";
import { loopSelection, mcpArgSelections, parseWorkerMapping } from "./options.js";

export const interactive = (): boolean => Boolean(stdin.isTTY && stdout.isTTY);
const prompts = async () => import("@inquirer/prompts");

export const chooseLoop = async (args: string[], upgrade: boolean): Promise<LoopConfig | undefined> => {
  let { mode, lead: leadArg, workers: workersArg } = loopSelection(args);
  if (!mode && (leadArg || workersArg)) throw new Error("--loop-lead and --loop-workers require --loop-mode");
  if (!mode && interactive()) {
    const { select } = await prompts();
    mode = await select({ message: "Loop execution mode", choices: [
      ...(upgrade ? [{ name: "Keep existing loop configuration", value: "keep" }] : []),
      { name: "Off", value: "off" }, { name: "Local", value: "local" }, { name: "Fleet", value: "fleet" }
    ] });
  }
  if (!mode || mode === "keep") return undefined;
  if (mode === "off") {
    if (leadArg || workersArg) throw new Error("Disabled loop cannot specify agents");
    return validateLoopConfig({ mode });
  }
  let lead = leadArg, rawWorkers = workersArg;
  if (interactive() && (!lead || !rawWorkers)) {
    const { select, input } = await prompts();
    lead ??= await select({ message: "Lead agent", choices: LOOP_PROVIDERS.map((name) => ({ name, value: name })) });
    rawWorkers ??= await input({ message: "Workers (id=provider, comma separated)", default: "codex-worker=codex,claude-worker=claude" });
  }
  if (!lead || !rawWorkers) throw new Error("An enabled loop requires --loop-lead and --loop-workers");
  return validateLoopConfig({ mode, agents: { lead, workers: parseWorkerMapping(rawWorkers) } });
};

export const mcpSetupSelections = async (args: string[]): Promise<Partial<Omit<McpSetupOptions, "root" | "template" | "dryRun" | "enable">>> => {
  const selected = mcpArgSelections(args);
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
  return selected;
};

export const confirmGeneral = async (options: { dryRun: boolean; yes: boolean }, operation: string): Promise<boolean> => {
  if (options.dryRun) return false;
  if (options.yes) return true;
  if (!interactive()) return false;
  const { confirm } = await prompts();
  return confirm({ message: `${operation} this plan?`, default: false });
};
