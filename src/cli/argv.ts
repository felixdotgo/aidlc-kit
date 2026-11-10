/**
 * Pure argv layer: usage text, value/flag parsing, and per-command option
 * allowlists. No prompting, no side effects.
 */
import { LOOP_PROVIDERS } from "../model.js";

export const usage = `Usage:
  npx @felixdotgo/aidlc-kit init [path] [--agent <name[,name]> | --all] [--loop-mode off|local|fleet] [--loop-lead ${LOOP_PROVIDERS.join("|")}] [--loop-workers <id=provider,...>] [--yes] [--dry-run] [--force] [--verbose]
  npx @felixdotgo/aidlc-kit upgrade [path] [--loop-mode off|local|fleet] [--loop-lead ${LOOP_PROVIDERS.join("|")}] [--loop-workers <id=provider,...>] [--dry-run] [--verbose]
  npx @felixdotgo/aidlc-kit uninstall [path] [--yes] [--dry-run] [--verbose]
  npx @felixdotgo/aidlc-kit status [path] [--json]
  npx @felixdotgo/aidlc-kit doctor [path] [--strict] [--json]
  npx @felixdotgo/aidlc-kit profile validate [path]
  npx @felixdotgo/aidlc-kit loop up [--root PATH] [--loop-env PATH] [--port 4173] [--host 127.0.0.1] [--open] [--no-ui]
  npx @felixdotgo/aidlc-kit loop down|stop [--root PATH] [--now]
  npx @felixdotgo/aidlc-kit loop env [--root PATH] [--loop-env PATH] [--json]
  npx @felixdotgo/aidlc-kit loop status [--root PATH] [--json]          (daemon, dashboard, environment)
  npx @felixdotgo/aidlc-kit loop start|status|intake [--task-id ID] [--title TITLE] [--root PATH] [--mode local|fleet] [--loop-env PATH]
  npx @felixdotgo/aidlc-kit loop worker-image [--provider ${LOOP_PROVIDERS.join("|")}] [--tag TAG] [--root PATH]
  npx @felixdotgo/aidlc-kit loop leases [--task-id ID] [--root PATH] [--json] [--clear-stale]
  npx @felixdotgo/aidlc-kit loop migrate-data [--root PATH] [--json] [--dry-run]   (move pre-runtime per-task loop files under .agents/data/tasks/<id>/runtime/)
  npx @felixdotgo/aidlc-kit ui [path] [--port 4173] [--host 127.0.0.1] [--open] [--reviewer-token-file PATH]
  npx @felixdotgo/aidlc-kit mcp setup [path] [--dry-run] [--yes] [--storage sqlite|postgres] [--deployment docker|remote] [--bind localhost|network] [--workspace <id>] [--poll-ms <n>] [--token-env <name>] [--providers <p,...>] [--enable]
  npx @felixdotgo/aidlc-kit version
  Global options: --help, --version, -v`;

export const value = (args: string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
};

export const flags = (args: string[]): Set<string> => new Set(args.filter((item) => item.startsWith("--")));
const valueFlags = new Set(["--agent", "--storage", "--deployment", "--bind", "--workspace", "--poll-ms", "--token-env", "--providers", "--loop-mode", "--loop-lead", "--loop-workers", "--port", "--host", "--reviewer-token-file"]);
const COMMAND_KEYWORDS = ["init", "upgrade", "uninstall", "status", "doctor", "validate", "run", "list"] as const;

const positional = (args: string[]): string[] => {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== undefined && valueFlags.has(arg)) { index += 1; continue; }
    if (arg !== undefined && !arg.startsWith("--")) result.push(arg);
  }
  return result;
};

export const rootArg = (args: string[], fallback = "."): string => positional(args).find((item) => !COMMAND_KEYWORDS.includes(item as never)) ?? fallback;

export const INIT_FLAGS = new Set(["--agent", "--all", "--loop-mode", "--loop-lead", "--loop-workers", "--yes", "--dry-run", "--force", "--verbose"]);
export const UPGRADE_FLAGS = new Set(["--loop-mode", "--loop-lead", "--loop-workers", "--dry-run", "--verbose"]);
export const UNINSTALL_FLAGS = new Set(["--yes", "--dry-run", "--verbose"]);
export const STATUS_FLAGS = new Set(["--json"]);
export const DOCTOR_FLAGS = new Set(["--strict", "--json"]);
export const MCP_FLAGS = new Set(["--dry-run", "--yes", "--storage", "--deployment", "--bind", "--workspace", "--poll-ms", "--token-env", "--providers", "--enable"]);
export const UI_FLAGS = new Set(["--port", "--host", "--open", "--reviewer-token-file"]);

export const assertKnownOptions = (args: string[], allowed: Set<string>): void => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (valueFlags.has(arg)) index += 1;
  }
};
