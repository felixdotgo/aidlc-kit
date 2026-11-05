/**
 * Pure argv→options builders: init options, loop flag reads, worker mapping
 * parsing, and the argv-provided part of MCP setup selections. Prompting for
 * anything still missing happens in ./prompt.ts.
 */
import type { AgentId, InitOptions } from "../model.js";
import type { McpSetupOptions } from "../mcp-setup.js";
import { flags, rootArg, value } from "./argv.js";

export const initOptions = (args: string[]): InitOptions => ({
  root: rootArg(args),
  agents: (value(args, "--agent") ?? "").split(",").filter(Boolean) as AgentId[],
  all: flags(args).has("--all"),
  dryRun: flags(args).has("--dry-run"),
  yes: flags(args).has("--yes"),
  force: flags(args).has("--force")
});

export const loopSelection = (args: string[]): { mode?: string; lead?: string; workers?: string } => ({ mode: value(args, "--loop-mode"), lead: value(args, "--loop-lead"), workers: value(args, "--loop-workers") });

export const parseWorkerMapping = (rawWorkers: string): Record<string, string> => {
  const workers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of rawWorkers.split(",")) {
    const parts = entry.split("=");
    if (parts.length !== 2 || !parts[0] || !parts[1] || Object.hasOwn(workers, parts[0])) throw new Error("Invalid or duplicate loop worker mapping");
    workers[parts[0]] = parts[1];
  }
  return workers;
};

/** Argv-provided MCP selections: connection choices stay optional until prompted; the rest always carry defaults. */
export type McpArgSelections = { deployment?: McpSetupOptions["deployment"]; storage?: McpSetupOptions["storage"]; bind?: McpSetupOptions["bind"]; workspace?: string; pollMs: number; tokenEnv: string; providers: string[] };

export const mcpArgSelections = (args: string[]): McpArgSelections => {
  const selected = {
    deployment: value(args, "--deployment") as McpSetupOptions["deployment"] | undefined,
    storage: value(args, "--storage") as McpSetupOptions["storage"] | undefined,
    bind: value(args, "--bind") as McpSetupOptions["bind"] | undefined,
    workspace: value(args, "--workspace"),
    pollMs: Number(value(args, "--poll-ms") ?? 30_000),
    tokenEnv: value(args, "--token-env") ?? "AIDLC_MCP_TOKEN",
    providers: (value(args, "--providers") ?? "").split(",").filter(Boolean)
  };
  return selected;
};
