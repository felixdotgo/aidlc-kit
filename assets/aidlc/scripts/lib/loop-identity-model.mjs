/**
 * Model-derived loop identity: asks the configured lead model (AIDLC_OPENCODE_MODEL,
 * invoked through the host opencode CLI) for a one-line task title and a kebab-case
 * id. Purely advisory: any failure, timeout, or invalid answer returns null so the
 * caller falls back to the slugify derivation (`deriveTaskIdentity`). Never throws.
 */
import { normalizeTitle } from "./store.mjs";

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const FENCE = /^```(?:json)?\s*/i;

const identityPrompt = (requirement) => [
  "Derive a task title and id for the requirement below.",
  'Respond with STRICT JSON only — no commentary, no markdown fences: {"title":"<one line, at most 100 characters, no trailing dot>","slug":"<lowercase kebab-case ASCII, at most 48 characters>"}',
  "",
  "Requirement:",
  requirement,
].join("\n");

/** Parse a strict-JSON identity out of the model's answer; null on anything unusable. */
const parseIdentity = (text) => {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(FENCE, "").trim().replace(/```\s*$/, "").trim();
  const match = /\{[\s\S]*\}/.exec(cleaned);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.title !== "string" || !parsed.title.trim() || parsed.title.trim().length > 100) return null;
  if (typeof parsed.slug !== "string" || !SLUG.test(parsed.slug)) return null;
  return { title: normalizeTitle(parsed.title), slug: parsed.slug };
};

/** Default runner: one non-interactive lead turn using the same host CLI invocation
 * as the loop lead (see `loop-drivers.mjs`); returns the collected result text. */
const defaultRun = async ({ model, prompt, timeoutMs, env }) => {
  const { runAgentTurn } = await import("./loop-drivers.mjs");
  const { spawn } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const { resultText } = await runAgentTurn({ agent: "opencode", root: resolve((env ?? process.env).PWD ?? "."), prompt, timeoutMs, env: { ...(env ?? process.env), AIDLC_OPENCODE_MODEL: model }, spawnProcess: spawn });
  return resultText;
};

/** Ask the configured lead model for `{ title, slug }`; null when there is no model,
 * the runner fails or times out, or the answer fails validation. */
export async function deriveLoopIdentity(requirement, { model, timeoutMs = 60000, env = process.env, run = defaultRun } = {}) {
  if (typeof model !== "string" || !model.trim()) return null;
  if (typeof requirement !== "string" || !requirement.trim()) return null;
  try {
    const result = await Promise.race([
      run({ model: model.trim(), prompt: identityPrompt(requirement), timeoutMs, env }),
      new Promise((_, rejectTimeout) => {
        const timer = setTimeout(() => rejectTimeout(new Error(`identity derivation timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return parseIdentity(result);
  } catch { return null; } /* intentional: model answers are advisory only */
}
