/**
 * Local web UI for the AI-DLC loop and task status.
 *
 * Read-only over canonical local state (`.agents/data/state/aidlc-state.json`).
 * Loop start/resume are thin facades that spawn the installed `loop-entry.mjs`
 * exactly as `aidlc-kit loop` does; gate approval is a thin facade that spawns
 * the same atomic `state.mjs gate approve` command, and gate feedback spawns the
 * audited `state.mjs task status … --status active --mode audited` cancel (the
 * task stays at its gate; the loop lead revises and re-presents it). This module
 * never mutates lifecycle state itself and never bypasses the fail-closed gate
 * channel.
 *
 * Built on `node:http` only; Bulma CSS and the dashboard theme layer are
 * vendored static assets (no CDN, no runtime npm dependency). Mutating actions (loop start/resume, gate
 * feedback, gate approve) require a per-session token generated at server start
 * and printed once to the terminal.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import type { TaskState, WorkflowState } from "./model.js";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGate, gateView } from "./gate.js";
import { assertTaskArtifactPath, listTaskSummaries, loadState, loadTask } from "./state.js";

export type UiAuthorityMode = "local" | "fleet";

export interface UiOptions {
  root: string;
  host: string;
  port: number;
  token?: string;
  /** Loop authority the dashboard reads and acts on; defaults to `.agents/config.json` `loop.mode` (local unless fleet). */
  mode?: UiAuthorityMode;
  /** Fleet reviewer credential held server-side; passed only to the approve child process. */
  reviewerToken?: string;
}

/** Credentials that never reach the daemon or read-only child processes. */
const SCRUBBED_ENV = ["AIDLC_FLEET_REVIEWER_TOKEN", "AIDLC_UI_TOKEN", "AIDLC_UI_TOKEN_FILE", "AIDLC_UI_REVIEWER_TOKEN_FILE"];
export const scrubbedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRUBBED_ENV) delete env[name];
  return { ...env, ...extra };
};

/**
 * Fixed token from a file (`--token-file`, `--reviewer-token-file`) so the browser stays signed in across
 * UI restarts. The file must live outside the project (agents work inside it), be a regular non-symlink
 * file, and be private to the owner (mode 600/400). With `create`, a missing file is created with a
 * random token. The token is never passed to the daemon, lead, or workers.
 */
export const readUiTokenFile = (root: string, path: string, { create }: { create: boolean }): string => {
  const target = resolve(path); const project = resolve(root);
  if (target === project || target.startsWith(`${project}${sep}`)) throw new Error("Token file must live outside the project directory");
  if (!existsSync(target)) {
    if (!create) throw new Error(`Token file not found: ${target}`);
    const token = randomBytes(32).toString("base64url");
    writeFileSync(target, `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Token file must be a regular file, not a symlink");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Token file must be private to its owner (chmod 600 ${target})`);
  const token = readFileSync(target, "utf8").trim();
  if (token.length < 16 || token.length > 256 || /\s/.test(token)) throw new Error("Token file must contain one token of 16–256 non-whitespace characters");
  return token;
};

/** Best-effort browser launch for `aidlc-kit ui --open`; failures are ignored (the URL is printed anyway). */
export const openBrowser = (url: string): void => {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" }); child.on("error", () => { /* no browser launcher */ }); child.unref(); }
  catch { /* no browser launcher */ }
};

/** The configured loop authority: `fleet` only when `loop.mode` says so; everything else reads local state. */
export const resolveUiMode = (root: string): UiAuthorityMode => {
  try { return (JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8")) as { loop?: { mode?: unknown } })?.loop?.mode === "fleet" ? "fleet" : "local"; }
  catch { return "local"; }
};
const uiMode = (options: UiOptions): UiAuthorityMode => options.mode ?? "local";

const loopEntryPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs");
const stateScriptPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "state.mjs");
const loopDataDir = (root: string): string => join(root, ".agents", "data", "loop");
const eventsLogPath = (root: string): string => join(loopDataDir(root), "ui-events.jsonl");
const daemonLockPath = (root: string): string => join(loopDataDir(root), "daemon.lock");
const daemonLogPath = (root: string): string => join(loopDataDir(root), "daemon.log");
const loopArgs = (root: string, action: string, taskId = ""): string[] => [loopEntryPath(root), action, taskId, root, "", "", "", ""];

const ARTIFACT_NAMES = ["intent", "design", "workplan"] as const;
const PHASES = ["clarify", "plan", "build", "wrap", "done"] as const;
/** Upper bound on dashboard cards (matches the `listTaskSummaries` page cap). */
const DASHBOARD_LIMIT = 100;

/** Vendored Bulma plus the dashboard theme layer, read once and cached. */
const STYLESHEETS = new Map([["/assets/bulma.css", "bulma.min.css"], ["/assets/dashboard.css", "dashboard.css"]]);
const stylesheetCache = new Map<string, string>();
const stylesheet = (route: string): string | undefined => {
  const file = STYLESHEETS.get(route);
  if (!file) return undefined;
  const cached = stylesheetCache.get(route);
  if (cached !== undefined) return cached;
  let css = "";
  try { css = readFileSync(fileURLToPath(new URL(`../assets/ui/${file}`, import.meta.url)), "utf8"); }
  catch { /* serve an empty stylesheet rather than failing the page */ }
  stylesheetCache.set(route, css);
  return css;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const sendHtml = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const sendCss = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" });
  res.end(body);
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => {
  switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return "&#39;";
  }
});

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { reject(new BadRequest("Request body exceeds 8192 bytes")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const decode = (value: string): string => { try { return decodeURIComponent(value.replace(/\+/g, " ")); } catch { return value; } };

const parseForm = (body: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [rawKey, rawValue = ""] = pair.split("=");
    const key = decode(rawKey ?? "");
    if (key) result[key] = decode(rawValue);
  }
  return result;
};

const isJson = (contentType: string | undefined): boolean => (contentType ?? "").includes("application/json");

/** A client error mapped to HTTP 400 by the request handler. */
class BadRequest extends Error {}

const readFields = (body: string, contentType: string | undefined): Record<string, string> => {
  if (isJson(contentType)) {
    let value: unknown;
    try { value = JSON.parse(body); } catch { throw new BadRequest("Request body is not valid JSON"); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BadRequest("JSON body must be an object");
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") result[key] = entry;
    return result;
  }
  return parseForm(body);
};

/** The approve token travels only in a header (`Authorization: Bearer` or `x-aidlc-token`). A custom
 * header forces a CORS preflight, so a cross-site form or `no-cors` request can never carry it; a body
 * field would (classic CSRF), so it is not accepted. */
const suppliedToken = (req: IncomingMessage): string => {
  const authorization = req.headers["authorization"];
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  const header = req.headers["x-aidlc-token"];
  return typeof header === "string" ? header.trim() : "";
};

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
/** DNS-rebinding and CSRF guard: the Host header must name the bound address (any loopback name when
 * bound to loopback; a wildcard bind cannot be pinned and relies on the token and Origin check), and a
 * state-changing request that carries an Origin must be same-origin. */
export const requestAllowed = (options: Pick<UiOptions, "host">, req: IncomingMessage): { ok: true } | { ok: false; error: string } => {
  const host = String(req.headers.host ?? "").toLowerCase();
  const port = req.socket?.localPort;
  const bind = (options.host || "127.0.0.1").toLowerCase();
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === "[::]";
  if (!wildcard) {
    const named = bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind;
    const loopback = LOOPBACK_HOSTS.includes(named) || named === "::1";
    const allowed = new Set([named, ...(loopback ? LOOPBACK_HOSTS : [])].map((name) => `${name}:${port}`));
    if (!allowed.has(host)) return { ok: false, error: "Host header does not match this dashboard; open it at its bound address" };
  }
  const method = req.method ?? "GET";
  const origin = req.headers.origin;
  if (method !== "GET" && method !== "HEAD" && origin !== undefined && origin !== `http://${host}`) return { ok: false, error: "Cross-origin request rejected" };
  return { ok: true };
};

const tokenMatches = (token: string, supplied: string): boolean => {
  if (!token || !supplied) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
};

/** Runs an installed workflow script with the current Node binary without
 * blocking the event loop; rejects with the child's stderr attached. */
const runNode = (root: string, args: string[], options: { input?: string; timeout: number; env?: Record<string, string> }): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    const child = execFile(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: options.timeout, env: scrubbedEnv(options.env) }, (error, stdout, stderr) => {
      if (error) { rejectRun(Object.assign(error, { stderr })); return; }
      resolveRun(stdout);
    });
    child.stdin?.end(options.input ?? "");
  });

export interface DaemonStatus { running: boolean; pid: number | null; startedAt: string | null }

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};

/** Reads the singleton loop daemon lock written by `loop-daemon.mjs`. */
export const daemonStatus = (root: string): DaemonStatus => {
  try {
    const lock = JSON.parse(readFileSync(daemonLockPath(root), "utf8")) as { pid?: unknown; startedAt?: unknown };
    const pid = typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0 ? lock.pid : null;
    return { running: pid !== null && pidAlive(pid), pid, startedAt: typeof lock.startedAt === "string" ? lock.startedAt : null };
  } catch {
    return { running: false, pid: null, startedAt: null };
  }
};

export interface DaemonError { taskId?: string; message: string; at?: string; failures?: number; retryInMs?: number }
/** How much of the event-log tail the daemon health check scans. */
const HEALTH_TAIL_BYTES = 64 * 1024;

/**
 * Unresolved daemon errors from the tail of the event-log sidecar: a task's
 * `daemon_turn_error` stays open until a later `daemon_turn` for that task, a
 * poll that no longer lists it as actionable, or a daemon restart; a
 * `daemon_poll_error` stays open until the next successful poll.
 */
export const daemonHealth = (root: string): DaemonError[] => {
  const path = eventsLogPath(root);
  let text = "";
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - HEALTH_TAIL_BYTES);
    text = readRange(path, start, size).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
  } catch { return []; }
  const turnErrors = new Map<string, DaemonError>();
  let pollError: DaemonError | null = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!event || typeof event !== "object") continue;
    const taskId = typeof event.taskId === "string" ? event.taskId : undefined;
    const record = (): DaemonError => ({
      ...(taskId ? { taskId } : {}),
      message: typeof event.message === "string" ? event.message : "error",
      ...(typeof event.at === "string" ? { at: event.at } : {}),
      ...(typeof event.failures === "number" ? { failures: event.failures } : {}),
      ...(typeof event.retryInMs === "number" ? { retryInMs: event.retryInMs } : {}),
    });
    switch (event.type) {
      case "daemon_start": turnErrors.clear(); pollError = null; break;
      case "daemon_poll_error": pollError = record(); break;
      case "daemon_poll": {
        pollError = null;
        const actionable = Array.isArray(event.actionable) ? event.actionable : [];
        for (const id of [...turnErrors.keys()]) if (!actionable.includes(id)) turnErrors.delete(id);
        break;
      }
      case "daemon_turn": if (taskId) turnErrors.delete(taskId); break;
      case "daemon_turn_error": if (taskId) turnErrors.set(taskId, record()); break;
      default: break;
    }
  }
  return [...(pollError ? [pollError] : []), ...turnErrors.values()];
};

/** Starts the local daemon unless a live one already holds the singleton lock.
 * The daemon's stderr goes to `daemon.log` so start-up failures are visible. */
const ensureDaemon = (root: string): { pid: number | null; started: boolean } => {
  const current = daemonStatus(root);
  if (current.running) return { pid: current.pid, started: false };
  mkdirSync(loopDataDir(root), { recursive: true });
  const log = openSync(daemonLogPath(root), "a");
  try {
    const child = spawn(process.execPath, loopArgs(root, "start"), {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      // The daemon (and every lead/worker it spawns) never sees UI or reviewer credentials.
      env: scrubbedEnv({ AIDLC_LOOP_EVENT_LOG: eventsLogPath(root) }),
    });
    // Without a listener a spawn failure would be an unhandled 'error' event and
    // crash the UI server; the daemon's own start-up errors go to daemon.log.
    child.on("error", () => { /* reported via daemon status on the next render */ });
    child.unref();
    return { pid: child.pid ?? null, started: true };
  } finally { closeSync(log); }
};

const intakeTask = async (root: string, requirement: string): Promise<{ taskId: string; title: string }> => {
  const output = await runNode(root, loopArgs(root, "intake"), { input: requirement, timeout: 30000 });
  const parsed = JSON.parse(output) as { taskId?: unknown; title?: unknown };
  if (typeof parsed.taskId !== "string" || typeof parsed.title !== "string") throw new Error("loop intake returned no task id");
  return { taskId: parsed.taskId, title: parsed.title };
};

const activateTask = async (root: string, taskId: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "task", "status", taskId, "--status", "active", "--root", root], { timeout: 30000 })) as unknown;

const loopStatusJson = async (root: string, taskId: string): Promise<unknown> =>
  JSON.parse(await runNode(root, loopArgs(root, "status", taskId), { timeout: 5000 })) as unknown;

const approveGate = async (root: string, taskId: string, gate: string, source: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "gate", "approve", taskId, "--gate", gate, "--source", source, "--root", root], { timeout: 30000 })) as unknown;

/** Human feedback keeps the task at its current gate. The audited status cancel
 * records `Cancelled gate wait at <gate>: <feedback>` evidence and sets the task
 * `active`; the loop runtime turns that into a "revise the review artifact, then
 * re-present the gate" prompt — the same mechanism as typing feedback in the
 * trusted terminal (`loop-gate.mjs`). It never approves anything. */
const feedbackGate = async (root: string, taskId: string, feedback: string, source: string): Promise<unknown> =>
  JSON.parse(await runNode(root, [stateScriptPath(root), "task", "status", taskId, "--status", "active", "--mode", "audited", "--reason", feedback, "--source", source, "--root", root], { timeout: 30000 })) as unknown;

const FEEDBACK_DETAIL = /^Cancelled gate wait at (G0_confirm|G1_review|G2_codereview): /;

/** Feedback entries not yet followed by a passing approval of that gate
 * (mirrors `pendingFeedback` in the installed `loop-runtime.mjs`). */
const pendingFeedback = (task: Pick<TaskState, "evidence">): Array<{ gate: string; text: string; recordedAt: string }> => {
  const pending: Array<{ gate: string; text: string; recordedAt: string }> = [];
  task.evidence.forEach((entry, index) => {
    if (entry.kind !== "diagnostic" || typeof entry.detail !== "string") return;
    const match = FEEDBACK_DETAIL.exec(entry.detail);
    if (!match) return;
    const gate = match[1] ?? "";
    const approvedAfter = task.evidence.slice(index + 1).some((later) => later.kind === "approval" && later.result === "pass" && later.gate === gate);
    if (!approvedAfter) pending.push({ gate, text: entry.detail.slice(match[0].length), recordedAt: entry.recordedAt });
  });
  return pending;
};

/* Fleet reads spawn `loop-entry.mjs`; live polling (every ~1.5s per open tab)
 * shares one in-flight or recent result per key instead of spawning per request. */
const fleetReads = new Map<string, { at: number; value: Promise<unknown> }>();
const sharedFleetRead = <T>(key: string, maxAgeMs: number, read: () => Promise<T>): Promise<T> => {
  if (maxAgeMs <= 0) return read();
  const now = Date.now();
  const cached = fleetReads.get(key);
  if (cached && now - cached.at < maxAgeMs) return cached.value as Promise<T>;
  const value = read();
  fleetReads.set(key, { at: now, value });
  value.catch(() => { if (fleetReads.get(key)?.value === value) fleetReads.delete(key); });
  return value;
};
/** How stale a fleet read on the live-update path may be. Mutations always read fresh. */
const LIVE_FLEET_MAX_AGE_MS = 1000;

/* Authority-neutral read model: local reads canonical state in-process; fleet asks
 * `loop-entry.mjs` (the only place that speaks to the coordination service). */
const readUiState = async (options: UiOptions, maxAgeMs = 0): Promise<WorkflowState> => {
  if (uiMode(options) === "local") return loadState(options.root);
  return sharedFleetRead(`${options.root}\0tasks`, maxAgeMs, async () => {
    const parsed = JSON.parse(await runNode(options.root, loopArgs(options.root, "tasks"), { timeout: 15000 })) as { tasks?: TaskState[] };
    if (!Array.isArray(parsed.tasks)) throw new Error("Fleet task list is unavailable");
    return { schemaVersion: 4, tasks: Object.fromEntries(parsed.tasks.map((task) => [task.id, task])), archive: {} } as WorkflowState;
  });
};
const readUiTask = (options: UiOptions, id: string, state: WorkflowState): TaskState | undefined =>
  uiMode(options) === "local" ? loadTask(options.root, id, state) : state.tasks[id];

interface FleetGate { ok?: boolean; gate?: string; status?: string; checkpoint?: { snapshotId?: string; status?: string } | null; snapshot?: { id?: string; reviewText?: string; integrationCommit?: string | null } | null }
const fleetGate = (options: UiOptions, id: string, maxAgeMs = 0): Promise<FleetGate> =>
  sharedFleetRead(`${options.root}\0gate\0${id}`, maxAgeMs, async () => JSON.parse(await runNode(options.root, loopArgs(options.root, "gate", id), { timeout: 15000 })) as FleetGate);

const childError = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    try { const parsed = JSON.parse(stderr) as { error?: { message?: string } }; if (parsed.error?.message) return parsed.error.message; } catch { /* not JSON */ }
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
};

const taskGatePayload = async (options: UiOptions, id: string, known?: WorkflowState, maxAgeMs = 0): Promise<{ ok: boolean; error?: string; gate?: string; view?: unknown; snapshot?: FleetGate["snapshot"] }> => {
  const state = known ?? await readUiState(options, maxAgeMs);
  const task = readUiTask(options, id, state);
  if (!task) return { ok: false, error: `Task not found: ${id}` };
  if (task.status !== "blocked_on_user" || task.gate === "none") return { ok: false, error: "Task is not waiting at a human gate" };
  if (uiMode(options) === "fleet") {
    const gate = await fleetGate(options, id, maxAgeMs);
    return gate.snapshot ? { ok: true, gate: task.gate, snapshot: gate.snapshot } : { ok: false, error: "No current review snapshot for this gate yet" };
  }
  const diagnostics = checkGate(options.root, state, id, task.gate);
  return { ok: true, gate: task.gate, view: gateView(task, diagnostics) };
};

const artifactPayload = (root: string, id: string, name: string, task: TaskState | undefined = loadTask(root, id)): { ok: boolean; error?: string; name?: string; content?: string } => {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) return { ok: false, error: `Unknown artifact: ${name}` };
  if (!task) return { ok: false, error: `Task not found: ${id}` };
  const artifactPath = task.artifacts?.[name as (typeof ARTIFACT_NAMES)[number]];
  if (!artifactPath) return { ok: false, error: `Artifact ${name} not recorded for ${id}` };
  assertTaskArtifactPath(id, artifactPath);
  try {
    return { ok: true, name, content: readFileSync(join(root, artifactPath), "utf8") };
  } catch {
    return { ok: false, error: `Artifact ${name} is missing for ${id}` };
  }
};

/** `task` marks a task detail page: live updates refresh that task's regions. The
 * inline head script applies the saved kanban/list view before first paint. */
const pageHead = (title: string, task = ""): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="/assets/bulma.css">
<link rel="stylesheet" href="/assets/dashboard.css">
<script>try { document.documentElement.setAttribute("data-view", localStorage.getItem("aidlc-view") === "list" ? "list" : "kanban"); } catch (error) { /* storage disabled */ }</script>
</head>
<body${task ? ` data-task="${escapeHtml(task)}"` : ""}>`;

/* ---------------------------------------------------------------------------
 * Live regions: server-rendered fragments the client polls and morphs in place.
 * Each region carries a content hash; `/api/live` returns only regions whose
 * hash differs from the one the client already shows.
 * ------------------------------------------------------------------------- */

/** Region names `/api/live` can render; anything else in `known` is ignored. */
const LIVE_REGIONS = ["notify", "daemon", "board", "detail", "drawer"] as const;
type LiveRegion = (typeof LIVE_REGIONS)[number];
const regionHash = (html: string): string => createHash("sha1").update(html).digest("base64url").slice(0, 16);
/** Wrapper is `display: contents`, so it never affects layout (e.g. header flex items). */
const liveRegion = (name: LiveRegion, html: string): string => `<div class="ad-live" data-live="${name}" data-live-hash="${regionHash(html)}">${html}</div>`;

/* ---------------------------------------------------------------------------
 * Markdown renderer (minimal, escaping-first, no runtime dependency).
 * ------------------------------------------------------------------------- */

const safeUrl = (raw: string): string => {
  const url = raw.trim();
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme && !/^(https?|mailto)$/i.test(scheme[1] ?? "")) return "#";
  return escapeHtml(url);
};

const renderInline = (text: string): string => {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^\w])_([^_\s][^_]*)_(?![\w])/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${safeUrl(url)}">${label}</a>`);
  return out;
};

const splitRow = (line: string): string[] => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");

const isTableSeparator = (line: string): boolean => /^[\s|:-]+$/.test(line.trim()) && line.includes("-");

/** Renders a small subset of Markdown to escaped HTML. Exported for tests. */
export const markdownToHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;
  let listKind: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join(" "))}</p>`); paragraph = []; }
  };
  const closeList = (): void => {
    if (listKind) { html.push(`</${listKind}>`); listKind = null; }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph(); closeList();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) { codeLines.push(lines[i] ?? ""); i += 1; }
      i += 1;
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph(); closeList();
      const level = (heading[1] ?? "#").length;
      html.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^([-*_])(\s*\1){2,}\s*$/.test(trimmed)) { flushParagraph(); closeList(); html.push("<hr>"); i += 1; continue; }

    if (trimmed.startsWith(">")) {
      flushParagraph(); closeList();
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith(">")) { quote.push((lines[i] ?? "").trim().replace(/^>\s?/, "")); i += 1; }
      html.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      continue;
    }

    if (trimmed.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      flushParagraph(); closeList();
      const header = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().includes("|")) { rows.push(splitRow((lines[i] ?? "").trim())); i += 1; }
      const cols = header.length;
      const ths = header.map((c) => `<th>${renderInline(c.trim())}</th>`).join("");
      const trs = rows.map((r) => `<tr>${Array.from({ length: cols }, (_x, k) => `<td>${renderInline((r[k] ?? "").trim())}</td>`).join("")}</tr>`).join("");
      html.push(`<table class="table is-fullwidth is-striped is-bordered"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushParagraph();
      const kind = ol ? "ol" : "ul";
      if (listKind !== kind) { closeList(); html.push(`<${kind}>`); listKind = kind; }
      html.push(`<li>${renderInline((ul?.[1] ?? ol?.[1] ?? "").trim())}</li>`);
      i += 1;
      continue;
    }

    if (trimmed === "") { flushParagraph(); closeList(); i += 1; continue; }

    closeList();
    paragraph.push(trimmed);
    i += 1;
  }
  flushParagraph(); closeList();
  return html.join("\n");
};

const summarize = (counts: Record<string, number> | undefined): string => Object.entries(counts ?? {}).map(([k, n]) => `${n} ${k}`).join(" · ") || "none";

/* ---------------------------------------------------------------------------
 * Presentation helpers: labels, pills, phase stepper, relative time.
 * Colour is never the only signal; every pill carries a text label.
 * ------------------------------------------------------------------------- */

const GATE_LABELS: Record<string, string> = {
  G0_confirm: "Confirm requirements",
  G1_review: "Approve plan",
  G2_codereview: "Review implementation",
};
const PHASE_GATE: Record<string, string> = { clarify: "G0_confirm", plan: "G1_review", build: "G2_codereview" };
const STATUS_META: Record<string, { label: string; tone: string }> = {
  active: { label: "Active", tone: "is-info" },
  blocked_on_user: { label: "Needs review", tone: "is-warning" },
  paused: { label: "Paused", tone: "" },
  done: { label: "Done", tone: "is-success" },
  closed: { label: "Closed", tone: "is-danger" },
  superseded: { label: "Superseded", tone: "is-danger" },
};
const RISK_TONE: Record<string, string> = { low: "is-success", normal: "", high: "is-warning", regulated: "is-danger" };
const RESULT_TONE: Record<string, string> = { pass: "is-success", fail: "is-danger", skip: "is-warning" };
const DECISION_TONE: Record<string, string> = { approved: "is-success", changed: "is-info", dropped: "is-ghost", unresolved: "is-warning" };
const ITEM_TONE: Record<string, string> = { done: "is-success", in_progress: "is-info", todo: "", deferred: "is-warning" };

const gateLabel = (gate: string): string => GATE_LABELS[gate] ?? gate;

const pill = (label: string, tone = "", title = "", dot = true): string =>
  `<span class="ad-pill ${tone}"${title ? ` title="${escapeHtml(title)}"` : ""}>${dot ? '<span class="ad-dot"></span>' : ""}${escapeHtml(label)}</span>`;

const statusPill = (status: string, handedOff = false): string => {
  if (handedOff) return pill("Handed off", "is-danger", `status: ${status} · handed off`);
  const meta = STATUS_META[status] ?? { label: status, tone: "" };
  return pill(meta.label, meta.tone, `status: ${status}`);
};

const gatePill = (gate: string): string => gate && gate !== "none" ? pill(gateLabel(gate), "is-ghost", `gate: ${gate}`, false) : "";
/** Human feedback recorded at a gate and not yet followed by that gate's approval. */
const feedbackPill = (count: number): string => count > 0 ? `<span class="ad-pill is-info" data-feedback-pending="${count}" title="${count} human feedback item${count === 1 ? "" : "s"} not yet followed by an approval">✎ feedback pending${count > 1 ? ` · ${count}` : ""}</span>` : "";

const riskPill = (risk: string): string => pill(`${risk} risk`, RISK_TONE[risk] ?? "", `risk: ${risk}`);

const phaseSteps = (phase: string): string => {
  const current = (PHASES as readonly string[]).indexOf(phase);
  const done = phase === "done";
  const bars = PHASES.map((name, index) => {
    const state = done || index < current ? "is-complete" : index === current ? "is-current" : "";
    return `<span class="${state}" title="${escapeHtml(name)}"></span>`;
  }).join("");
  return `<div class="ad-steps${done ? " is-done" : ""}" role="img" aria-label="Phase ${current + 1} of ${PHASES.length}: ${escapeHtml(phase)}">${bars}</div>`;
};

/** Horizontal phase stepper shown above the artifacts (detail page and drawer). */
const phaseStepper = (phase: string, gate: string, status: string): string => {
  const current = (PHASES as readonly string[]).indexOf(phase);
  return `<ol class="ad-stepper" aria-label="Progress">${PHASES.map((name, index) => {
    const complete = phase === "done" || index < current;
    const isCurrent = !complete && index === current;
    const phaseGate = PHASE_GATE[name];
    const note = isCurrent && status === "blocked_on_user" && gate !== "none"
      ? `waiting at ${gateLabel(gate)}`
      : phaseGate ? `gate · ${gateLabel(phaseGate)}` : name === "done" ? "complete" : "no gate";
    return `<li class="${complete ? "is-complete" : isCurrent ? "is-current" : ""}"${isCurrent ? ' aria-current="step"' : ""}><span class="ad-stepper-marker">${complete ? "✓" : index + 1}</span><span class="ad-stepper-text"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(note)}</small></span></li>`;
  }).join("")}</ol>`;
};

/** Server-rendered relative time; the absolute ISO value stays in the title. */
const relativeTime = (iso: string | undefined): string => {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return escapeHtml(iso);
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  const text = seconds < 60 ? "just now"
    : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago`
        : `${Math.floor(seconds / 86400)}d ago`;
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${text}</time>`;
};

/* ---------------------------------------------------------------------------
 * Gate view and JSON tree renderers (structured HTML, not raw JSON dumps).
 * ------------------------------------------------------------------------- */

interface GateViewData {
  icon?: string;
  title?: string;
  gate?: string;
  action?: string;
  task?: { id?: string; title?: string; status?: string; risk?: string; areas?: string[] };
  artifacts?: Array<{ name?: string; path?: string }>;
  decisions?: Record<string, number>;
  execution?: Record<string, number>;
  evidence?: Array<{ kind?: string; result?: string; source?: string }>;
  diagnostics?: Array<{ level?: string; code?: string; message?: string }>;
}

const renderGateViewHtml = (view: unknown): string => {
  const v = view as GateViewData;
  const task = v.task ?? {};
  const artifacts = v.artifacts ?? [];
  const evidence = v.evidence ?? [];
  const diagnostics = v.diagnostics ?? [];
  const levelTone = (level?: string): string => level === "ERROR" ? "is-danger" : level === "WARN" ? "is-warning" : "is-info";
  const cell = (label: string, value: string): string => `<div class="ad-gate-cell"><small>${escapeHtml(label)}</small><span>${value}</span></div>`;
  return `<section class="ad-panel is-warning" data-key="gate-view">
    <header class="ad-panel-head"><span aria-hidden="true">${escapeHtml(String(v.icon ?? ""))}</span><h2>${escapeHtml(String(v.title ?? ""))}</h2><span class="ad-pill is-warning ad-panel-tools" title="gate">${escapeHtml(String(v.gate ?? ""))}</span></header>
    <div class="ad-panel-body">
      <div class="ad-gate-grid">
        ${cell("Status", escapeHtml(task.status ?? ""))}
        ${cell("Risk", escapeHtml(task.risk ?? ""))}
        ${cell("Areas", escapeHtml((task.areas ?? []).join(", ")))}
        ${cell("Decisions", escapeHtml(summarize(v.decisions)))}
        ${cell("Execution", escapeHtml(summarize(v.execution)))}
      </div>
      <h3 class="ad-subhead">Review artifacts</h3>
      ${artifacts.length ? `<ul class="ad-plain-list">${artifacts.map((a) => `<li><strong>${escapeHtml(a.name ?? "")}</strong><code>${escapeHtml(a.path ?? "")}</code></li>`).join("")}</ul>` : '<p class="has-text-grey">none</p>'}
      <h3 class="ad-subhead">Verification evidence</h3>
      ${evidence.length ? `<ul class="ad-plain-list">${evidence.map((e) => `<li>${pill(e.result ?? "", RESULT_TONE[e.result ?? ""] ?? "")} <strong>${escapeHtml(e.kind ?? "")}</strong> <span class="has-text-grey">${escapeHtml(e.source ?? "")}</span></li>`).join("")}</ul>` : '<p class="has-text-grey">none yet</p>'}
      ${diagnostics.length ? `<h3 class="ad-subhead">Diagnostics</h3><ul class="ad-plain-list">${diagnostics.map((d) => `<li>${pill(d.level ?? "", levelTone(d.level))} <code>${escapeHtml(d.code ?? "")}</code> ${escapeHtml(d.message ?? "")}</li>`).join("")}</ul>` : ""}
      <div class="ad-callout"><span aria-hidden="true">→</span><span>Action required: ${escapeHtml(String(v.action ?? ""))}</span></div>
    </div>
  </section>`;
};

/* ---------------------------------------------------------------------------
 * Client script shared across dashboard and detail page.
 * Client-built text (toasts, log lines) uses textContent. HTML only ever comes
 * from the server's own escaping renderers (live regions, side-panel fragment).
 * ------------------------------------------------------------------------- */

const sharedScript = `<script>
const storedToken = () => (localStorage.getItem("aidlc-token") || "");
const setStoredToken = (value) => localStorage.setItem("aidlc-token", value);
const post = async (url, body) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": storedToken() }, body: JSON.stringify(body) });
  let parsed = {};
  try { parsed = await response.json(); } catch (error) { parsed = { error: "Unexpected response (" + response.status + ")" }; }
  return { status: response.status, body: parsed };
};
// Toasts; an optional same-origin href turns the message into a link.
const toast = (message, kind = "info", detail = "", href = "") => {
  const stack = document.getElementById("toasts");
  if (!stack) return;
  const icons = { success: "✓", danger: "!", warning: "!", info: "i" };
  const item = document.createElement("div");
  item.className = "ad-toast is-" + kind;
  item.setAttribute("role", kind === "danger" ? "alert" : "status");
  const icon = document.createElement("span");
  icon.className = "ad-toast-icon";
  icon.textContent = icons[kind] || "i";
  const body = document.createElement("div");
  body.className = "ad-toast-body";
  if (href && href.startsWith("/")) { const link = document.createElement("a"); link.href = href; link.textContent = message; body.appendChild(link); }
  else body.textContent = message;
  if (detail) { const small = document.createElement("small"); small.textContent = detail; body.appendChild(small); }
  const close = document.createElement("button");
  close.className = "ad-toast-close";
  close.setAttribute("aria-label", "dismiss");
  close.textContent = "×";
  const dismiss = () => { item.classList.add("is-leaving"); setTimeout(() => item.remove(), 220); };
  close.addEventListener("click", dismiss);
  item.append(icon, body, close);
  stack.appendChild(item);
  setTimeout(dismiss, kind === "danger" ? 9000 : href ? 8000 : 4500);
};
const failureToast = (res, fallback) => {
  const message = (res.body && res.body.error) || fallback;
  toast(message, "danger", res.status === 401 ? "Open the login link printed by aidlc-kit ui (or paste the token in Settings) and retry." : "HTTP " + res.status);
};
const withLoading = async (button, work) => {
  if (button) { button.classList.add("is-loading"); button.disabled = true; }
  try { return await work(); }
  catch (error) { toast("Request failed", "danger", String(error && error.message || error)); return undefined; }
  finally { if (button) { button.classList.remove("is-loading"); button.disabled = false; } }
};
const openModal = (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("is-active");
  document.documentElement.classList.add("is-clipped");
  const focusable = el.querySelector("[data-autofocus]");
  if (focusable) setTimeout(() => focusable.focus(), 30);
};
const closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove("is-active"); if (!document.querySelector(".modal.is-active")) document.documentElement.classList.remove("is-clipped"); };
const closeAllModals = () => { document.querySelectorAll(".modal").forEach((m) => m.classList.remove("is-active")); document.documentElement.classList.remove("is-clipped"); };

/* ---- Reactive regions -------------------------------------------------------
 * The server renders each region ([data-live]) to HTML; the client polls
 * /api/live with the hash it shows per region, gets back only changed regions,
 * and morphs them into the DOM in place (keyed by id / data-key) instead of
 * reloading the page. Morphing keeps focus, typed input, open <details>, and
 * client state named in data-live-preserve; [data-live-ignore] subtrees (the
 * live log) are never touched. Hooks re-apply view state (filters, collapsed
 * columns) after every update. */
const LIVE_INTERVAL_MS = 1500;
const NOTIFY_PAGE = 5;
const live = { notify: NOTIFY_PAGE, timer: 0, inflight: null, again: false, failures: 0, reviews: null, hooks: [] };
const keyOf = (node) => node.nodeType === 1 ? (node.id || node.getAttribute("data-key") || "") : "";
const sameNode = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);
const preservedAttrs = (el) => {
  const names = (el.getAttribute("data-live-preserve") || "").split(/\\s+/).filter(Boolean);
  if (el.tagName === "DETAILS") names.push("open");
  return names;
};
const syncAttrs = (from, to) => {
  const keep = preservedAttrs(from);
  for (const { name } of [...from.attributes]) if (!keep.includes(name) && !to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (!keep.includes(name) && from.getAttribute(name) !== value) from.setAttribute(name, value);
};
const morphNode = (from, to) => {
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  if (from.nodeType !== 1 || from.hasAttribute("data-live-ignore")) return;
  syncAttrs(from, to);
  // Form controls keep what the user typed or picked.
  if (from.tagName === "INPUT" || from.tagName === "TEXTAREA" || from.tagName === "SELECT") return;
  morphChildren(from, to);
};
const morphChildren = (from, to) => {
  const keyed = new Map();
  for (const child of from.children) { const key = keyOf(child); if (key) keyed.set(key, child); }
  let cursor = from.firstChild;
  for (const next of [...to.childNodes]) {
    const key = keyOf(next);
    let match = null;
    if (key) { const found = keyed.get(key); if (found && sameNode(found, next)) { match = found; keyed.delete(key); } }
    else if (cursor && !keyOf(cursor) && sameNode(cursor, next)) match = cursor;
    if (match) {
      if (match === cursor) cursor = cursor.nextSibling; else from.insertBefore(match, cursor);
      morphNode(match, next);
    } else from.insertBefore(next, cursor);
  }
  while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
};
const applyRegion = (name, html, hash) => {
  const el = document.querySelector("[data-live='" + name + "']");
  if (!el) return false;
  const template = document.createElement("template");
  template.innerHTML = html;
  morphChildren(el, template.content);
  el.setAttribute("data-live-hash", hash);
  return true;
};
let drawerTask = "";
const liveQuery = () => {
  const params = new URLSearchParams();
  const task = document.body.getAttribute("data-task");
  if (task) params.set("task", task);
  const known = [];
  document.querySelectorAll("[data-live]").forEach((el) => {
    const name = el.getAttribute("data-live");
    if (name === "drawer" && !(drawerOpen() && drawerTask)) return;
    known.push(name + ":" + (el.getAttribute("data-live-hash") || ""));
  });
  if (drawerOpen() && drawerTask) params.set("drawer", drawerTask);
  params.set("notify", String(live.notify));
  params.set("known", known.join(","));
  return params.toString();
};
const setLiveStatus = (ok) => { const el = document.getElementById("live-status"); if (el) el.hidden = ok; };
const baseTitle = document.title.replace(/^\\(\\d+\\) /, "");
const onReviews = (reviews) => {
  if (!reviews) return;
  document.title = reviews.count ? "(" + reviews.count + ") " + baseTitle : baseTitle;
  const ids = new Set(reviews.items.map((item) => item.id));
  // The first poll only seeds the set: toast reviews that arrive while the page is open.
  if (live.reviews) for (const item of reviews.items) {
    if (!live.reviews.has(item.id)) toast("Review needed: " + item.title, "warning", item.gate + " · " + item.id, "/tasks/" + encodeURIComponent(item.id));
  }
  live.reviews = ids;
};
const liveRefresh = async () => {
  if (live.inflight) { live.again = true; return live.inflight; }
  live.inflight = (async () => {
    try {
      const requestedDrawer = drawerOpen() ? drawerTask : "";
      const response = await fetch("/api/live?" + liveQuery(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = await response.json();
      const changed = [];
      for (const [name, region] of Object.entries(data.regions || {})) {
        // A drawer answer for a task the user has since switched away from is stale.
        if (name === "drawer" && (!drawerOpen() || drawerTask !== requestedDrawer || data.drawer !== drawerTask)) continue;
        if (applyRegion(name, region.html, region.hash)) changed.push(name);
      }
      if (changed.length) live.hooks.forEach((hook) => hook(changed));
      onReviews(data.reviews);
      live.failures = 0;
      setLiveStatus(true);
    } catch (error) {
      live.failures += 1;
      setLiveStatus(false);
    } finally { live.inflight = null; }
  })();
  await live.inflight;
  if (live.again) { live.again = false; await liveRefresh(); }
};
// Polls every 1.5s; backs off to 12s while the server is unreachable.
const scheduleLive = () => {
  clearTimeout(live.timer);
  const delay = live.failures ? Math.min(12000, LIVE_INTERVAL_MS * 2 ** Math.min(live.failures, 3)) : LIVE_INTERVAL_MS;
  live.timer = setTimeout(async () => { await liveRefresh(); scheduleLive(); }, delay);
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) { liveRefresh().then(scheduleLive); } });

// Header notifications: the bell toggles a dropdown of tasks waiting at a gate;
// each item is a plain link to the task detail page.
const notifyToggle = () => document.getElementById("notify-toggle");
const notifyOpen = () => { const panel = document.getElementById("notify-panel"); return !!panel && !panel.hidden; };
const setNotify = (open, options = {}) => {
  const button = notifyToggle();
  const panel = document.getElementById("notify-panel");
  if (!button || !panel) return;
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) { const first = panel.querySelector("a[href]"); if (first && options.focus) first.focus(); }
  else if (options.restore) button.focus();
};

// Task side panel (drawer): slides in from the right, mirrors ?task=<id> in the
// URL so refresh/share reopens it and Back closes it. Only the newest fetch
// may write the body when the user switches tasks quickly; live updates then
// morph it like any other region.
let drawerRequest = 0;
let drawerReturnFocus = null;
const drawerEl = () => document.getElementById("task-drawer");
// "Open" means shown or opening; a drawer mid-close counts as closed so a quick
// reopen re-adds is-open instead of being hidden by the pending close timer.
const drawerOpen = () => { const el = drawerEl(); return !!el && el.classList.contains("is-open"); };
const drawerTaskFromUrl = () => new URLSearchParams(location.search).get("task");
const openTaskDrawer = async (id, options = {}) => {
  const el = drawerEl();
  if (!el || !id) return;
  const body = document.getElementById("task-drawer-body");
  const title = document.getElementById("task-drawer-title");
  const link = document.getElementById("task-drawer-open");
  if (title) title.textContent = id;
  if (link) link.href = "/tasks/" + encodeURIComponent(id);
  if (!drawerOpen()) {
    if (el.hidden) drawerReturnFocus = document.activeElement;
    el.hidden = false;
    document.documentElement.classList.add("is-clipped");
    el.classList.add("is-opening");
    requestAnimationFrame(() => { el.classList.add("is-open"); el.classList.remove("is-opening"); });
    const panel = el.querySelector(".ad-drawer-panel");
    if (panel) setTimeout(() => panel.focus(), 30);
  }
  if (options.push !== false && drawerTaskFromUrl() !== id) history.pushState({ task: id }, "", "?task=" + encodeURIComponent(id));
  const request = ++drawerRequest;
  const switching = drawerTask !== id;
  drawerTask = id;
  if (body && switching) { body.innerHTML = "<p class='has-text-grey'>Loading…</p>"; body.setAttribute("data-live-hash", ""); }
  let html;
  try {
    const response = await fetch("/partial/tasks/" + encodeURIComponent(id));
    html = response.ok ? await response.text() : "<p class='has-text-danger'>Failed to load task detail.</p>";
  } catch (error) {
    html = "<p class='has-text-danger'>Failed to load task detail.</p>";
  }
  if (request === drawerRequest && body) {
    if (switching) { body.innerHTML = html; body.scrollTop = 0; }
    else { const template = document.createElement("template"); template.innerHTML = html; morphChildren(body, template.content); }
    body.setAttribute("data-live-hash", "");
  }
};
const closeTaskDrawer = (options = {}) => {
  const el = drawerEl();
  if (!el || el.hidden) return;
  drawerRequest += 1;
  el.classList.remove("is-open");
  const finish = () => { if (!el.classList.contains("is-open") && !el.classList.contains("is-opening")) el.hidden = true; };
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish(); else setTimeout(finish, 200);
  if (!document.querySelector(".modal.is-active")) document.documentElement.classList.remove("is-clipped");
  // Replace (not push) the ?task entry so Back after closing does not reopen it.
  if (options.push !== false && drawerTaskFromUrl()) history.replaceState({}, "", location.pathname);
  if (drawerReturnFocus && typeof drawerReturnFocus.focus === "function") drawerReturnFocus.focus();
  drawerReturnFocus = null;
};
window.addEventListener("popstate", () => {
  const id = drawerTaskFromUrl();
  if (id) openTaskDrawer(id, { push: false }); else closeTaskDrawer({ push: false });
});
const isTyping = (target) => !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const REQUIREMENT_LIMIT = 8192;
// Login link: \`aidlc-kit ui\` prints /#token=<token>. Store it and drop it from the address bar
// (a fragment is never sent to the server or in Referer).
(() => {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (!match) return;
  try { setStoredToken(decodeURIComponent(match[1])); } catch (error) { /* malformed link */ }
  history.replaceState(history.state, "", location.pathname + location.search);
})();

/* ---- Dashboard view state (re-applied after every live update) ---- */
const viewKey = "aidlc-view";
const applyView = (view) => {
  document.documentElement.setAttribute("data-view", view === "list" ? "list" : "kanban");
  document.querySelectorAll("[data-view-toggle]").forEach((el) => {
    const active = el.getAttribute("data-view-toggle") === view;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-pressed", String(active));
  });
};
const currentView = () => (localStorage.getItem(viewKey) === "list" ? "list" : "kanban");
const expandedColumns = new Set();
// Client-side filtering over server-rendered cards and rows (no extra API calls).
// Columns with data-collapse show that many cards unless expanded or filtering.
const applyFilter = () => {
  const search = document.getElementById("task-search");
  const statusFilter = document.getElementById("filter-status");
  const riskFilter = document.getElementById("filter-risk");
  const resultCount = document.getElementById("result-count");
  const terms = (search ? search.value : "").toLowerCase().split(/\\s+/).filter(Boolean);
  const status = statusFilter ? statusFilter.value : "";
  const risk = riskFilter ? riskFilter.value : "";
  const filtered = !!(terms.length || status || risk);
  const matches = (el) => (!status || el.getAttribute("data-status") === status) && (!risk || el.getAttribute("data-risk") === risk) && terms.every((term) => (el.getAttribute("data-search") || "").includes(term));
  let visible = 0;
  document.querySelectorAll("#kanban-view [data-task-item]").forEach((el) => { const show = matches(el); el.hidden = !show; if (show) visible += 1; });
  document.querySelectorAll("#list-view [data-task-item]").forEach((el) => { el.hidden = !matches(el); });
  document.querySelectorAll("[data-phase-column]").forEach((column) => {
    const shown = [...column.querySelectorAll("[data-task-item]")].filter((el) => !el.hidden);
    const limit = Number(column.getAttribute("data-collapse") || 0);
    const expanded = expandedColumns.has(column.getAttribute("data-phase-column"));
    const extra = limit && !filtered ? Math.max(0, shown.length - limit) : 0;
    if (extra && !expanded) shown.slice(limit).forEach((el) => { el.hidden = true; });
    const more = column.querySelector("[data-column-more]");
    if (more) { more.hidden = extra === 0; more.textContent = expanded ? "Show less" : "Show " + extra + " more"; more.setAttribute("aria-expanded", String(expanded)); }
    const badge = column.querySelector("[data-column-count]");
    if (badge) badge.textContent = String(shown.length);
    const empty = column.querySelector("[data-column-empty]");
    if (empty) empty.hidden = shown.length > 0;
  });
  const total = document.querySelectorAll("#kanban-view [data-task-item]").length;
  if (resultCount) resultCount.textContent = filtered ? visible + " of " + total + " tasks" : total + (total === 1 ? " task" : " tasks");
  document.querySelectorAll("[data-no-match]").forEach((el) => el.classList.toggle("is-visible", filtered && visible === 0));
};
const clearFilters = () => {
  ["task-search", "filter-status", "filter-risk"].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  applyFilter();
};
live.hooks.push(() => { applyView(currentView()); applyFilter(); });

/* ---- Delegated events: controls inside live regions are re-rendered, so no
 * handler is bound to an individual element. ---- */
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (notifyOpen() && !target.closest("[data-notify]")) setNotify(false);
  const bell = target.closest("#notify-toggle");
  if (bell) { setNotify(!notifyOpen(), { focus: event.detail === 0 }); return; }
  if (target.closest("[data-notify-more]")) {
    live.notify += NOTIFY_PAGE;
    liveRefresh();
    return;
  }
  const opener = target.closest("[data-open]");
  if (opener) { openModal(opener.getAttribute("data-open")); return; }
  if (target.closest("[data-close]")) { closeAllModals(); return; }
  if (target.closest("[data-drawer-close]")) { closeTaskDrawer(); return; }
  const taskLink = target.closest("[data-task-link]");
  if (taskLink) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openTaskDrawer(taskLink.getAttribute("data-task-link"));
    return;
  }
  const viewToggle = target.closest("[data-view-toggle]");
  if (viewToggle) { const view = viewToggle.getAttribute("data-view-toggle"); localStorage.setItem(viewKey, view); applyView(view); return; }
  const columnMore = target.closest("[data-column-more]");
  if (columnMore) {
    const column = columnMore.closest("[data-phase-column]");
    const name = column ? column.getAttribute("data-phase-column") : "";
    if (expandedColumns.has(name)) expandedColumns.delete(name); else expandedColumns.add(name);
    applyFilter();
    return;
  }
  if (target.closest("#filter-clear")) { clearFilters(); return; }
  const resume = target.closest("[data-resume]");
  if (resume) {
    event.preventDefault();
    const taskId = resume.getAttribute("data-resume");
    withLoading(resume, async () => {
      const res = await post("/api/loop/resume", { taskId });
      if (res.status >= 200 && res.status < 300) { toast("Resumed " + taskId, "success", "The daemon will pick it up on its next poll"); await liveRefresh(); }
      else failureToast(res, "Could not resume " + taskId);
    });
  }
});
document.addEventListener("input", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target && target.matches("#task-search, #filter-status, #filter-risk")) applyFilter();
});

document.addEventListener("DOMContentLoaded", () => {
  const tokenInput = document.getElementById("settings-token-input");
  if (tokenInput) tokenInput.value = storedToken();
  const tokenState = document.getElementById("settings-token-state");
  const renderTokenState = () => { if (tokenState) tokenState.textContent = storedToken() ? "Token saved in this browser" : "No token saved"; };
  renderTokenState();
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { if (notifyOpen()) setNotify(false, { restore: true }); else if (document.querySelector(".modal.is-active")) closeAllModals(); else closeTaskDrawer(); return; }
    if (event.key === "Tab" && drawerOpen() && !document.querySelector(".modal.is-active")) {
      const panel = drawerEl().querySelector(".ad-drawer-panel");
      const focusable = [...panel.querySelectorAll("a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]:not([tabindex='-1'])")].filter((node) => node.offsetParent !== null);
      if (!focusable.length) { event.preventDefault(); panel.focus(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector(".modal.is-active") || drawerOpen()) return;
    if (event.key === "n" && document.getElementById("new-task-modal")) { event.preventDefault(); openModal("new-task-modal"); }
    else if (event.key === "/") { const search = document.getElementById("task-search"); if (search) { event.preventDefault(); search.focus(); search.select(); } }
  });
  const saveBtn = document.getElementById("settings-token-save");
  if (saveBtn) saveBtn.addEventListener("click", () => { if (tokenInput) setStoredToken(tokenInput.value.trim()); renderTokenState(); closeModal("settings-modal"); toast("Token saved", "success"); });
  const clearBtn = document.getElementById("settings-token-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { setStoredToken(""); if (tokenInput) tokenInput.value = ""; renderTokenState(); toast("Token cleared", "info"); });

  const requirement = document.getElementById("new-task-requirement");
  const counter = document.getElementById("new-task-count");
  const startBtn = document.getElementById("new-task-submit");
  const updateCounter = () => {
    if (!requirement || !counter) return;
    const used = new TextEncoder().encode(requirement.value).length;
    counter.textContent = used + " / " + REQUIREMENT_LIMIT + " bytes";
    counter.classList.toggle("is-over", used > REQUIREMENT_LIMIT);
  };
  if (requirement) {
    requirement.addEventListener("input", updateCounter);
    requirement.addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && startBtn) { event.preventDefault(); startBtn.click(); } });
    updateCounter();
  }
  if (startBtn) startBtn.addEventListener("click", () => withLoading(startBtn, async () => {
    const value = requirement ? requirement.value : "";
    if (!value.trim()) { toast("Describe the requirement first", "warning"); if (requirement) requirement.focus(); return; }
    const res = await post("/api/loop/start", { requirement: value });
    if (res.status >= 200 && res.status < 300) {
      const daemon = res.body.daemon || {};
      toast("Task " + res.body.taskId + " created", "success", daemon.started ? "Started the loop daemon (pid " + daemon.pid + ")" : "Picked up by the running daemon", "/tasks/" + encodeURIComponent(res.body.taskId));
      closeAllModals();
      if (requirement) { requirement.value = ""; updateCounter(); }
      await liveRefresh();
    } else failureToast(res, "Could not create the task");
  }));

  const initialTask = drawerTaskFromUrl();
  if (initialTask && drawerEl()) openTaskDrawer(initialTask, { push: false });
  applyView(currentView());
  applyFilter();
  liveRefresh().then(scheduleLive);
});
</script>`;

/* ---------------------------------------------------------------------------
 * Dashboard: header notifications, filters, kanban (default) + list toggle.
 * ------------------------------------------------------------------------- */

interface CardTask { id: string; title: string; phase: string; gate: string; status: string; risk: string; areas: string[]; updatedAt?: string; feedbackPending?: number }

/** Per-status action: a paused task can be re-activated for the daemon; a task
 * waiting at a human gate links to the detail page that hosts gate approval. */
const taskAction = (task: { id: string; status: string }, handedOff = false): string => {
  if (handedOff) return `<a class="button is-small is-danger ad-soft" href="/tasks/${encodeURIComponent(task.id)}" title="handed off: follow the handoff actions">handoff</a>`;
  if (task.status === "paused") return `<button class="button is-small is-link ad-soft" data-resume="${escapeHtml(task.id)}">resume</button>`;
  if (task.status === "blocked_on_user") return `<a class="button is-small is-warning" href="/tasks/${encodeURIComponent(task.id)}" title="open the review: send feedback or approve">review</a>`;
  return "";
};

/** Daemon state for the header: running/stopped, plus unresolved turn or poll
 * errors (from the event log) while it runs, so failures are not buried in logs. */
const renderDaemonPill = (root: string): string => {
  const daemon = daemonStatus(root);
  if (!daemon.running) return `<span class="ad-pill is-ghost" data-daemon="stopped" title="start it with: aidlc-kit loop start (or New task)"><span class="ad-dot"></span>daemon stopped</span>`;
  const errors = daemonHealth(root);
  if (!errors.length) return `<span class="ad-pill is-success is-live" data-daemon="running" title="started ${escapeHtml(daemon.startedAt ?? "")}"><span class="ad-dot"></span>daemon running · pid ${daemon.pid}</span>`;
  const describe = (error: DaemonError): string => `${error.taskId ? `${error.taskId}: ` : "poll: "}${error.message}${error.retryInMs ? ` (retry in ${Math.round(error.retryInMs / 1000)}s)` : ""}`;
  const title = `daemon running · pid ${daemon.pid}\n${errors.map(describe).join("\n")}`;
  const label = `<span class="ad-dot"></span>daemon · ${errors.length} error${errors.length === 1 ? "" : "s"}`;
  const only = errors.length === 1 ? errors[0]?.taskId : undefined;
  return only
    ? `<a class="ad-pill is-warning is-live" data-daemon="error" href="/tasks/${encodeURIComponent(only)}" title="${escapeHtml(title)}">${label}</a>`
    : `<span class="ad-pill is-warning is-live" data-daemon="error" title="${escapeHtml(title)}">${label}</span>`;
};

/** A task waiting at a human gate (not handed off): shown as a header notification. */
interface ReviewItem { id: string; title: string; gate: string; updatedAt?: string; feedbackPending: number }

/** Every task waiting at a human gate, newest first. Handed-off tasks follow their
 * handoff actions instead, and terminal (archived) tasks never wait at a gate. */
const reviewQueue = (state: WorkflowState): ReviewItem[] =>
  Object.values(state.tasks)
    .filter((task) => task.status === "blocked_on_user" && task.gate !== "none" && !task.handoff)
    .map((task) => ({ id: task.id, title: task.title, gate: task.gate, updatedAt: task.updatedAt, feedbackPending: pendingFeedback(task).length }))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

/** Notifications shown at first; "Load more" adds this many at a time. */
export const NOTIFY_PAGE = 5;
const NOTIFY_MAX = 100;
const notifyLimit = (raw: string | null): number => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(NOTIFY_MAX, Math.max(NOTIFY_PAGE, value)) : NOTIFY_PAGE;
};

/** Header bell: a count badge plus a dropdown whose items open the task detail
 * page (where gate feedback and approval live). Shows `limit` items and a
 * "Load more" button for the rest. The panel's `hidden` and the toggle's
 * `aria-expanded` are client state that live updates preserve. */
const renderNotifications = (reviews: ReviewItem[], currentTask = "", limit = NOTIFY_PAGE): string => {
  const count = reviews.length;
  const shown = reviews.slice(0, limit);
  const remaining = count - shown.length;
  const label = count ? `${count} task${count === 1 ? "" : "s"} waiting for your review` : "Nothing waiting for your review";
  const items = count
    ? `<ul class="ad-notify-list">${shown.map((task) => `<li data-key="review:${escapeHtml(task.id)}"><a class="ad-notify-item" href="/tasks/${encodeURIComponent(task.id)}" data-review-item="${escapeHtml(task.id)}"${task.id === currentTask ? ' aria-current="page"' : ""}>
        <span class="ad-notify-row">${pill(gateLabel(task.gate), "is-warning", `gate: ${task.gate}`, false)}${task.feedbackPending ? feedbackPill(task.feedbackPending) : ""}<span class="ad-notify-time">${relativeTime(task.updatedAt)}</span></span>
        <span class="ad-notify-title">${escapeHtml(task.title)}</span>
        <code class="ad-notify-id">${escapeHtml(task.id)}</code>
      </a></li>`).join("")}</ul>${remaining > 0 ? `<button type="button" class="ad-notify-more" data-notify-more>Load more <span class="has-text-grey">(${remaining} more)</span></button>` : ""}`
    : '<p class="ad-notify-empty">Nothing waiting for your review.</p>';
  return `<div class="ad-notify" data-notify>
      <button type="button" class="button is-small ad-notify-toggle${count ? " has-reviews" : ""}" id="notify-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="notify-panel" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-live-preserve="aria-expanded">
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 1.5 5.5h-13S5 12 5 8Z"/><path d="M8.5 16.5a1.6 1.6 0 0 0 3 0"/></svg>
        ${count ? `<span class="ad-notify-badge" data-review-count="${count}">${count}</span>` : ""}
      </button>
      <div class="ad-notify-panel" id="notify-panel" role="region" aria-label="Needs your review" hidden data-live-preserve="hidden">
        <header class="ad-notify-head"><strong>Needs your review</strong><span class="ad-count">${count}</span></header>
        ${items}
      </div>
    </div>`;
};

const renderHeader = (root: string, mode: UiAuthorityMode = "local", reviews: ReviewItem[] = [], currentTask = ""): string => `<header class="ad-header">
  <div class="container is-fluid ad-header-inner">
    <a class="ad-brand" href="/" title="Loop · AI-DLC dashboard"><span class="ad-logo" aria-hidden="true">L</span>Loop</a>
    <span class="ad-pill ${mode === "fleet" ? "is-link" : "is-ghost"}" data-authority="${mode}" title="${mode === "fleet" ? "Canonical state lives in the coordination service" : "Canonical state lives in this checkout"}">authority · ${mode}</span>
    ${liveRegion("daemon", renderDaemonPill(root))}
    <span id="live-status" class="ad-pill is-warning" role="status" title="Live updates paused: the dashboard server is unreachable; retrying" hidden><span class="ad-dot"></span>reconnecting…</span>
    <div class="ad-header-actions">
      ${liveRegion("notify", renderNotifications(reviews, currentTask))}
      <button class="button is-small" data-open="settings-modal" title="Settings">⚙<span class="ad-hide-mobile ml-1">Settings</span></button>
      <button class="button is-small is-primary" data-open="new-task-modal">＋ New task<kbd class="ad-hide-mobile">N</kbd></button>
    </div>
  </div>
</header>`;

/** Lower-cased haystack for client-side search (escaped when rendered). */
const searchText = (task: CardTask): string =>
  [task.id, task.title, task.phase, task.gate, gateLabel(task.gate), task.status, STATUS_META[task.status]?.label ?? "", task.risk, ...task.areas].join(" ").toLowerCase();

const itemAttrs = (task: CardTask, handedOff: boolean): string =>
  `data-task-item data-task-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}" data-risk="${escapeHtml(task.risk)}"${handedOff ? ' data-handoff="true"' : ""} data-search="${escapeHtml(searchText(task))}"`;

const renderTaskCard = (task: CardTask, handedOff = false): string => {
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const attention = task.status === "blocked_on_user" && !handedOff;
  return `<article class="ad-card${attention ? " is-attention" : ""}" data-key="card:${escapeHtml(task.id)}" ${itemAttrs(task, handedOff)}>
    <div class="ad-card-top"><a class="ad-card-id" href="${href}" data-task-link="${escapeHtml(task.id)}" title="${escapeHtml(task.id)}">${escapeHtml(task.id)}</a>${statusPill(task.status, handedOff)}</div>
    <div class="ad-card-title"><a href="${href}" data-task-link="${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></div>
    ${phaseSteps(task.phase)}
    <div class="ad-card-meta">${gatePill(task.gate)}${riskPill(task.risk)}${feedbackPill(task.feedbackPending ?? 0)}</div>
    <div class="ad-card-foot"><span class="ad-areas" title="areas: ${escapeHtml(task.areas.join(", "))}">${escapeHtml(task.areas.join(", "))}</span>${task.updatedAt ? `<span>· ${relativeTime(task.updatedAt)}</span>` : ""}${taskAction(task, handedOff)}</div>
  </article>`;
};

const renderListRow = (task: CardTask, handedOff: boolean): string => `<tr data-key="row:${escapeHtml(task.id)}" ${itemAttrs(task, handedOff)}>
  <td><a href="/tasks/${encodeURIComponent(task.id)}" data-task-link="${escapeHtml(task.id)}"><code>${escapeHtml(task.id)}</code></a></td>
  <td class="has-text-weight-semibold">${escapeHtml(task.title)}</td>
  <td><div class="is-size-7 mb-1">${escapeHtml(task.phase)}</div>${phaseSteps(task.phase)}</td>
  <td>${gatePill(task.gate) || '<span class="has-text-grey">—</span>'}</td>
  <td>${statusPill(task.status, handedOff)}${feedbackPill(task.feedbackPending ?? 0)}</td>
  <td>${riskPill(task.risk)}</td>
  <td class="is-size-7">${escapeHtml(task.areas.join(", "))}</td>
  <td class="is-size-7 has-text-grey">${relativeTime(task.updatedAt)}</td>
  <td class="has-text-right">${taskAction(task, handedOff)}</td>
</tr>`;

const renderToolbar = (): string => `<div class="ad-toolbar">
  <div class="ad-search">
    <svg class="ad-search-icon" aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
    <input id="task-search" class="input" type="search" placeholder="Search id, title, area…" aria-label="Search tasks" autocomplete="off">
    <kbd>/</kbd>
  </div>
  <div class="select"><select id="filter-status" aria-label="Filter by status">
    <option value="">All statuses</option>
    ${Object.entries(STATUS_META).map(([value, meta]) => `<option value="${value}">${escapeHtml(meta.label)}</option>`).join("")}
  </select></div>
  <div class="select"><select id="filter-risk" aria-label="Filter by risk">
    <option value="">Any risk</option>
    ${Object.keys(RISK_TONE).map((risk) => `<option value="${risk}">${risk}</option>`).join("")}
  </select></div>
  <div class="ad-toolbar-end">
    <span id="result-count" class="ad-result-count" aria-live="polite"></span>
    <div class="ad-segmented" role="group" aria-label="View">
      <button type="button" data-view-toggle="kanban" aria-pressed="true">▦ Kanban</button>
      <button type="button" data-view-toggle="list" aria-pressed="false">☰ List</button>
    </div>
  </div>
</div>`;

const renderModals = (): string => `
<div id="settings-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title" id="settings-title">Settings</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <div class="field">
        <label class="label" for="settings-token-input">Session token</label>
        <div class="control"><input id="settings-token-input" class="input" type="password" placeholder="paste the token printed by aidlc-kit ui" autocomplete="off" data-autofocus></div>
        <p class="help">Printed once in the terminal that started this server. Required for New task, resume, gate feedback, and gate approve. Stored only in this browser's localStorage.</p>
      </div>
    </section>
    <footer class="modal-card-foot">
      <span class="ad-foot-start" id="settings-token-state"></span>
      <button id="settings-token-clear" class="button is-light">Clear</button>
      <button id="settings-token-save" class="button is-primary">Save</button>
    </footer>
  </div>
</div>
<div id="new-task-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title" id="new-task-title">Start a new task</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <div class="field">
        <label class="label" for="new-task-requirement">Requirement</label>
        <div class="control"><textarea id="new-task-requirement" class="textarea" rows="6" placeholder="Describe the feature, bug fix, or change. The first line becomes the task title." data-autofocus></textarea></div>
        <div class="ad-field-hint"><span>The loop creates the task and starts the daemon if it is not running.</span><span id="new-task-count">0 / 8192 bytes</span></div>
      </div>
    </section>
    <footer class="modal-card-foot">
      <span class="ad-foot-start"><kbd>Ctrl</kbd>+<kbd>Enter</kbd> to submit</span>
      <button class="button" data-close>Cancel</button>
      <button id="new-task-submit" class="button is-primary">Create task</button>
    </footer>
  </div>
</div>
<div id="task-drawer" class="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title" hidden>
  <div class="ad-drawer-backdrop" data-drawer-close></div>
  <aside class="ad-drawer-panel" tabindex="-1">
    <header class="ad-drawer-head">
      <code id="task-drawer-title" class="ad-drawer-id">Task</code>
      <a id="task-drawer-open" class="button is-small" href="#" target="_blank" rel="noopener">Open full page ↗</a>
      <button type="button" class="delete" aria-label="Close task panel" data-drawer-close></button>
    </header>
    <div class="ad-drawer-body" id="task-drawer-body" data-live="drawer" data-live-hash=""><p class="has-text-grey">Loading…</p></div>
  </aside>
</div>
<div id="toasts" class="ad-toasts" aria-live="polite"></div>`;

/** The done column shows this many cards until "Show more" (or a filter) reveals the rest. */
export const DONE_COLUMN_LIMIT = 8;

/** Toolbar, kanban, and list (or the empty state): the dashboard's `board` live region. */
const renderBoard = (state: WorkflowState): string => {
  /* Terminal tasks (done/closed/superseded) are moved to the archive catalog on
   * save; list them too so they survive a reload. Active tasks keep priority
   * within the display limit; archived ones fill the remaining room. */
  const active = listTaskSummaries(state, { limit: DASHBOARD_LIMIT }).items;
  const archived = active.length < DASHBOARD_LIMIT
    ? listTaskSummaries({ ...state, tasks: {} }, { includeArchive: true, limit: DASHBOARD_LIMIT - active.length }).items
    : [];
  const items: CardTask[] = [...active, ...archived].map((task) => {
    const full = state.tasks[task.id];
    return full ? { ...task, feedbackPending: pendingFeedback(full).length } : task;
  });
  const handedOff = new Set(Object.values(state.tasks).filter((task) => task.handoff).map((task) => task.id));

  if (!items.length) return `<div class="ad-empty">
      <div class="ad-empty-icon" aria-hidden="true">🌱</div>
      <h2>No tasks yet</h2>
      <p>Describe a requirement and the loop will create the task and drive it through clarify → plan → build → wrap.</p>
      <button class="button is-primary" data-open="new-task-modal">＋ New task</button>
    </div>`;

  const kanban = PHASES.map((phase, index) => {
    const tasks = items.filter((task) => task.phase === phase);
    const cards = tasks.map((task) => renderTaskCard(task, handedOff.has(task.id))).join("\n");
    // The client hides cards past the limit (unless expanded or filtering) and labels the button.
    const collapse = phase === "done" ? ` data-collapse="${DONE_COLUMN_LIMIT}"` : "";
    const more = phase === "done" ? `<button type="button" class="ad-column-more" data-column-more${tasks.length > DONE_COLUMN_LIMIT ? "" : " hidden"}>Show ${Math.max(0, tasks.length - DONE_COLUMN_LIMIT)} more</button>` : "";
    return `<section class="ad-column" data-key="column:${phase}" data-phase-column="${phase}"${collapse}>
      <header class="ad-column-head"><span class="ad-step-index">${index + 1}</span><span class="ad-column-title">${escapeHtml(phase)}</span><span class="ad-count" data-column-count>${tasks.length}</span></header>
      <div class="ad-column-body">${cards}<p class="ad-column-empty" data-column-empty${tasks.length ? " hidden" : ""}>No tasks</p>${more}</div>
    </section>`;
  }).join("\n");

  const rows = items.map((task) => renderListRow(task, handedOff.has(task.id))).join("\n");

  return `${renderToolbar()}
    <div id="kanban-view"><div class="ad-board">${kanban}</div></div>
    <div id="list-view">
      <div class="ad-table-wrap"><table class="table ad-table is-fullwidth">
        <thead><tr><th>id</th><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>updated</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="ad-no-match" data-no-match>No tasks match the current filters. <button type="button" id="filter-clear" class="button is-small is-text">Clear filters</button></p>`;
};

const renderDashboard = async (options: UiOptions): Promise<string> => {
  const state = await readUiState(options);
  return `${pageHead("Loop")}
${renderHeader(options.root, uiMode(options), reviewQueue(state))}
<main class="section ad-main">
  <div class="container is-fluid">
    ${liveRegion("board", renderBoard(state))}
    <p class="ad-help">Click a task to open it in the side panel; ctrl/cmd-click or middle-click opens the full detail page. "New task" creates a loop-owned task and starts the daemon if it is not running; "resume" re-activates a paused task. The bell in the header lists tasks waiting at a human gate; pick one to open its detail page, where gate feedback and approval live (also on the trusted terminal <code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>). The page updates itself as the loop advances. Shortcuts: <kbd>N</kbd> new task · <kbd>/</kbd> search · <kbd>Esc</kbd> close panel or dialog.</p>
  </div>
</main>
${renderModals()}
${sharedScript}
</body>
</html>`;
};

/* ---------------------------------------------------------------------------
 * Task detail (page and side-panel fragment share the same body).
 * ------------------------------------------------------------------------- */

/** The artifact a reviewer most likely needs at each gate opens by default. */
const GATE_ARTIFACT: Record<string, string> = { G0_confirm: "intent", G1_review: "design", G2_codereview: "workplan" };

const panel = (title: string, body: string, extra = "", flush = false): string =>
  `<section class="ad-panel" data-key="panel:${escapeHtml(title)}"><header class="ad-panel-head"><h2>${escapeHtml(title)}</h2>${extra}</header><div class="ad-panel-body${flush ? " is-flush" : ""}">${body}</div></section>`;

/**
 * Task detail body shared by the full page (`detail` live region), the side
 * panel (`fragment`, `drawer` live region), and `/api/live`. Undefined when the
 * task does not exist. Keyed panels (`id`/`data-key`) let the client morph them
 * in place: open artifacts, typed feedback, and the live log survive updates.
 */
const renderTaskBody = async (options: UiOptions, state: WorkflowState, id: string, fragment: boolean, maxAgeMs = 0): Promise<{ task: TaskState; html: string } | undefined> => {
  const task = readUiTask(options, id, state);
  const fleet = uiMode(options) === "fleet";
  if (!task) return undefined;

  const waiting = task.status === "blocked_on_user" && task.gate !== "none";
  // A gate whose structural checks now fail (e.g. an artifact edited after the
  // wait was set) makes gateView throw; show the diagnostics instead of a 500.
  let gateBlock = "";
  if (waiting) {
    try {
      const gate = await taskGatePayload(options, id, state, maxAgeMs);
      if (gate.ok && gate.view) gateBlock = renderGateViewHtml(gate.view);
      else if (gate.ok && gate.snapshot) gateBlock = `<section class="ad-panel is-warning" data-key="gate-view"><header class="ad-panel-head"><h2>${escapeHtml(gateLabel(task.gate))} · review snapshot</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(gate.snapshot.id ?? "")}</span></header><div class="ad-panel-body"><div class="content artifact">${markdownToHtml(gate.snapshot.reviewText ?? "")}</div></div></section>`;
      else if (fleet) gateBlock = `<section class="ad-panel is-warning" data-key="gate-view"><header class="ad-panel-head"><h2>${escapeHtml(gateLabel(task.gate))}</h2></header><div class="ad-panel-body"><p>${escapeHtml(gate.error ?? "No review snapshot yet")}</p></div></section>`;
    } catch (error) {
      const problems = (error instanceof Error ? error.message : String(error)).split("; ").filter(Boolean);
      gateBlock = `<section class="ad-panel is-danger" data-key="gate-view">
        <header class="ad-panel-head"><span aria-hidden="true">⚠</span><h2>${escapeHtml(gateLabel(task.gate))} · gate check failing</h2><span class="ad-pill is-danger ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-3">The task waits at this gate, but its structural checks no longer pass. Approval will be rejected until these are fixed:</p>
          <ul class="ad-plain-list">${problems.map((problem) => `<li>${pill("ERROR", "is-danger")} ${escapeHtml(problem)}</li>`).join("")}</ul>
          <p class="is-size-7 has-text-grey mt-3">Re-check with <code>node .agents/aidlc/scripts/gate-check.mjs ${escapeHtml(task.id)} --gate ${escapeHtml(task.gate)}</code>.</p>
        </div>
      </section>`;
    }
  }

  /* Pending feedback: `Cancelled gate wait` evidence with no later approval of
   * that gate. While the task is active the lead is revising for it; while it
   * waits again, the reviewer should check the revision reflects it. */
  const pending = pendingFeedback(task);
  const pendingBlock = !fragment && pending.length
    ? `<section class="ad-panel is-info" id="feedback-pending-panel">
        <header class="ad-panel-head"><h2>Feedback pending</h2><span class="ad-pill is-info ad-panel-tools">${pending.length}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">${waiting
            ? "This gate was re-presented after human feedback. Check that the review artifact reflects it before approving; approving records the feedback as handled."
            : "The task stays at its gate. The loop lead is revising the review artifact for this feedback and will re-present the same gate."}</p>
          <ul class="ad-plain-list">${pending.map((entry) => `<li>${pill(gateLabel(entry.gate), "is-info", `gate: ${entry.gate}`, false)} ${escapeHtml(entry.text)} <span class="is-size-7 has-text-grey">· ${relativeTime(entry.recordedAt)}</span></li>`).join("")}</ul>
        </div>
      </section>`
    : "";

  /* Feedback never needs the fleet reviewer credential (it never approves), so
   * the block renders in both modes whenever the task waits at a gate. */
  const feedbackBlock = !fragment && waiting
    ? `<section class="ad-panel is-info" id="feedback-panel" data-gate="${escapeHtml(task.gate)}" data-gate-label="${escapeHtml(gateLabel(task.gate))}">
        <header class="ad-panel-head"><h2>Feedback · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">stays at this gate</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">Not ready to approve? Send guidance back to the loop. The task stays at <strong>${escapeHtml(gateLabel(task.gate))}</strong>; the lead revises the review artifact and re-presents this gate.</p>
          <div class="field">
            <label class="label is-small" for="feedback">Feedback <span class="has-text-grey has-text-weight-normal">(required, sent to the loop lead)</span></label>
            <div class="control"><textarea id="feedback" class="textarea" rows="3" placeholder="e.g. the scope misses the fleet path; split item B; the assumption about X is wrong"></textarea></div>
          </div>
          <div class="is-flex is-align-items-center" style="gap:0.75rem">
            <button id="feedback-button" class="button is-info">✎ Send feedback (stay at gate)</button>
            <span id="feedback-result" class="help m-0" role="status"></span>
          </div>
        </div>
      </section>`
    : "";

  const approveBlock = !fragment && waiting && fleet && !options.reviewerToken
    ? `<section class="ad-panel" id="approve-panel">
        <header class="ad-panel-head"><h2>Approve · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">This dashboard has no fleet reviewer credential. Approve from a reviewer terminal, or restart <code>aidlc-kit ui</code> with <code>AIDLC_FLEET_REVIEWER_TOKEN</code> or <code>--reviewer-token-file</code>. Feedback above needs no reviewer credential.</p>
          <pre class="is-size-7">node .agents/aidlc/scripts/remote-state.mjs gate inbox
node .agents/aidlc/scripts/remote-state.mjs gate approve ${escapeHtml(task.id)} --snapshot &lt;snapshot-id&gt; --source "&lt;explicit approval&gt;"</pre>
        </div>
      </section>`
    : !fragment && waiting
    ? `<section class="ad-panel is-success" id="approve-panel" data-gate="${escapeHtml(task.gate)}" data-gate-label="${escapeHtml(gateLabel(task.gate))}">
        <header class="ad-panel-head"><h2>Approve · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-2">Approving moves the task to the next phase. To request changes instead, use <strong>Feedback</strong> above — the note below is provenance only, not guidance for the loop.</p>
          ${pending.length ? `<p class="help is-warning mb-3" id="approve-pending-warning">⚠ ${pending.length} feedback item${pending.length === 1 ? "" : "s"} still pending — make sure the revised review addresses ${pending.length === 1 ? "it" : "them"} before approving.</p>` : ""}
          <div class="field">
            <label class="label is-small" for="source">Approval note <span class="has-text-grey has-text-weight-normal">(required, recorded as provenance)</span></label>
            <div class="control"><textarea id="source" class="textarea" rows="2" placeholder="e.g. reviewed intent and scope — ok"></textarea></div>
          </div>
          <div class="is-flex is-align-items-center" style="gap:0.75rem">
            <button id="approve-button" class="button is-success">✓ Approve</button>
            <span id="approve-result" class="help m-0" role="status"></span>
          </div>
        </div>
      </section>`
    : "";

  /* Confirmation dialog: the only control that sends the approve request. */
  const approveModal = !fragment && waiting && !(fleet && !options.reviewerToken)
    ? `<div id="approve-modal" class="modal" role="dialog" aria-modal="true" aria-labelledby="approve-modal-title" data-live-preserve="class">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title" id="approve-modal-title">Approve ${escapeHtml(gateLabel(task.gate))}?</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <p>This approves <strong>${escapeHtml(gateLabel(task.gate))}</strong> (<code>${escapeHtml(task.gate)}</code>) for <code>${escapeHtml(task.id)}</code> and moves the task to the next phase. It cannot be undone from the dashboard.</p>
      <p class="mt-2">To request changes instead, cancel and use <strong>Feedback</strong> — the task then stays at this gate.</p>
      <p class="is-size-7 has-text-grey mt-3 mb-1">Approval note</p>
      <blockquote id="approve-modal-note" class="box is-size-7 py-2 px-3 mb-0"></blockquote>
    </section>
    <footer class="modal-card-foot">
      <button class="button" data-close data-autofocus>Cancel</button>
      <button id="approve-confirm" class="button is-success">✓ Confirm approve</button>
    </footer>
  </div>
</div>`
    : "";

  const openArtifact = waiting ? GATE_ARTIFACT[task.gate] : undefined;
  const artifacts = ARTIFACT_NAMES.map((name) => {
    const artifactPath = task.artifacts?.[name];
    if (!artifactPath) return "";
    const payload = artifactPayload(options.root, id, name, task);
    const content = payload.ok && payload.content !== undefined
      ? `<div class="content artifact">${markdownToHtml(payload.content)}</div>`
      : `<p class="help is-danger px-5 pb-4">${escapeHtml(payload.error ?? "unavailable")}</p>`;
    return `<details class="ad-artifact" data-key="artifact:${name}"${name === openArtifact ? " open" : ""}><summary>${escapeHtml(name)}<code>${escapeHtml(artifactPath)}</code></summary>${content}</details>`;
  }).join("\n");

  const table = (head: string[], rows: string[], empty: string): string => rows.length
    ? `<table class="table ad-table is-fullwidth"><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("\n")}</tbody></table>`
    : `<p class="ad-empty-line">${escapeHtml(empty)}</p>`;

  const decisions = table(["decision", "status", "resolution"], task.decisions.map((decision) =>
    `<tr><td><code>${escapeHtml(decision.id)}</code><div class="is-size-7 has-text-grey mt-1">${escapeHtml(decision.label ?? "")}</div></td><td>${pill(decision.status, DECISION_TONE[decision.status] ?? "")}</td><td class="is-size-7">${escapeHtml(decision.resolution ?? "")}</td></tr>`), "No decisions recorded");

  const doneItems = task.tasks.filter((item) => item.status === "done").length;
  const workItems = table(["item", "status", "label"], task.tasks.map((item) =>
    `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${pill(item.status.replace("_", " "), ITEM_TONE[item.status] ?? "")}</td><td class="is-size-7">${escapeHtml(item.label ?? "")}</td></tr>`), "No work items yet");
  const workProgress = task.tasks.length
    ? `<div class="px-5 pt-4 pb-1"><progress class="progress is-small is-primary mb-0" value="${doneItems}" max="${task.tasks.length}" aria-label="work items done">${doneItems}/${task.tasks.length}</progress></div>`
    : "";

  const evidence = table(["kind", "result", "gate", "source", "recorded"], task.evidence.map((entry) =>
    `<tr><td><strong>${escapeHtml(entry.kind)}</strong>${entry.area ? `<div class="is-size-7 has-text-grey">${escapeHtml(entry.area)}</div>` : ""}</td><td>${pill(entry.result, RESULT_TONE[entry.result] ?? "")}</td><td class="is-size-7">${escapeHtml(entry.gate ?? "")}</td><td class="is-size-7">${escapeHtml(entry.source ?? "")}${entry.detail ? `<div class="has-text-grey mt-1">${escapeHtml(entry.detail)}</div>` : ""}</td><td class="is-size-7 has-text-grey">${relativeTime(entry.recordedAt)}</td></tr>`), "No verification evidence yet");

  const handoff = task.handoff
    ? `<section class="ad-panel" data-key="handoff" style="box-shadow:0 0 0 1px var(--bulma-danger)"><header class="ad-panel-head"><h2>Handed off · ${escapeHtml(task.handoff.kind)}</h2></header><div class="ad-panel-body"><p>${escapeHtml(task.handoff.reason)}</p><p class="is-size-7 has-text-grey mt-2">Follow the handoff actions from <code>node .agents/aidlc/scripts/state.mjs task next ${escapeHtml(task.id)}</code>.</p></div></section>`
    : "";

  const meta = `<dl class="ad-meta">
    <dt>Status</dt><dd>${statusPill(task.status, Boolean(task.handoff))}</dd>
    <dt>Gate</dt><dd>${task.gate === "none" ? '<span class="has-text-grey">none</span>' : `${escapeHtml(gateLabel(task.gate))}<div class="is-size-7 has-text-grey">${escapeHtml(task.gate)}</div>`}</dd>
    <dt>Risk</dt><dd>${riskPill(task.risk)}</dd>
    <dt>Type</dt><dd>${escapeHtml(task.type)}</dd>
    <dt>Language</dt><dd>${escapeHtml(task.language)}</dd>
    <dt>Areas</dt><dd>${escapeHtml(task.areas.join(", "))}</dd>
    <dt>Branch</dt><dd><code>${escapeHtml(task.branch)}</code></dd>
    <dt>Created</dt><dd>${relativeTime(task.createdAt)}</dd>
    <dt>Updated</dt><dd>${relativeTime(task.updatedAt)}</dd>
  </dl>`;

  // Client-owned (SSE lines): live updates never morph inside it.
  const liveLog = fragment ? "" : `<section class="ad-terminal" id="live-log" data-live-ignore>
    <div class="ad-terminal-head"><span class="ad-lights" aria-hidden="true"><span></span><span></span><span></span></span><strong>Live log</strong><span id="log-state">connecting…</span>
      <div class="ad-terminal-tools"><button type="button" id="log-follow" aria-pressed="true">Follow</button><button type="button" id="log-clear">Clear</button></div>
    </div>
    <div id="log" class="log-panel" role="log" aria-live="off"><span class="ad-log-muted">connecting…</span></div>
  </section>`;

  /* The side panel stays read-only; when a human action is due, point at the
   * full page that hosts it right at the top. */
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const drawerCta = !fragment ? ""
    : task.handoff
      ? `<div class="ad-callout is-danger ad-drawer-cta" data-key="drawer-cta"><span>Handed off · ${escapeHtml(task.handoff.kind)} — follow the handoff actions on the full page.</span><a class="button is-small is-danger" href="${href}">Open task →</a></div>`
      : waiting
        ? `<div class="ad-callout ad-drawer-cta" data-key="drawer-cta"><span>Waiting at <strong>${escapeHtml(gateLabel(task.gate))}</strong>${pending.length ? ` · ${pending.length} feedback pending` : ""} — send feedback or approve on the full page.</span><a class="button is-small is-warning" href="${href}" data-review-cta>Open review →</a></div>`
        : "";

  const body = `${drawerCta}<h1 class="ad-page-title">${escapeHtml(task.title)}</h1>
<div class="ad-page-sub"><code>${escapeHtml(task.id)}</code>${statusPill(task.status, Boolean(task.handoff))}${gatePill(task.gate)}${riskPill(task.risk)}${feedbackPill(pending.length)}</div>
${phaseStepper(task.phase, task.gate, task.status)}
<div class="columns is-desktop">
  <div class="column is-8-desktop">
    ${handoff}
    ${pendingBlock}
    ${gateBlock}
    ${feedbackBlock}
    ${approveBlock}
    ${panel("Artifacts", artifacts || '<p class="ad-empty-line">No artifacts recorded</p>', `<span class="ad-count">${ARTIFACT_NAMES.filter((name) => task.artifacts?.[name]).length}</span>`, true)}
    ${panel("Decisions", decisions, `<span class="ad-count">${task.decisions.length}</span>`, true)}
    ${panel("Work items", workProgress + workItems, `<span class="ad-count">${doneItems}/${task.tasks.length}</span>`, true)}
    ${panel("Evidence", evidence, `<span class="ad-count">${task.evidence.length}</span>`, true)}
    ${liveLog}
  </div>
  <aside class="column is-4-desktop">
    <div class="ad-sticky">
      ${panel("Details", meta)}
    </div>
  </aside>
</div>`;

  return { task, html: fragment ? body : `${body}${approveModal}` };
};

const taskNotFound = (options: UiOptions, id: string): string =>
  `<div class="ad-empty"><div class="ad-empty-icon" aria-hidden="true">🔍</div><h2>Task not found</h2><p><code>${escapeHtml(id)}</code> is not in the ${uiMode(options) === "fleet" ? "fleet" : "local"} canonical state.</p><a class="button" href="/">← Back to dashboard</a></div>`;
const drawerNotFound = (id: string): string => `<p class="has-text-danger">Task not found: ${escapeHtml(id)}</p>`;

/* Detail-page behaviour. Handlers are delegated (the controls are re-rendered by
 * live updates) and read the task and gate from the current DOM, never from
 * values baked in at page load. */
const detailScript = `<script>
const detailTask = () => document.body.getAttribute("data-task") || "";
// Feedback: keeps the task at this gate; the lead revises and re-presents it.
const onFeedbackSend = (button) => {
  const panel = document.getElementById("feedback-panel");
  const field = document.getElementById("feedback");
  const result = document.getElementById("feedback-result");
  if (!panel || !field) return;
  if (result) result.textContent = "";
  if (!field.value.trim()) { toast("Write the feedback first", "warning", "It is sent to the loop lead as guidance; the task stays at this gate."); field.focus(); return; }
  const label = panel.getAttribute("data-gate-label") || "";
  withLoading(button, async () => {
    const res = await post("/api/gate/feedback", { taskId: detailTask(), feedback: field.value });
    if (res.status >= 200 && res.status < 300) {
      field.value = "";
      toast("Feedback sent — task stays at " + label, "success", "The lead will revise the review artifact and re-present this gate.");
      await liveRefresh();
    } else failureToast(res, "Feedback failed");
  });
};
// Approve: the button only opens the confirmation dialog; "Confirm approve" sends.
const onApproveOpen = () => {
  const note = document.getElementById("source");
  const result = document.getElementById("approve-result");
  if (!note) return;
  if (result) result.textContent = "";
  if (!note.value.trim()) { toast("Add an approval note first", "warning", "It is recorded as the approval source. To request changes, use Feedback instead."); note.focus(); return; }
  const quote = document.getElementById("approve-modal-note");
  if (quote) quote.textContent = note.value.trim();
  openModal("approve-modal");
};
const onApproveConfirm = (button) => {
  const panel = document.getElementById("approve-panel");
  const note = document.getElementById("source");
  if (!panel || !note) return;
  const gate = panel.getAttribute("data-gate") || "";
  const label = panel.getAttribute("data-gate-label") || gate;
  withLoading(button, async () => {
    // The gate shown is sent along; the server refuses if the task has moved on since.
    const res = await post("/api/gate/approve", { taskId: detailTask(), gate, source: note.value });
    closeAllModals();
    if (res.status >= 200 && res.status < 300) {
      const next = res.body && res.body.result && res.body.result.nextAction;
      note.value = "";
      toast("Approved " + label, "success", next && next.classification ? "Next: " + next.classification + (next.phase ? " · " + next.phase : "") : "");
      await liveRefresh();
    } else failureToast(res, "Approval failed");
  });
};
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const feedback = target.closest("#feedback-button");
  if (feedback) { onFeedbackSend(feedback); return; }
  if (target.closest("#approve-button")) { onApproveOpen(); return; }
  const confirm = target.closest("#approve-confirm");
  if (confirm) onApproveConfirm(confirm);
});
(() => {
  const logEl = document.getElementById("log");
  const stateEl = document.getElementById("log-state");
  const followBtn = document.getElementById("log-follow");
  const clearBtn = document.getElementById("log-clear");
  if (!logEl) return;
  let follow = true;
  let started = false;
  const MAX_LINES = 2000;
  followBtn?.addEventListener("click", () => { follow = !follow; followBtn.setAttribute("aria-pressed", String(follow)); if (follow) logEl.scrollTop = logEl.scrollHeight; });
  clearBtn?.addEventListener("click", () => { logEl.textContent = ""; });
  const two = (n) => String(n).padStart(2, "0");
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "--:--:--" : two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds()); };
  const describe = (e) => {
    switch (e.type) {
      case "turn_start": return "turn " + (Number(e.iteration || 0) + 1) + " · phase " + (e.phase || "?") + " · agent " + (e.agent || "?");
      case "turn_end": return "turn done";
      case "agent_text": return e.text || "";
      case "agent_tool": return "tool: " + (e.tool || "?");
      case "lifecycle_command": return "command " + (e.status || "?") + " (exit " + (e.exitCode ?? "?") + ")";
      case "daemon_turn_error": return (e.message || "error") + " (retry in " + Math.round(Number(e.retryInMs || 0) / 1000) + "s)";
      case "loop_stopped": return "stopped: " + (e.reason || "");
      case "gate": return "gate " + (e.gate || "?") + " reached — review and approve on this page";
      case "waiting": return "waiting at " + (e.gate || "?");
      default: {
        if (e.message) return e.message;
        const rest = Object.assign({}, e); delete rest.at; delete rest.type; delete rest.taskId;
        const text = JSON.stringify(rest);
        return text === "{}" ? "" : text;
      }
    }
  };
  const tone = (type) => /error|fail/.test(type) ? "is-error" : /stop|wait|gate|blocked/.test(type) ? "is-warn" : /integrated|done|complete|end/.test(type) ? "is-ok" : /^agent/.test(type) ? "is-agent" : "";
  // Events that usually mean the canonical task changed: refresh the page regions now
  // instead of waiting for the next poll.
  const STATE_EVENTS = new Set(["turn_end", "lifecycle_command", "gate", "waiting", "daemon_turn", "daemon_turn_error", "loop_stopped"]);
  const append = (raw) => {
    if (!started) { logEl.textContent = ""; started = true; if (stateEl) stateEl.textContent = "streaming"; }
    const line = document.createElement("div");
    line.className = "ad-log-line";
    let event;
    try { event = JSON.parse(raw); } catch (error) { event = null; }
    if (event && typeof event === "object" && typeof event.type === "string") {
      const cls = tone(event.type);
      if (cls) line.classList.add(cls);
      const time = document.createElement("span"); time.className = "ad-log-time"; time.textContent = clock(event.at);
      const type = document.createElement("span"); type.className = "ad-log-type"; type.textContent = event.type;
      const text = document.createElement("span"); text.className = "ad-log-text"; text.textContent = describe(event);
      line.append(time, type, text);
      if (STATE_EVENTS.has(event.type)) liveRefresh();
    } else {
      line.textContent = raw;
    }
    logEl.appendChild(line);
    while (logEl.childElementCount > MAX_LINES) logEl.firstElementChild.remove();
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  };
  const events = new EventSource("/api/events?task-id=" + encodeURIComponent(detailTask()));
  events.onopen = () => { if (!started && stateEl) stateEl.textContent = "connected · waiting for events"; if (!started) logEl.innerHTML = "<span class='ad-log-muted'>No events for this task yet.</span>"; };
  events.onmessage = (message) => append(message.data);
  events.onerror = () => { if (stateEl) stateEl.textContent = started ? "reconnecting…" : "unavailable"; if (!started) logEl.innerHTML = "<span class='ad-log-muted'>Log stream unavailable (loop not running or sidecar missing).</span>"; };
})();
</script>`;

const renderTaskDetail = async (options: UiOptions, id: string, fragment = false): Promise<string> => {
  const state = await readUiState(options);
  const rendered = await renderTaskBody(options, state, id, fragment);
  if (fragment) return rendered ? rendered.html : drawerNotFound(id);
  const reviews = reviewQueue(state);
  if (!rendered) return `${pageHead("Task not found · Loop")}${renderHeader(options.root, uiMode(options), reviews)}<main class="section ad-main"><div class="container is-fluid">${taskNotFound(options, id)}</div></main>${renderModals()}${sharedScript}</body></html>`;
  return `${pageHead(`${rendered.task.title} · Loop`, rendered.task.id)}
${renderHeader(options.root, uiMode(options), reviews, rendered.task.id)}
<main class="section ad-main">
  <div class="container is-fluid">
    <a class="ad-breadcrumb" href="/">← Dashboard</a>
    ${liveRegion("detail", rendered.html)}
  </div>
</main>
${renderModals()}
${sharedScript}
${detailScript}
</body>
</html>`;
};

/** `/api/live`: re-renders the regions the client lists in `known` (name:hash)
 * from one state read and returns only those whose hash changed, plus the full
 * review list for the tab title and new-review toasts. */
const livePayload = async (options: UiOptions, url: URL): Promise<unknown> => {
  const known = new Map<string, string>();
  for (const entry of (url.searchParams.get("known") ?? "").split(",")) {
    const at = entry.indexOf(":");
    const name = at < 0 ? entry : entry.slice(0, at);
    if ((LIVE_REGIONS as readonly string[]).includes(name)) known.set(name, at < 0 ? "" : entry.slice(at + 1));
  }
  const maxAgeMs = uiMode(options) === "fleet" ? LIVE_FLEET_MAX_AGE_MS : 0;
  const state = await readUiState(options, maxAgeMs);
  const task = url.searchParams.get("task") ?? "";
  const drawer = url.searchParams.get("drawer") ?? "";
  const reviews = reviewQueue(state);
  const render = async (name: LiveRegion): Promise<string | undefined> => {
    switch (name) {
      case "notify": return renderNotifications(reviews, task, notifyLimit(url.searchParams.get("notify")));
      case "daemon": return renderDaemonPill(options.root);
      case "board": return renderBoard(state);
      case "detail": return task ? (await renderTaskBody(options, state, task, false, maxAgeMs))?.html ?? taskNotFound(options, task) : undefined;
      case "drawer": return drawer ? (await renderTaskBody(options, state, drawer, true, maxAgeMs))?.html ?? drawerNotFound(drawer) : undefined;
      default: return undefined;
    }
  };
  const regions: Record<string, { hash: string; html: string }> = {};
  for (const [name, hash] of known) {
    const html = await render(name as LiveRegion);
    if (html === undefined) continue;
    const next = regionHash(html);
    if (next !== hash) regions[name] = { hash: next, html };
  }
  return { ok: true, ...(drawer ? { drawer } : {}), regions, reviews: { count: reviews.length, items: reviews.map((item) => ({ id: item.id, title: item.title, gate: gateLabel(item.gate) })) } };
};

/** On a fresh connection the SSE stream replays at most this many lines. */
export const SSE_REPLAY_LINES = 200;
const SSE_REPLAY_BYTES = 256 * 1024;
const SSE_CHUNK_BYTES = 1024 * 1024;

const readRange = (path: string, start: number, end: number): Buffer => {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
};

/**
 * Streams the JSONL event-log sidecar as SSE. Tracks a byte offset (no full
 * re-read per tick), emits only newline-terminated lines (a half-written line
 * waits for the next tick), restarts at 0 when the file is truncated or rotated
 * (inode change), and replays only the last SSE_REPLAY_LINES on a fresh
 * connection. `?task-id=<id>` keeps only events stamped with that task id.
 * Event ids are `<inode>:<offset>` so EventSource reconnects resume exactly.
 */
const streamEvents = (options: UiOptions, res: ServerResponse, req: IncomingMessage, url: URL): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
  // Flush headers immediately (an empty log would otherwise leave the client
  // waiting for the first event) and keep idle connections alive.
  res.write(": connected\n\n");
  let idleTicks = 0;
  const path = eventsLogPath(options.root);
  const taskFilter = url.searchParams.get("task-id") ?? "";
  const resume = /^(\d+):(\d+)$/.exec(String(req.headers["last-event-id"] ?? ""));
  let inode: number | null = resume ? Number(resume[1]) : null;
  let position = resume ? Number(resume[2]) : -1;
  let firstTick = true;
  let discarding = false; // inside an oversized line that was skipped
  const matches = (line: string): boolean => {
    if (!taskFilter) return true;
    try { return (JSON.parse(line) as { taskId?: unknown }).taskId === taskFilter; } catch { return false; }
  };
  const send = (line: string, id: string): void => { res.write(`id: ${id}\ndata: ${line}\n\n`); };
  const emit = (): void => {
    try {
      let stat;
      try { stat = statSync(path); } catch { return; }
      // A stale Last-Event-ID from a rotated-away file replays the tail like a
      // fresh connection; a rotation seen while streaming follows the new file.
      if (inode !== null && stat.ino !== inode) { position = firstTick ? -1 : 0; discarding = false; }
      firstTick = false;
      inode = stat.ino;
      if (position < 0) {
        const start = Math.max(0, stat.size - SSE_REPLAY_BYTES);
        const buffer = readRange(path, start, stat.size);
        const last = buffer.lastIndexOf(0x0a);
        if (last < 0) { position = start; return; }
        position = start + last + 1;
        let lines = buffer.subarray(0, last).toString("utf8").split("\n");
        if (start > 0) lines = lines.slice(1);
        for (const line of lines.filter((entry) => entry.length > 0 && matches(entry)).slice(-SSE_REPLAY_LINES)) send(line, `${inode}:${position}`);
        return;
      }
      if (stat.size < position) { position = 0; discarding = false; }
      if (stat.size === position) return;
      const end = Math.min(stat.size, position + SSE_CHUNK_BYTES);
      let buffer = readRange(path, position, end);
      if (discarding) {
        // Drop the rest of an oversized line up to and including its newline.
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) { position = end; return; }
        position += newline + 1;
        buffer = buffer.subarray(newline + 1);
        discarding = false;
      }
      const last = buffer.lastIndexOf(0x0a);
      if (last < 0) { if (buffer.length >= SSE_CHUNK_BYTES) { position = end; discarding = true; } return; }
      let cursor = position;
      for (const line of buffer.subarray(0, last).toString("utf8").split("\n")) {
        cursor += Buffer.byteLength(line) + 1;
        if (line.length > 0 && matches(line)) send(line, `${inode}:${cursor}`);
      }
      position += last + 1;
    } catch { /* transient read errors are ignored until the next poll */ }
  };
  emit();
  const timer = setInterval(() => {
    emit();
    idleTicks += 1;
    if (idleTicks >= 30) { idleTicks = 0; res.write(": keep-alive\n\n"); }
  }, 500);
  const cleanup = (): void => clearInterval(timer);
  req.on("close", cleanup);
  res.on("close", cleanup);
};

/** Builds the request handler for the UI server (exported for unit tests). */
export const createUiHandler = (options: UiOptions): (req: IncomingMessage, res: ServerResponse) => void => {
  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host || "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;
    const guard = requestAllowed(options, req);
    if (!guard.ok) return sendJson(res, 403, { ok: false, error: guard.error });

    if (method === "GET" && path === "/api/events") return streamEvents(options, res, req, url);

    void (async () => {
      try {
        if (method === "GET" && path.startsWith("/assets/")) {
          const css = stylesheet(path);
          if (css !== undefined) return sendCss(res, css);
        }
        if (method === "GET" && path === "/") return sendHtml(res, await renderDashboard(options));
        if (method === "GET" && path === "/api/live") return sendJson(res, 200, await livePayload(options, url));
        if (method === "GET" && path.startsWith("/partial/tasks/")) {
          const id = decodeURIComponent(path.slice("/partial/tasks/".length));
          if (!id) return sendJson(res, 404, { ok: false, error: "Not found" });
          return sendHtml(res, await renderTaskDetail(options, id, true));
        }
        if (method === "GET" && path.startsWith("/tasks/")) {
          const id = decodeURIComponent(path.slice("/tasks/".length));
          if (!id) return sendJson(res, 404, { ok: false, error: "Not found" });
          return sendHtml(res, await renderTaskDetail(options, id));
        }
        if (method === "GET" && path === "/api/tasks") {
          const query = url.searchParams;
          const summary = listTaskSummaries(await readUiState(options), {
            includeArchive: query.get("archive") === "1",
            statuses: query.get("statuses") ? query.get("statuses")!.split(",").filter(Boolean) : undefined,
            query: query.get("query") ?? undefined,
            limit: query.get("limit") ? Number(query.get("limit")) : undefined,
            cursor: query.get("cursor") ? Number(query.get("cursor")) : undefined,
          });
          return sendJson(res, 200, summary);
        }
        if (method === "GET" && path.startsWith("/api/tasks/")) {
          const id = decodeURIComponent(path.slice("/api/tasks/".length));
          if (path.endsWith("/gate")) {
            const taskId = id.slice(0, -"/gate".length);
            const payload = await taskGatePayload(options, taskId);
            return sendJson(res, payload.ok ? 200 : 409, payload);
          }
          const artifactMatch = /^(.+)\/artifact\/(intent|design|workplan)$/.exec(id);
          if (artifactMatch) {
            const taskId = artifactMatch[1] ?? "";
            const payload = artifactPayload(options.root, taskId, artifactMatch[2] ?? "", readUiTask(options, taskId, await readUiState(options)));
            return sendJson(res, payload.ok ? 200 : 404, payload);
          }
          const task = readUiTask(options, id, await readUiState(options));
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${id}` });
          return sendJson(res, 200, { ok: true, task });
        }
        if (method === "GET" && path === "/api/loop/status") {
          const taskId = url.searchParams.get("task-id") ?? "";
          if (!taskId) return sendJson(res, 400, { ok: false, error: "task-id query parameter is required" });
          try { return sendJson(res, 200, { ok: true, result: await loopStatusJson(options.root, taskId) }); }
          catch (error) { return sendJson(res, 502, { ok: false, error: childError(error) }); }
        }
        if (method === "POST" && path === "/api/loop/start") {
          if (!tokenMatches(options.token ?? "", suppliedToken(req))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          const requirement = fields["requirement"] ?? "";
          if (!requirement.trim()) return sendJson(res, 400, { ok: false, error: "requirement is required" });
          if (Buffer.byteLength(requirement) > 8192) return sendJson(res, 400, { ok: false, error: "requirement exceeds 8192 bytes" });
          let created: { taskId: string; title: string };
          try { created = await intakeTask(options.root, requirement); }
          catch (error) { return sendJson(res, 409, { ok: false, error: childError(error) }); }
          return sendJson(res, 201, { ok: true, ...created, daemon: ensureDaemon(options.root) });
        }
        if (method === "POST" && path === "/api/loop/resume") {
          if (!tokenMatches(options.token ?? "", suppliedToken(req))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          const taskId = fields["taskId"] ?? "";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          const task = readUiTask(options, taskId, await readUiState(options));
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
          if (task.handoff) return sendJson(res, 409, { ok: false, error: "Task is handed off; follow its handoff actions (state.mjs task next) instead of resuming" });
          if (task.status === "blocked_on_user") return sendJson(res, 409, { ok: false, error: "Task is waiting at a human gate; approve it on the task detail page" });
          if (task.status !== "paused") return sendJson(res, 409, { ok: false, error: `Only a paused task can be resumed (status: ${task.status})` });
          try {
            const result = uiMode(options) === "fleet" ? JSON.parse(await runNode(options.root, loopArgs(options.root, "resume-task", taskId), { timeout: 30000 })) as unknown : await activateTask(options.root, taskId);
            return sendJson(res, 200, { ok: true, result, daemon: daemonStatus(options.root) });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: childError(error) });
          }
        }
        if (method === "POST" && path === "/api/gate/feedback") {
          if (!tokenMatches(options.token ?? "", suppliedToken(req))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          const taskId = fields["taskId"] ?? "";
          const feedback = (fields["feedback"] ?? "").trim();
          const source = (fields["source"] ?? "").trim() || "Dashboard feedback";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          if (!feedback) return sendJson(res, 400, { ok: false, error: "feedback is required" });
          const task = readUiTask(options, taskId, await readUiState(options));
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
          if (task.status !== "blocked_on_user" || task.gate === "none") return sendJson(res, 409, { ok: false, error: "Task is not waiting at a human gate" });
          try {
            // Feedback never approves, so it never needs the fleet reviewer credential.
            const result = uiMode(options) === "fleet"
              ? JSON.parse(await runNode(options.root, loopArgs(options.root, "feedback", taskId), { input: JSON.stringify({ reason: feedback, source }), timeout: 30000 })) as unknown
              : await feedbackGate(options.root, taskId, feedback, source);
            return sendJson(res, 200, { ok: true, result });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: childError(error) });
          }
        }
        if (method === "POST" && path === "/api/gate/approve") {
          if (!tokenMatches(options.token ?? "", suppliedToken(req))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          const taskId = fields["taskId"] ?? "";
          const source = fields["source"] ?? "";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          if (!source.trim()) return sendJson(res, 400, { ok: false, error: "source (approval note) is required" });
          const task = readUiTask(options, taskId, await readUiState(options));
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
          if (task.status !== "blocked_on_user" || task.gate === "none") return sendJson(res, 409, { ok: false, error: "Task is not waiting at a human gate" });
          const shownGate = (fields["gate"] ?? "").trim();
          if (shownGate && shownGate !== task.gate) return sendJson(res, 409, { ok: false, error: `The task moved on: it now waits at ${gateLabel(task.gate)} (${task.gate}), not ${shownGate}. Review it again before approving.` });
          if (uiMode(options) === "fleet" && !options.reviewerToken) return sendJson(res, 403, { ok: false, error: "Fleet approval needs the reviewer credential; restart aidlc-kit ui with AIDLC_FLEET_REVIEWER_TOKEN or --reviewer-token-file, or approve from a reviewer terminal" });
          try {
            // Fleet: the reviewer credential reaches only this single approve child process.
            const result = uiMode(options) === "fleet"
              ? JSON.parse(await runNode(options.root, loopArgs(options.root, "approve", taskId), { input: source, timeout: 30000, env: { AIDLC_FLEET_REVIEWER_TOKEN: options.reviewerToken ?? "" } })) as unknown
              : await approveGate(options.root, taskId, task.gate, source);
            return sendJson(res, 200, { ok: true, result });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: childError(error) });
          }
        }
        return sendJson(res, 404, { ok: false, error: `Not found: ${method} ${path}` });
      } catch (error) {
        if (res.headersSent || res.destroyed) return;
        if (error instanceof BadRequest || error instanceof URIError) return sendJson(res, 400, { ok: false, error: error.message });
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
};

/** Starts the UI HTTP server and resolves once it is listening. */
export const startUiServer = (options: UiOptions): Promise<{ server: Server; port: number; token: string }> =>
  new Promise((resolveServer, reject) => {
    const token = options.token ?? randomUUID();
    const mode = options.mode ?? resolveUiMode(options.root);
    const reviewerToken = options.reviewerToken ?? (mode === "fleet" ? process.env["AIDLC_FLEET_REVIEWER_TOKEN"] || undefined : undefined);
    const server = createServer(createUiHandler({ ...options, token, mode, ...(reviewerToken ? { reviewerToken } : {}) }));
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolveServer({ server, port, token });
    });
  });
