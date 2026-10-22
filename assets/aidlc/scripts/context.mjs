import { compileContext, failEntry, loadState, loadTask, option, parseArguments, rootOption, validateArguments } from "./lib/runtime.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
  requireLocalAuthority();
  const raw = process.argv.slice(2);
  const parsed = parseArguments(raw, { valueOptions: ["--root", "--phase", "--mode", "--item", "--format"] });
  validateArguments(parsed, { minPositionals: 1, valueOptions: ["--phase", "--mode", "--item", "--format"], usage: "Usage: context.mjs <task-id> [--phase <phase>] [--mode <mode>] [--item <item-id>] [--format <format>] [--root <path>]" });
  const root = rootOption(parsed);
  const [id] = parsed.positionals;
  const state = loadState(root);
  const task = loadTask(root, id, state);
  if (!task) throw new Error(`Unknown task: ${id}`);
  const packet = compileContext(root, task, option(parsed, "--phase") ?? task.phase, { mode: option(parsed, "--mode") ?? "standard", itemId: option(parsed, "--item") });
  if (option(parsed, "--format") === "json") console.log(JSON.stringify(packet, null, 2));
  else console.log(`${packet.content}\n\n---\nchars: ${packet.chars} · estimated tokens: ${packet.estimatedTokens} · omitted rules: ${packet.omittedRules.length}`);
} catch (error) { failEntry(error); }
