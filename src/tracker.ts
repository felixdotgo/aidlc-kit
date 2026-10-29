/**
 * Backlog tracker integration: resolves tracker credentials from the environment
 * and builds the HTTP requests used to mirror lifecycle phase transitions.
 */
import type { TrackerConfig } from "./model.js";

export interface TrackerDiagnostic { code: "TRACKER_DISABLED" | "TRACKER_AUTH" | "TRACKER_RATE_LIMIT" | "TRACKER_REQUEST"; message: string; retryable: boolean; }
export interface BacklogRequest { method: "GET" | "PATCH"; path: string; form?: Record<string, string | number>; }
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TrackerResolution =
  | { enabled: false; diagnostic: TrackerDiagnostic }
  | { enabled: true; config: TrackerConfig; token: string };

/** Resolves a tracker configuration into either an enabled resolution (with token) or a disabled diagnostic. */
export const resolveTracker = (config: TrackerConfig | undefined, environment: NodeJS.ProcessEnv = process.env): TrackerResolution => {
  if (!config) return { enabled: false, diagnostic: { code: "TRACKER_DISABLED", message: "Tracker is not configured; Git-only mode is active.", retryable: false } };
  const token = environment[config.tokenEnv];
  if (!token) return { enabled: false, diagnostic: { code: "TRACKER_DISABLED", message: `Backlog tracker is disabled because ${config.tokenEnv} is unavailable.`, retryable: false } };
  return { enabled: true, config, token };
};

const form = (values: Record<string, string | number>): URLSearchParams => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, String(value));
  return body;
};

/** Executes a single Backlog request, mapping HTTP failures to retryable diagnostics. */
export const executeBacklog = async (resolution: TrackerResolution, request: BacklogRequest, fetcher: FetchLike = fetch): Promise<{ ok: true; body: unknown } | { ok: false; diagnostic: TrackerDiagnostic }> => {
  if (!resolution.enabled) return { ok: false, diagnostic: resolution.diagnostic };
  const response = await fetcher(`${resolution.config.spaceUrl}/api/v2/${request.path.replace(/^\//, "")}`, {
    method: request.method,
    headers: { Authorization: `Bearer ${resolution.token}`, ...(request.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: request.form ? form(request.form) : undefined
  });
  if (response.status === 401) return { ok: false, diagnostic: { code: "TRACKER_AUTH", message: "Backlog authentication failed; Git state was not changed.", retryable: false } };
  if (response.status === 429) return { ok: false, diagnostic: { code: "TRACKER_RATE_LIMIT", message: "Backlog rate limit reached; retry after the provider reset window.", retryable: true } };
  if (!response.ok) return { ok: false, diagnostic: { code: "TRACKER_REQUEST", message: `Backlog request failed with HTTP ${response.status}.`, retryable: response.status >= 500 } };
  return { ok: true, body: await response.json() };
};

/** Builds the Backlog PATCH request that mirrors a lifecycle phase transition for an issue. */
export const gateUpdate = (config: TrackerConfig, issue: string, phase: "clarify" | "plan" | "build" | "wrap" | "done", idempotencyKey: string): BacklogRequest => {
  const comment = `[aidlc:${idempotencyKey}] ${phase}`;
  if (config.workflow === "waterfall") {
    const statusId = config.mapping.statuses?.[phase];
    if (!statusId) throw new Error(`Backlog status mapping is required for Waterfall phase: ${phase}`);
    return { method: "PATCH", path: `issues/${issue}`, form: { statusId, comment } };
  }
  const field = config.mapping.gateFieldId;
  return { method: "PATCH", path: `issues/${issue}`, form: { ...(field ? { [`customField_${field}`]: phase } : {}), comment } };
};
