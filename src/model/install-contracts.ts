/* Installation-adapter contracts: every supported coding tool is adapted to the same kernel. */
import type { AgentId } from "./lifecycle-enums.js";
import type { LoopConfig } from "./loop.js";

export interface FileSpec {
  path: string;
  content: string;
  owner: string;
  strategy?: "replace" | "managed-block";
  ownershipClass?: "managed" | "project" | "state";
}

export interface Adapter {
  id: AgentId;
  displayName: string;
  detect(root: string): boolean;
  files(): FileSpec[];
}

export interface PlannedWrite extends FileSpec {
  action: "create" | "update" | "delete" | "skip" | "conflict" | "migrate" | "preserve";
  reason: string;
  contentEncoding?: "base64";
}

export interface InitOptions {
  root: string;
  agents: AgentId[];
  all: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
  loop?: LoopConfig;
}
