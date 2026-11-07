/**
 * Zero-config environment for the local loop daemon.
 *
 * Merges three sources, highest priority first:
 *   1. the invoking shell (`process.env`) — never overridden;
 *   2. the AIDLC env file (`AIDLC_ENV_FILE`, default `.agents/loop.env`), a minimal dotenv;
 *   3. values derived from the configured providers' own config files:
 *      - `AIDLC_LOOP_EVENT_LOG` → `.agents/data/loop/ui-events.jsonl` (dashboard live log);
 *      - `AIDLC_OPENCODE_MODEL` → `model` of the OpenCode config (project > OPENCODE_CONFIG > global);
 *      - worker credentials → OpenCode `auth.json`, Codex `$CODEX_HOME/auth.json`
 *        (`OPENAI_API_KEY`), Claude Code settings `env.ANTHROPIC_API_KEY` (local > project > user).
 *
 * Only providers listed in `loop.agents` are inspected. Secret values are never printed,
 * logged, written to disk, or returned in a report; the report names their source only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isLoopProvider, OPENCODE_MODEL } from "./loop-drivers.mjs";
import { workerCredentialKeys } from "./loop-worker-docker.mjs";

export const DEFAULT_ENV_FILE = ".agents/loop.env";
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_FILE_BYTES = 1024 * 1024;
/** The only values a report may show; every other variable (any env-file key) is "set"/"missing". */
const DISPLAY_KEYS = new Set(["AIDLC_OPENCODE_MODEL", "AIDLC_LOOP_EVENT_LOG", "AIDLC_WORKER_DOCKER_IMAGE", "AIDLC_LOCAL_WORKTREES_ROOT", "AIDLC_ENV_FILE"]);

export const isSecretKey = (key) => !DISPLAY_KEYS.has(key);

/** Minimal dotenv: `KEY=VALUE`, optional `export `, `#` comments, single/double quotes. No expansion. */
export function parseEnvFile(text, label = "env file") {
  const values = {};
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match || !KEY.test(match[1])) throw new Error(`${label}:${index + 1}: expected KEY=VALUE`);
    const [, key, rest] = match;
    let value = rest;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end < 0) throw new Error(`${label}:${index + 1}: unterminated ${quote === '"' ? "double" : "single"} quote`);
      const tail = value.slice(end + 1).trim();
      if (tail && !tail.startsWith("#")) throw new Error(`${label}:${index + 1}: unexpected text after the closing quote`);
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values[key] = value;
  });
  return values;
}

/** The env file to load: `AIDLC_ENV_FILE` (relative to root) or the default; `explicit` marks a user choice. */
export function resolveEnvFile(root, env = process.env) {
  const chosen = typeof env.AIDLC_ENV_FILE === "string" && env.AIDLC_ENV_FILE.trim() ? env.AIDLC_ENV_FILE.trim() : "";
  return { path: resolve(root, chosen || DEFAULT_ENV_FILE), explicit: Boolean(chosen) };
}

const realOrSelf = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const within = (base, target) => { const rel = relative(base, target); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

/**
 * Reads a small regular file (symlinks are followed). With `confine`, a symlinked file must
 * resolve inside the project or the home directory, both compared by their real paths so a
 * project reached through a symlink (macOS /tmp, ~/code -> /mnt/...) still works.
 */
function readTrustedFile(path, { root, home }, { confine = false } = {}) {
  if (!existsSync(path)) return undefined;
  const real = realpathSync(path);
  if (confine && lstatSync(path).isSymbolicLink() && !within(realOrSelf(root), real) && !(home && within(realOrSelf(home), real))) throw new Error(`${path} links outside the project and home directory`);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${path} is not a regular file`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB`);
  return readFileSync(real, "utf8");
}

/** JSON with `//` and block comments and trailing commas (OpenCode `.jsonc`). Strings are kept intact. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1); i = j; continue;
    }
    if (char === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i += 1; out += "\n"; continue; }
    if (char === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 1; continue; }
    out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const readJson = (path, context, { jsonc = false } = {}) => {
  try {
    const text = readTrustedFile(path, context);
    return text === undefined ? undefined : jsonc ? parseJsonc(text) : JSON.parse(text);
  } catch (error) {
    // Never echo a parser message: V8 quotes the source text around the error, which may be a key.
    const reason = error instanceof SyntaxError ? "not valid JSON" : error instanceof Error ? error.message : String(error);
    context.problems.push({ level: "warning", key: "", message: `ignored ${path}: ${reason}` });
    return undefined;
  }
};

/** Unique providers of `loop.agents` (lead first), and the worker subset. */
export function loopProviders(config) {
  const lead = config?.loop?.agents?.lead;
  const workers = Object.values(config?.loop?.agents?.workers ?? {}).filter(isLoopProvider);
  return { lead: isLoopProvider(lead) ? lead : undefined, workers: [...new Set(workers)], all: [...new Set([...(isLoopProvider(lead) ? [lead] : []), ...workers])] };
}

const xdg = (env, name, home, fallback) => (env[name] && isAbsolute(env[name]) ? env[name] : join(home, fallback));

/** OpenCode `model`, following its documented precedence (later wins): global < OPENCODE_CONFIG < project. */
function opencodeModel(context) {
  const { root, env, home } = context;
  const configDir = join(xdg(env, "XDG_CONFIG_HOME", home, ".config"), "opencode");
  const candidates = [
    join(configDir, "opencode.json"), join(configDir, "opencode.jsonc"),
    ...(env.OPENCODE_CONFIG ? [resolve(root, env.OPENCODE_CONFIG)] : []),
    join(root, "opencode.json"), join(root, "opencode.jsonc"),
  ];
  let found;
  for (const path of candidates) {
    const config = readJson(path, context, { jsonc: true });
    if (typeof config?.model === "string" && config.model.trim()) found = { value: config.model.trim(), source: `derived:${path}` };
  }
  return found;
}

/** Worker credentials a provider's own login/config can supply, as `{ key, value, source }`. */
function providerCredentials(provider, env, context) {
  const { root, home } = context;
  if (provider === "opencode") {
    const path = join(xdg(env, "XDG_DATA_HOME", home, join(".local", "share")), "opencode", "auth.json");
    const auth = readJson(path, context);
    if (!auth || typeof auth !== "object") return [];
    const prefix = String(env.AIDLC_OPENCODE_MODEL ?? "").split("/")[0];
    const keys = workerCredentialKeys("opencode", env);
    // The OpenCode Zen/Go key only stands in for OPENCODE_API_KEY, never for a provider's own key.
    const ids = keys.includes("OPENCODE_API_KEY") ? [prefix, "opencode", "opencode-go"] : [prefix];
    const entry = ids.map((id) => auth[id]).find((value) => value?.type === "api" && typeof value.key === "string" && value.key);
    return entry ? keys.map((key) => ({ key, value: entry.key, source: `derived:${path}` })) : [];
  }
  if (provider === "codex") {
    const path = join(env.CODEX_HOME && isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : join(home, ".codex"), "auth.json");
    const auth = readJson(path, context);
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) return [{ key: "OPENAI_API_KEY", value: auth.OPENAI_API_KEY, source: `derived:${path}` }];
    if (auth?.tokens) context.notes.push({ provider, message: "Codex is signed in with ChatGPT; Docker workers need an API key (codex login --with-api-key, or OPENAI_API_KEY in the env file)" });
    return [];
  }
  if (provider === "claude") {
    const userDir = env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : join(home, ".claude");
    let found = [];
    for (const path of [join(userDir, "settings.json"), join(root, ".claude", "settings.json"), join(root, ".claude", "settings.local.json")]) {
      const value = readJson(path, context)?.env?.ANTHROPIC_API_KEY;
      if (typeof value === "string" && value) found = [{ key: "ANTHROPIC_API_KEY", value, source: `derived:${path}` }];
    }
    return found;
  }
  return [];
}

/** True when `command` resolves on PATH (PATHEXT-aware on Windows). */
export function hasCommand(command, env = process.env) {
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  return String(env.PATH ?? "").split(delimiter).filter(Boolean).some((dir) => exts.some((ext) => { try { return statSync(join(dir, command + ext)).isFile(); } catch { return false; } }));
}

/** Whether git would ignore the env file; outside a work tree there is nothing to commit. */
const gitignored = (root, envFile) => {
  const rel = relative(root, envFile);
  if (rel.startsWith("..") || isAbsolute(rel)) return true;
  const result = spawnSync("git", ["check-ignore", "-q", "--", rel.split(sep).join("/")], { cwd: root, stdio: "ignore", timeout: 5000 });
  return result.error ? true : result.status !== 1;
};

/**
 * Resolves the daemon environment. `applied` holds only the keys to add to the
 * process (file + derived); shell keys are left untouched. `problems` with level
 * `error` must stop the daemon before it starts.
 */
export function loadLoopEnv({ root, config, env = process.env, home = homedir(), commandExists = hasCommand } = {}) {
  root = resolve(root ?? ".");
  const problems = [], notes = [];
  const context = { root, env, home, problems, notes };
  const providers = loopProviders(config);
  const mode = config?.loop?.mode ?? "off";
  const sources = {}, applied = {};
  const merged = { ...env };
  // Anything the shell exports, even an empty value, is never overridden.
  const set = (key, value, source) => { if (merged[key] !== undefined) return false; merged[key] = value; applied[key] = value; sources[key] = source; return true; };
  for (const key of Object.keys(env)) sources[key] = "shell";

  const envFile = resolveEnvFile(root, env);
  let fileKeys = [];
  try {
    const text = readTrustedFile(envFile.path, context, { confine: true });
    if (text === undefined) {
      if (envFile.explicit) problems.push({ level: "error", key: "AIDLC_ENV_FILE", message: `env file not found: ${envFile.path}` });
    } else {
      const values = parseEnvFile(text, relative(root, envFile.path) || envFile.path);
      fileKeys = Object.keys(values);
      for (const [key, value] of Object.entries(values)) if (value !== "") set(key, value, "file");
      if (!gitignored(root, envFile.path)) problems.push({ level: "warning", key: "", message: `${relative(root, envFile.path)} is not git-ignored; add "loop.env" to .agents/.gitignore so credentials are never committed` });
    }
  } catch (error) {
    problems.push({ level: "error", key: "AIDLC_ENV_FILE", message: error instanceof Error ? error.message : String(error) });
  }

  if (mode !== "local" && mode !== "fleet") problems.push({ level: "error", key: "", message: 'loop.mode is off: set "loop": { "mode": "local", "agents": { "lead": "<codex|claude|opencode>", "workers": { "worker-a": "<provider>" } } } in .agents/config.json, or run: aidlc-kit init --loop-mode local' });
  else if (!providers.lead || !providers.workers.length) problems.push({ level: "error", key: "", message: 'loop.agents needs a lead and at least one worker provider (codex, claude, or opencode) in .agents/config.json' });

  set("AIDLC_LOOP_EVENT_LOG", join(root, ".agents", "data", "loop", "ui-events.jsonl"), "derived");

  const keys = new Set(["AIDLC_LOOP_EVENT_LOG"]);
  if (providers.all.includes("opencode")) {
    keys.add("AIDLC_OPENCODE_MODEL");
    if (!merged.AIDLC_OPENCODE_MODEL) { const found = opencodeModel(context); if (found) set("AIDLC_OPENCODE_MODEL", found.value, found.source); }
    const model = merged.AIDLC_OPENCODE_MODEL;
    if (model === "" && sources.AIDLC_OPENCODE_MODEL === "shell") problems.push({ level: "error", key: "AIDLC_OPENCODE_MODEL", message: "AIDLC_OPENCODE_MODEL is exported empty in the shell, which overrides the env file and opencode.json: unset it or set provider/model" });
    else if (!model) problems.push({ level: "error", key: "AIDLC_OPENCODE_MODEL", message: `opencode needs a model: add AIDLC_OPENCODE_MODEL=<provider/model> to ${relative(root, envFile.path)} or set "model" in opencode.json (list models with: opencode models)` });
    else if (!OPENCODE_MODEL.test(model)) problems.push({ level: "error", key: "AIDLC_OPENCODE_MODEL", message: `AIDLC_OPENCODE_MODEL must look like provider/model[#variant] (from ${sources.AIDLC_OPENCODE_MODEL})` });
  }

  const workerKeys = new Set();
  for (const provider of providers.workers) {
    const needed = workerCredentialKeys(provider, merged);
    needed.forEach((key) => workerKeys.add(key));
    if (needed.every((key) => merged[key])) { needed.forEach((key) => keys.add(key)); continue; }
    for (const credential of providerCredentials(provider, merged, context)) set(credential.key, credential.value, credential.source);
    for (const key of needed) {
      keys.add(key);
      if (!merged[key]) {
        const note = notes.find((entry) => entry.provider === provider);
        problems.push({ level: "warning", key, message: note ? note.message : `${provider} workers need ${key} for the build phase: add it to ${relative(root, envFile.path)}` });
      }
    }
  }

  if (mode === "local" && !commandExists("docker", merged)) problems.push({ level: "warning", key: "", message: "docker was not found on PATH; local workers run in Docker during the build phase" });
  for (const key of ["AIDLC_WORKER_DOCKER_IMAGE", "AIDLC_LOCAL_WORKTREES_ROOT", ...fileKeys]) if (merged[key]) keys.add(key);

  const entries = [...keys].map((key) => {
    const secret = isSecretKey(key);
    const present = Boolean(merged[key]);
    return { key, set: present, source: present ? sources[key] ?? "shell" : null, secret, ...(present && !secret ? { value: merged[key] } : {}) };
  });
  // Worker keys detected from another tool's config reach Docker workers only, never the
  // host lead (a claude/codex lead would otherwise switch from its own login to API-key
  // billing). Env-file keys are explicit, like shell exports, and reach the lead too.
  const leadExclude = [...workerKeys].filter((key) => key in applied && String(sources[key]).startsWith("derived:"));
  if (leadExclude.length) applied.AIDLC_LEAD_ENV_EXCLUDE = leadExclude.join(",");
  return { root, mode, providers: providers.all, envFile: { path: envFile.path, explicit: envFile.explicit, loaded: fileKeys.length > 0 || existsSync(envFile.path) }, entries, problems, applied, ok: !problems.some((problem) => problem.level === "error") };
}

/** A report safe to print: the `applied` values are dropped. */
export const publicReport = ({ applied: _applied, ...report }) => report;

export function formatLoopEnvReport(report) {
  const lines = [];
  lines.push(`Loop environment (${report.mode} mode)`);
  lines.push(`  providers : ${report.providers.length ? report.providers.join(", ") : "none configured"}`);
  lines.push(`  env file  : ${report.envFile.path}${report.envFile.loaded ? "" : " (not found)"}`);
  const width = Math.max(4, ...report.entries.map((entry) => entry.key.length));
  for (const entry of report.entries) {
    const shown = !entry.set ? "missing" : entry.secret ? "set" : entry.value;
    lines.push(`  ${entry.set ? "✓" : "✗"} ${entry.key.padEnd(width)}  ${shown}${entry.source ? `  [${entry.source}]` : ""}`);
  }
  for (const problem of report.problems) lines.push(`  ${problem.level === "error" ? "ERROR" : "WARN "} ${problem.message}`);
  if (report.ok) lines.push("  ready: the daemon can start");
  return lines.join("\n");
}
