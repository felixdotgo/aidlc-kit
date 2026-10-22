#!/usr/bin/env node
import { resolve } from "node:path";
import { loopStatus, runLoop } from "./lib/loop-runtime.mjs";
import { runAgentTurn } from "./lib/loop-drivers.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

function parse(argv) {
  const [command, taskId, ...tail] = argv;
  if (!["run", "resume", "status"].includes(command) || !taskId) throw new Error("Usage: loop.mjs run <task-id> --agent codex|claude [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH] | resume <task-id> [--max-turns N] [--turn-timeout-ms N] [--max-stall-turns N] [--root PATH] | status <task-id> [--root PATH]");
  const options = {};
  const supported = new Set(["--root", "--agent", "--max-turns", "--turn-timeout-ms", "--max-stall-turns"]);
  for (let i = 0; i < tail.length; i += 2) {
    const name = tail[i], value = tail[i + 1];
    if (!supported.has(name) || !value || value.startsWith("--") || options[name] !== undefined) throw new Error(`Invalid option: ${name}`);
    options[name] = value;
  }
  if (command === "status" && Object.keys(options).some((key) => key !== "--root")) throw new Error("status only accepts --root");
  if (command === "run" && !options["--agent"]) throw new Error("run requires --agent codex|claude");
  const limits = {};
  if (options["--max-turns"] !== undefined) limits.maxTurns = Number(options["--max-turns"]);
  if (options["--turn-timeout-ms"] !== undefined) limits.turnTimeoutMs = Number(options["--turn-timeout-ms"]);
  if (options["--max-stall-turns"] !== undefined) limits.maxStallTurns = Number(options["--max-stall-turns"]);
  return { command, taskId, root: resolve(options["--root"] ?? process.cwd()), agent: options["--agent"], limits };
}

try {
  requireLocalAuthority();
  const options = parse(process.argv.slice(2));
  const result = options.command === "status" ? loopStatus(options.root, options.taskId) : await runLoop({ root: options.root, taskId: options.taskId, agent: options.agent, mode: options.command, limits: options.limits, driver: runAgentTurn, preflight: true, onEvent: (event) => { if (event?.type === "diagnostic") console.error(event.message); if (event?.type === "resume" || event?.type === "context_changed") console.error(JSON.stringify(event)); } });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
  if (result.status && !["complete", "gate"].includes(result.status)) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
