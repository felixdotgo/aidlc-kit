/* Agent-loop coordination contracts: loop modes, the provider roster, and loop configuration. */
export type LoopMode = "off" | "local" | "fleet";
export const LOOP_PROVIDERS = Object.freeze(["codex", "claude", "opencode"] as const);
export type LoopAgent = (typeof LOOP_PROVIDERS)[number];
export interface LoopConfig {
  mode: LoopMode;
  agents?: { lead: LoopAgent; workers: Record<string, LoopAgent> };
  workerImage?: Partial<Record<LoopAgent, string>>;
}
