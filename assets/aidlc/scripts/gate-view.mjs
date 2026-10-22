import { checkGate, failEntry, formatGateView, loadState, option, parseArguments, rootOption, validateArguments } from "./lib/runtime.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
  requireLocalAuthority();
  const raw = process.argv.slice(2);
  const parsed = parseArguments(raw, { valueOptions: ["--root", "--format"] });
  validateArguments(parsed, { minPositionals: 1, valueOptions: ["--format"], usage: "Usage: gate-view.mjs <task-id> [--format <format>] [--root <path>]" });
  const root = rootOption(parsed);
  const [id] = parsed.positionals;
  const state = loadState(root);
  const task = state.tasks[id];
  if (!task) throw new Error(`Unknown active task: ${id}`);
  if (task.status !== "blocked_on_user") throw new Error(`Task must be blocked_on_user before presenting ${task.gate}`);
  const format = option(parsed, "--format") ?? "markdown";
  if (!["markdown", "plain", "json"].includes(format)) throw new Error("--format must be markdown, plain, or json");
  console.log(formatGateView(task, checkGate(root, state, id, task.gate), format).trimEnd());
} catch (error) { failEntry(error); }
