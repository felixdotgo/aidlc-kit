import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, FileSpec, WorkflowManifest } from "./model.js";
import { defaultConfig } from "./profiles.js";
import { createLessonIndex, digest, emptyMemoryRegistry, emptyState, lessonStateDigest } from "./state.js";

const owner = "aidlc-core";
const assetRoot = fileURLToPath(new URL("../assets/.agents", import.meta.url));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };

// node:crypto update() hashes Uint8Array bytes unchanged; the cast only satisfies digest's narrower parameter type.
export const contentHash = (content: string | Uint8Array): string => digest(content as string);

const collect = (directory: string, target: string): FileSpec[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const source = join(directory, entry.name);
  const destination = `${target}/${entry.name}`;
  return entry.isDirectory() ? collect(source, destination) : [{ path: destination, content: readFileSync(source, "utf8"), owner, ownershipClass: "managed" }];
});

export const coreWorkflowFiles = (): FileSpec[] => [
  ...collect(join(assetRoot, "aidlc"), ".agents/aidlc"),
  ...collect(join(assetRoot, "skills"), ".agents/skills")
];

/** Commented template for the loop daemon's env file; seeded once and never overwritten. */
export const LOOP_ENV_TEMPLATE = `# AI-DLC loop environment, read by \`loop.sh up\` / \`aidlc-kit loop start\` (local mode).
# Precedence: shell exports > this file > values detected from your tools' own config.
# Keep real keys here only; .agents/.gitignore excludes this file from git.
# See what the loop will use with:  .agents/aidlc/scripts/loop.sh check
#
# --- OpenCode (lead or workers set to "opencode") ---
# Model as provider/model[#variant] (list them with: opencode models).
# When unset, "model" from opencode.json is used.
# AIDLC_OPENCODE_MODEL=opencode-go/<model>
# Worker key; when unset it is read from ~/.local/share/opencode/auth.json.
# The key follows the model prefix: openai/ -> OPENAI_API_KEY, anthropic/ -> ANTHROPIC_API_KEY, otherwise OPENCODE_API_KEY.
# OPENCODE_API_KEY=
#
# --- Codex workers ---
# When unset, read from ~/.codex/auth.json (after: codex login --with-api-key).
# OPENAI_API_KEY=
#
# --- Claude Code workers ---
# When unset, read from "env" in .claude/settings.local.json, .claude/settings.json, or ~/.claude/settings.json.
# ANTHROPIC_API_KEY=
#
# --- Optional ---
# Override the auto-built worker image:
# AIDLC_WORKER_DOCKER_IMAGE=
# Where worker worktrees live (default: the system temp directory):
# AIDLC_LOCAL_WORKTREES_ROOT=
`;

/** Installed files that must be executable (POSIX launchers). */
export const isExecutableAsset = (path: string): boolean => path.endsWith(".sh");

export const initialProjectFiles = (): FileSpec[] => [
  { path: ".agents/config.json", owner: "aidlc-project", ownershipClass: "project", content: `${JSON.stringify(defaultConfig(), null, 2)}\n` },
  { path: ".agents/data/state/aidlc-state.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(emptyState(), null, 2)}\n` },
  { path: ".agents/data/lessons/index.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(createLessonIndex([], lessonStateDigest(emptyState())), null, 2)}\n` },
  { path: ".agents/data/memory/agentic-memory.json", owner: "aidlc-memory", ownershipClass: "project", content: `${JSON.stringify(emptyMemoryRegistry(), null, 2)}\n` },
  { path: ".agents/loop.env", owner: "aidlc-project", ownershipClass: "project", content: LOOP_ENV_TEMPLATE },
  { path: ".agents/.gitignore", owner: "aidlc-project", ownershipClass: "project", content: "# Local loop credentials (aidlc-kit)\nloop.env\n# Loop daemon/process state and per-task runtime data (aidlc-kit)\ndata/loop/\ndata/tasks/*/runtime/\n" }
];

export const manifestKey = (spec: Pick<FileSpec, "path" | "owner" | "strategy">): string => spec.strategy === "managed-block" ? `${spec.path}#${spec.owner}` : spec.path;

export const manifestFor = (files: FileSpec[], adapters: AgentId[]): WorkflowManifest => ({
  schemaVersion: 2,
  packageVersion: packageJson.version,
  workflow: "AI-DLC",
  source: "local-package-assets",
  remoteUpdates: false,
  managedBy: "aidlc-kit",
  adapters,
  files: Object.fromEntries(files.filter((file) => file.ownershipClass === "managed" || !file.ownershipClass).map((file) => [manifestKey(file), {
    hash: contentHash(file.strategy === "managed-block" ? file.content.trimEnd() : file.content),
    owner: file.owner,
    strategy: file.strategy ?? "replace"
  }]))
});

export const manifestSpec = (files: FileSpec[], adapters: AgentId[]): FileSpec => ({
  path: ".agents/aidlc/manifest.json",
  owner,
  ownershipClass: "managed",
  content: `${JSON.stringify(manifestFor(files, adapters), null, 2)}\n`
});

export const packageVersion = (): string => packageJson.version;
