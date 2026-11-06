/* Agent-loop coordination contracts: loop modes, the provider roster, and loop configuration. */
export type LoopMode = "off" | "local" | "fleet";
export const LOOP_PROVIDERS = Object.freeze(["codex", "claude", "opencode"] as const);
export type LoopAgent = (typeof LOOP_PROVIDERS)[number];
export interface LoopConfig {
  mode: LoopMode;
  agents?: { lead: LoopAgent; workers: Record<string, LoopAgent> };
  workerImage?: Partial<Record<LoopAgent, string>>;
  /** Local daemon canonical-state poll interval (1000–300000 ms). */
  pollMs?: number;
  /** Per-run lead loop limits; bounds mirror `validateLimits` in loop-runtime.mjs. */
  limits?: LoopLimits;
}

export interface LoopLimits {
  maxTurns?: number;
  turnTimeoutMs?: number;
  maxStallTurns?: number;
}
