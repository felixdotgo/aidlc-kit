import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Phase, Profile, ProjectConfig, TaskState } from "./model.js";
import { includedRuleFiles, resolveEffectiveConfig } from "./profiles.js";
import { loadMemoryRegistry, nextAction, selectAgenticMemory } from "./state.js";

const assetRoot = fileURLToPath(new URL("../assets/.agents/aidlc", import.meta.url));

const phaseFile = (phase: Phase): string => phase === "done" ? "phase-wrap.md" : `phase-${phase}.md`;
const readAsset = (path: string): string => readFileSync(join(assetRoot, path), "utf8");

/** Keeps only the latest test/lint/review record per (kind, area, gate) and strips prose details. */
const requiredEvidence = (task: TaskState) => task.evidence.filter((item, index, entries) => {
  const key = `${item.kind}:${item.area ?? ""}:${item.gate ?? ""}`;
  return !entries.slice(index + 1).some((candidate) => `${candidate.kind}:${candidate.area ?? ""}:${candidate.gate ?? ""}` === key);
}).map(({ detail: _detail, ...item }) => item);
/** Compact canonical view of the task for a phase packet; `itemId` narrows execution items only. */
const compactTask = (task: TaskState, itemId?: string): string => JSON.stringify({
  id: task.id,
  title: task.title,
  type: task.type,
  phase: task.phase,
  gate: task.gate,
  status: task.status,
  risk: task.risk,
  areas: task.areas,
  handoff: task.handoff,
  closure: task.closure,
  predecessorTaskId: task.predecessorTaskId,
  successorTaskId: task.successorTaskId,
  decisions: task.decisions.map(({ id, label, status }) => ({ id, label, status })),
  tasks: itemId ? task.tasks.filter((item) => item.id === itemId) : task.tasks,
  evidence: requiredEvidence(task),
  lessonDisposition: task.lessonDisposition,
  artifacts: task.artifacts
}, null, 2);

const profileSummary = (profiles: Profile[]): string => profiles.map((item) => JSON.stringify({ id: item.id, topology: item.topology, discovery: item.discovery, specs: item.specs, commands: item.commands })).join("\n");

export interface ContextPacket {
  content: string;
  chars: number;
  estimatedTokens: number;
  omittedRules: string[];
}

export interface ContextOptions { mode?: "standard" | "economy"; itemId?: string }

export const compileContext = (root: string, config: ProjectConfig, task: TaskState, phase: Phase, options: ContextOptions = {}): ContextPacket => {
  if (!["clarify", "plan", "build", "wrap", "done"].includes(phase)) throw new Error(`Unsupported phase: ${phase}`);
  const effective = resolveEffectiveConfig(root, config);
  const profiles = effective.profiles;
  const ruleFiles = includedRuleFiles(root, effective.rules.include);
  if (options.itemId && !task.tasks.some((item) => item.id === options.itemId)) throw new Error(`Unknown task item: ${options.itemId}`);
  const taskState = compactTask(task, options.itemId);
  const actionableItems = options.itemId ? task.tasks.filter((item) => item.status === "in_progress" || item.status === "todo").map((item) => item.id) : [];
  const invariants = [
    options.itemId ? `- Focused item context does not narrow the workplan: actionable items are ${actionableItems.join(", ") || "none"}; after this item, execute nextAction immediately.` : "",
    "- Continue after a non-terminal transition or item/evidence mutation; yield only at a human gate, real blocker, or completion.",
    "- Item completion is progress for commentary, never a final response while nextAction is run_phase.",
    "- Never omit approved decisions, spec anchors, safety constraints, or applicable verification evidence.",
    "- Agents may run configured build/test/lint commands, but workflow installation and upgrades remain human-only npm/npx operations."
  ].filter(Boolean).join("\n");
  const action = JSON.stringify(nextAction(task, root), null, 2);
  const required = [
    `# AI-DLC phase packet — ${phase}`,
    `mode: ${options.mode ?? "standard"}${options.itemId ? ` · item: ${options.itemId}` : ""}`,
    "## Next action / stop contract",
    action,
    "## Phase contract",
    readAsset(phaseFile(phase)),
    "## Canonical task state",
    taskState,
    "## Resolved profiles",
    profileSummary(profiles),
    "## Project configuration",
    JSON.stringify({ discovery: effective.discovery, specs: effective.specs, commands: effective.commands, risk: effective.risk, context: effective.context }, null, 2),
    "## Invariants",
    invariants
  ].join("\n\n");
  if (required.length > config.context.maxChars) throw new Error("Context budget is too small for the full phase contract, next action, canonical task state, and mandatory invariants");
  let content = required;
  const omittedRules: string[] = [];
  for (const path of ruleFiles) {
    const relative = path.slice(resolve(root).length + 1);
    const block = `\n\n## Project rule — ${relative}\n${readFileSync(path, "utf8")}`;
    if (content.length + block.length <= config.context.maxChars) content += block;
    else omittedRules.push(relative);
  }
  try {
    const memory = selectAgenticMemory(loadMemoryRegistry(root), task.areas, phase === "done" ? "wrap" : phase, config.context.maxChars - content.length - "\n\n## Advisory project memory\n".length);
    if (memory.length) content += `\n\n## Advisory project memory\n${memory.map((entry) => `- ${entry.id} — ${entry.summary} — guidance: ${entry.guidance} — source: ${entry.sourceTaskId}/${entry.sourceLessonId}`).join("\n")}`;
  } catch (error) {
    omittedRules.push(`memory:unavailable:${error instanceof Error ? error.message : String(error)}`);
  }
  return { content, chars: content.length, estimatedTokens: Math.ceil(content.length / 4), omittedRules };
};

export const writeableContextFormat = (packet: ContextPacket, format: "markdown" | "json"): string => format === "json" ? `${JSON.stringify(packet, null, 2)}\n` : `${packet.content}\n\n---\nchars: ${packet.chars} · estimated tokens: ${packet.estimatedTokens} · omitted rules: ${packet.omittedRules.length}\n`;

export const contextAssetsAvailable = (): boolean => existsSync(assetRoot);
