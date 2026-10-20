import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, AgentId, FileSpec } from "./model.js";

const adapterFile = (owner: string, path: string, body: string): FileSpec => ({
  path,
  owner,
  content: `<!-- aidlc-installer:${owner}:start -->\n${body}<!-- aidlc-installer:${owner}:end -->\n`
});

const instruction = (agent: string, adapter: AgentId) => [
  `# AI-DLC for ${agent}`,
  "",
  "Treat every requested feature, bug fix, or project change as an AI-DLC task. Keep read-only explanations and inspections off-workflow.",
  "",
  "Read `.agents/aidlc/orchestrator.md`. Use bounded `state.mjs task list` or `task find --query <text>`; never read or dump lifecycle files directly.",
  "",
  "At each phase entry and dependency boundary, apply the orchestrator's delegation contract. When parallel work is independent and valuable, use your host's native collaboration/delegation tools to fan out at most the available collaboration slots minus the lead. The lead alone owns lifecycle mutations, gates, and task review artifacts; assign non-overlapping paths, require each worker to return its summary, changed paths, verification evidence, and concerns, then integrate and verify its result before advancing.",
  "",
  "For a NEW task, preserve an exact user-supplied canonical ID when present. Run `node .agents/aidlc/scripts/state.mjs task create <id> --title <title>`, then execute the clarify phase; do not call `task next` before the task exists.",
  "If `task create` reports another actionable task, stop and surface it. Pass the returned `--switch-from <task-id>` acknowledgement only when the user explicitly chooses to switch; the prior task keeps its state and remains the resume target — never pause, close, or forget it silently.",
  "For an existing task, run `state.mjs task next <task-id>` and use the matching phase packet.",
  ...(adapter === "codex" ? ["Codex execpolicy prefix rules match one command invocation. Run every `node .agents/aidlc/scripts/...` lifecycle command in a separate exec call; never join lifecycle commands with shell operators such as `&`, `&&`, `;`, or `|`."] : []),
  "",
  "Before a human gate: run `gate-check.mjs`; set `task status <task-id> --status blocked_on_user`; render the task artifact when the phase requires it; then run `gate-view.mjs <task-id>` and relay its output verbatim.",
  "",
  "Only in a later turn containing explicit user assent, run the returned atomic `state.mjs gate approve` command. Pass the user message as `--source` provenance; the local CLI does not authenticate authorship of free-form text. Never invent or auto-approve a human gate.",
  "",
  "After every lifecycle mutation, parse the returned `nextAction`. Execute `run_phase` before responding; stop at `await_user`, `blocked`, or `terminal`; treat only `complete` as successful completion.",
  "Follow structured blocked actions. Never interpret `terminal` as a passing gate or release.",
  "",
  "Immediately before a task final response, run `node .agents/aidlc/scripts/task-next.mjs <task-id> --require-stop` and parse its machine-readable `continuation` object. Exit code 2 (`continuation.code = CONTINUATION_REQUIRED`) means the turn is not over: execute `continuation.command` before any reply, and never convert the guard output into a final response or summary. If a premature final response already slipped out, recover in the very next turn by running `state.mjs task next <task-id>` and executing its returned command; never re-approve a gate to catch up.",
  "",
  `For other lifecycle mutations, consult \`.agents/config.json\` \`agentState.${adapter}\`; scripted is the safe default and build verification remains mandatory.`,
  "",
  "Completing an item or affected area is progress for commentary, never a final response while `nextAction` is `run_phase`.",
  "Workflow install/upgrade operations are human-only. Never query npm for a newer workflow or run npm/npx to install, detect, preview, or upgrade it. Project-configured build, test, and lint commands remain allowed.",
  ""
].join("\n");

const claudeSkill = (phase: string, gate: string) => [
  "---", `name: aidlc-${phase}`, `description: AI-DLC ${phase} phase (${gate}) for Claude Code.`, "allowed-tools: Bash(node .agents/aidlc/scripts/*)", "---", "",
  `# AI-DLC ${phase} (${gate})`, "", `Read \`.agents/aidlc/phase-${phase}.md\` and execute it exactly.`,
  "Resolve `state.mjs task next <task-id>` and use atomic `state.mjs gate approve` when scripts are available. After every lifecycle mutation, parse `nextAction`: execute `run_phase`, stop at `await_user`, `blocked`, or `terminal`, and treat only `complete` as successful completion. Follow structured blocked actions and never treat terminal closure as a passing gate or release. Never invent or bypass human gates or build verification.",
  "Item completion is progress, not a stop. Immediately before any task final response, run `node .agents/aidlc/scripts/task-next.mjs <task-id> --require-stop` and parse its `continuation` object; on exit code 2 (`CONTINUATION_REQUIRED`), execute `continuation.command` before any reply and never convert the guard output into a final response. Recover from a premature final response by running `state.mjs task next <task-id>` in the very next turn and executing its command.",
  "Workflow install/upgrade operations are human-only. Never query npm for a newer workflow or run npm/npx to install, detect, preview, or upgrade it. Project-configured build, test, and lint commands remain allowed.", ""
].join("\n");

const claudeLocalSettings = JSON.stringify({
  permissions: { allow: ["Bash(node .agents/aidlc/scripts/*)"] }
}, null, 2) + "\n";

const codexExecPolicy = [
  "# Permit only AI-DLC lifecycle scripts without an approval prompt.",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/context.mjs\"], decision = \"allow\")",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/gate-check.mjs\"], decision = \"allow\")",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/gate-view.mjs\"], decision = \"allow\")",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/render.mjs\"], decision = \"allow\")",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/state.mjs\"], decision = \"allow\")",
  "prefix_rule(pattern = [\"node\", \".agents/aidlc/scripts/task-next.mjs\"], decision = \"allow\")",
  ""
].join("\n");

export const adapters: readonly Adapter[] = [
  {
    id: "claude",
    displayName: "Claude Code",
    detect: (root) => existsSync(join(root, "CLAUDE.md")) || existsSync(join(root, ".claude")),
    files: () => [
      { ...adapterFile("claude", "CLAUDE.md", instruction("Claude Code", "claude")), strategy: "managed-block" },
      { path: ".claude/settings.local.json", owner: "claude", content: claudeLocalSettings },
      ...(["clarify:Confirm requirements", "plan:Approve plan", "build:Review implementation", "wrap:none", "index:none"] as const).map((entry) => {
        const [phase, gate] = entry.split(":");
        return adapterFile("claude", `.claude/skills/aidlc-${phase}/SKILL.md`, claudeSkill(phase, gate));
      })
    ]
  },
  {
    id: "codex",
    displayName: "Codex",
    detect: (root) => existsSync(join(root, "AGENTS.md")) || existsSync(join(root, ".codex")),
    files: () => [
      { ...adapterFile("codex", "AGENTS.md", instruction("Codex", "codex")), strategy: "managed-block" },
      { path: ".codex/config.toml", owner: "codex", content: "approval_policy = \"on-request\"\nsandbox_mode = \"workspace-write\"\n" },
      { path: ".codex/rules/aidlc.rules", owner: "codex", content: codexExecPolicy }
    ]
  }
];

export const resolvedAdapters = (): readonly Adapter[] => adapters;
export const resolvedAdaptersForUpgrade = (): readonly Adapter[] => adapters;
export const installableAdapters = (): readonly Adapter[] => adapters;
export const findAdapter = (id: AgentId): Adapter | undefined => adapters.find((adapter) => adapter.id === id);
export const findAdapterForUpgrade = (id: AgentId): Adapter | undefined => adapters.find((adapter) => adapter.id === id);
