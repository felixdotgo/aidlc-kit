/* Workflow-configuration contracts: profiles, project config, coordination, and tracker integration. */
import type { AgentId, RiskLevel, StateMutationMode } from "./lifecycle-enums.js";
import type { LoopConfig } from "./loop.js";

export interface CommandSpec {
  command: string;
  args: string[];
}

export interface Profile {
  schemaVersion: 1;
  id: string;
  extends?: string[];
  topology: string;
  discovery?: { roots?: string[]; workspaceMarkers?: string[] };
  specs?: { roots?: string[] };
  commands?: Record<string, CommandSpec>;
  rules?: { include?: string[] };
}

export interface ProjectConfig {
  $schema?: string;
  schemaVersion: 1 | 2 | 3;
  extends: string[];
  specs: { roots: string[] };
  commands: Record<string, CommandSpec>;
  rules: { include: string[] };
  risk: { default: RiskLevel };
  context: { maxChars: number };
  agentState: Partial<Record<AgentId, StateMutationMode>>;
  tracker?: TrackerConfig;
  mcp: McpConfig;
  loop?: LoopConfig;
}

export interface McpConfig {
  enabled: boolean;
  endpoint?: string;
  workspace?: string;
  tokenEnv?: string;
  pollMs?: number;
  providers?: Array<"jira" | "trello" | "github-issues">;
}

export interface TrackerConfig {
  enabled: boolean;
  provider: "backlog";
  spaceUrl: string;
  project: string;
  tokenEnv: string;
  workflow: "waterfall" | "scrum";
  mapping: { statuses?: Partial<Record<"clarify" | "plan" | "build" | "wrap" | "done", number>>; gateFieldId?: number };
}
