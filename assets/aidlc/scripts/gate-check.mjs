import { checkGate, failEntry, formatDiagnostics, loadState, option, parseArguments, rootOption, validateArguments } from "./lib/runtime.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
  requireLocalAuthority();
  const raw = process.argv.slice(2);
  const parsed = parseArguments(raw, { valueOptions: ["--root", "--gate"] });
  validateArguments(parsed, { minPositionals: 1, valueOptions: ["--gate"], usage: "Usage: gate-check.mjs <task-id> [--gate <gate>] [--root <path>]" });
  const root = rootOption(parsed);
  const [id] = parsed.positionals;
  const state = loadState(root);
  const task = state.tasks[id];
  const gate = option(parsed, "--gate") ?? task?.gate;
  if (!gate) throw new Error(`Unknown task: ${id}; pass --gate to check a gate contract without task state`);
  const diagnostics = checkGate(root, state, id, gate);
  console.log(formatDiagnostics(diagnostics));
  if (diagnostics.some((item) => item.level === "ERROR")) process.exitCode = 1;
} catch (error) { failEntry(error); }
