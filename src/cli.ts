#!/usr/bin/env node
import { resolvedAdapters } from "./adapters.js";
import { assertKnownOptions, flags, INIT_FLAGS, rootArg, UNINSTALL_FLAGS, UPGRADE_FLAGS, usage } from "./cli/argv.js";
import { runDoctor, runLoopCommand, runMcp, runProfile, runStatus, runUi } from "./cli/commands.js";
import { initOptions } from "./cli/options.js";
import { chooseLoop, confirmGeneral, interactive } from "./cli/prompt.js";
import { applyPlan, detectedAgents, formatPlan, planInit, planUninstall, selectAgents } from "./installer.js";
import type { InitOptions } from "./model.js";
import { applyUpgrade, planUpgrade } from "./upgrade.js";
import { packageVersion } from "./workflow.js";

/* Kept in this file: test/unit/cli.test.ts pins these prompt sources (and the upgrade boundary strings below) to src/cli.ts; the shared interactive flows live in ./cli/prompt.ts. */
const prompts = async () => import("@inquirer/prompts");

/* --- Agent selection and plan preview -------------------------------------- */

const chooseAgents = async (options: InitOptions): Promise<InitOptions> => {
  const selected = selectAgents(options);
  if (selected.length) return { ...options, agents: selected };
  const detected = detectedAgents(options.root);
  if (detected.length === 1) return { ...options, agents: detected };
  if (!interactive()) throw new Error(`Unable to select an agent automatically. Use --agent <name> or --all. Detected: ${detected.join(", ") || "none"}`);
  const { checkbox } = await prompts();
  const choices = resolvedAdapters();
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

/* --- Command handlers that consume the pinned prompts above ----------------- */

const runInit = async (args: string[]): Promise<void> => {
  assertKnownOptions(args, INIT_FLAGS);
  const options = { ...await chooseAgents(initOptions(args)), loop: await chooseLoop(args, false) };
  const plan = planInit(options);
  preview("INIT", plan);
  if (plan.some((item) => item.action === "conflict")) throw new Error("No files were written because the plan contains conflicts.");
  if (!await confirmGeneral(options, "Apply")) return;
  if (plan.some((item) => item.action === "migrate" || item.action === "delete")) {
    const result = applyUpgrade(options.root, plan);
    console.log(`Installed local AI-DLC workflow assets and migrated legacy data. Backup: ${result.backup}; changed: ${result.changed}`);
  } else {
    applyPlan(options.root, plan);
    console.log("Installed local AI-DLC workflow assets.");
  }
};

const runUninstall = async (args: string[]): Promise<void> => {
  assertKnownOptions(args, UNINSTALL_FLAGS);
  const options = initOptions(args);
  const plan = planUninstall(options.root);
  preview("UNINSTALL", plan);
  if (!await confirmGeneral(options, "Remove")) return;
  applyPlan(options.root, plan);
  console.log("Removed eligible managed assets; project config and state were preserved.");
};

const runUpgrade = async (args: string[]): Promise<void> => {
  assertKnownOptions(args, UPGRADE_FLAGS);
  if (flags(args).has("--yes") || flags(args).has("--force")) throw new Error("upgrade does not support --yes or --force; apply requires a human interactive TTY confirmation");
  const root = rootArg(args);
  const plan = planUpgrade(root, await chooseLoop(args, true));
  preview("UPGRADE", plan);
  if (plan.some((item) => item.action === "conflict")) throw new Error("Upgrade contains conflicts; no files were written.");
  if (flags(args).has("--dry-run")) return;
  if (!interactive()) throw new Error("Upgrade apply requires an interactive TTY. AI and non-interactive processes must not apply upgrades.");
  const expected = packageVersion();
  const { input } = await prompts();
  if ((await input({ message: `Type ${expected} to apply this user-initiated upgrade` })).trim() !== expected) throw new Error("Upgrade confirmation did not match the target version");
  const result = applyUpgrade(root, plan);
  console.log(`Upgrade complete. Backup: ${result.backup}; changed: ${result.changed}`);
};

/* --- Command registry and entry --------------------------------------------- */

type CommandHandler = (args: string[]) => void | Promise<void>;
const runHelp = (): void => console.log(usage);
const runVersion = (): void => console.log(packageVersion());
const REGISTRY: Record<string, CommandHandler> = { init: runInit, upgrade: runUpgrade, uninstall: runUninstall, status: runStatus, doctor: runDoctor, loop: runLoopCommand, ui: runUi, mcp: runMcp, profile: runProfile, version: runVersion, help: runHelp };

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) return void console.log(packageVersion());
  if (argv.includes("--help")) return void console.log(usage);
  const [command = "help", ...args] = argv;
  const handler = Object.hasOwn(REGISTRY, command) ? REGISTRY[command] : undefined;
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return void await handler(args);
};

main().catch((error: unknown) => { console.error(`aidlc-kit: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
