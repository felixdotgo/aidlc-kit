import { acquireStateLock, failEntry, loadState, loadTask, parseArguments, renderViews, rootOption, validateArguments } from "./lib/runtime.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
  requireLocalAuthority();
  const raw = process.argv.slice(2);
  const parsed = parseArguments(raw, { valueOptions: ["--root"], booleanOptions: ["--all"] });
  validateArguments(parsed, { minPositionals: 0, maxPositionals: 1, booleanOptions: ["--all"], usage: "Usage: render.mjs <task-id> [--root <path>] | --all [--root <path>]" });
  const all = parsed.flags.has("--all");
  if ((all && parsed.positionals.length) || (!all && parsed.positionals.length !== 1)) throw new Error("render.mjs requires either <task-id> or --all");
  const root = rootOption(parsed);
  const [id] = parsed.positionals;
  const releaseStateLock = acquireStateLock(root);
  try {
    const state = loadState(root);
    if (all) renderViews(root, state);
    else {
      const task = loadTask(root, id, state);
      if (!task) throw new Error(`Unknown task: ${id}`);
      renderViews(root, state, [task]);
    }
    console.log("Rendered requested task review artifact(s) from canonical state.");
  } finally {
    releaseStateLock();
  }
} catch (error) { failEntry(error); }
