import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, FileSpec, WorkflowManifest } from "./model.js";
import { defaultConfig } from "./profiles.js";
import { createLessonIndex, emptyMemoryRegistry, emptyState, lessonStateDigest } from "./state.js";

const owner = "aidlc-core";
const assetRoot = fileURLToPath(new URL("../assets/.agents", import.meta.url));
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version: string };

export const contentHash = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const collect = (directory: string, target: string): FileSpec[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const source = join(directory, entry.name);
  const destination = `${target}/${entry.name}`;
  return entry.isDirectory() ? collect(source, destination) : [{ path: destination, content: readFileSync(source, "utf8"), owner, ownershipClass: "managed" }];
});

export const coreWorkflowFiles = (): FileSpec[] => [
  ...collect(join(assetRoot, "aidlc"), ".agents/aidlc"),
  ...collect(join(assetRoot, "skills"), ".agents/skills")
];

export const initialProjectFiles = (): FileSpec[] => [
  { path: ".agents/config.json", owner: "aidlc-project", ownershipClass: "project", content: `${JSON.stringify(defaultConfig(), null, 2)}\n` },
  { path: ".agents/data/state/aidlc-state.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(emptyState(), null, 2)}\n` },
  { path: ".agents/data/lessons/index.json", owner: "aidlc-state", ownershipClass: "state", content: `${JSON.stringify(createLessonIndex([], lessonStateDigest(emptyState())), null, 2)}\n` },
  { path: ".agents/data/memory/agentic-memory.json", owner: "aidlc-memory", ownershipClass: "project", content: `${JSON.stringify(emptyMemoryRegistry(), null, 2)}\n` }
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
