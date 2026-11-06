/**
 * Local web UI for the AI-DLC loop and task status.
 *
 * Read-only over canonical local state (`.agents/data/state/aidlc-state.json`).
 * Loop start/resume are thin facades that spawn the installed `loop-entry.mjs`
 * exactly as `aidlc-kit loop` does; gate approval is a thin facade that spawns
 * the same atomic `state.mjs gate approve` command. This module never mutates
 * lifecycle state itself and never bypasses the fail-closed gate channel.
 *
 * Built on `node:http` only; Bulma CSS and the dashboard theme layer are
 * vendored static assets (no CDN, no runtime npm dependency). Mutating actions (loop start/resume, gate
 * approve) require a per-session token generated at server start and printed
 * once to the terminal.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkGate, gateView } from "./gate.js";
import { assertTaskArtifactPath, listTaskSummaries, loadState, loadTask } from "./state.js";

export interface UiOptions {
  root: string;
  host: string;
  port: number;
  token?: string;
}

const loopEntryPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs");
const stateScriptPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "state.mjs");
const loopDataDir = (root: string): string => join(root, ".agents", "data", "loop");
const eventsLogPath = (root: string): string => join(loopDataDir(root), "ui-events.jsonl");
const daemonLockPath = (root: string): string => join(loopDataDir(root), "daemon.lock");
const daemonLogPath = (root: string): string => join(loopDataDir(root), "daemon.log");
const loopArgs = (root: string, action: string, taskId = ""): string[] => [loopEntryPath(root), action, taskId, root, "", "", "", ""];

const ARTIFACT_NAMES = ["intent", "design", "workplan"] as const;
const PHASES = ["clarify", "plan", "build", "wrap", "done"] as const;

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

const suppliedToken = (req: IncomingMessage, fields: Record<string, string>): string => {
  const authorization = req.headers["authorization"];
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  const header = req.headers["x-aidlc-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return fields["token"] ?? "";
};

const tokenMatches = (token: string, supplied: string): boolean => {
  if (!token || !supplied) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
};

/** Runs an installed workflow script with the current Node binary without
 * blocking the event loop; rejects with the child's stderr attached. */
const runNode = (root: string, args: string[], options: { input?: string; timeout: number }): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    const child = execFile(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: options.timeout }, (error, stdout, stderr) => {
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
      env: { ...process.env, AIDLC_LOOP_EVENT_LOG: eventsLogPath(root) },
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

const childError = (error: unknown): string => {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    try { const parsed = JSON.parse(stderr) as { error?: { message?: string } }; if (parsed.error?.message) return parsed.error.message; } catch { /* not JSON */ }
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
};

const taskGatePayload = (root: string, id: string): { ok: boolean; error?: string; gate?: string; view?: unknown } => {
  const state = loadState(root);
  const task = loadTask(root, id, state);
  if (!task) return { ok: false, error: `Task not found: ${id}` };
  if (task.status !== "blocked_on_user" || task.gate === "none") return { ok: false, error: "Task is not waiting at a human gate" };
  const diagnostics = checkGate(root, state, id, task.gate);
  return { ok: true, gate: task.gate, view: gateView(task, diagnostics) };
};

const artifactPayload = (root: string, id: string, name: string): { ok: boolean; error?: string; name?: string; content?: string } => {
  if (!(ARTIFACT_NAMES as readonly string[]).includes(name)) return { ok: false, error: `Unknown artifact: ${name}` };
  const task = loadTask(root, id);
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

const pageHead = (title: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="/assets/bulma.css">
<link rel="stylesheet" href="/assets/dashboard.css">
</head>
<body>`;

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

const phaseTimeline = (phase: string, gate: string, status: string): string => {
  const current = (PHASES as readonly string[]).indexOf(phase);
  return `<ol class="ad-timeline">${PHASES.map((name, index) => {
    const complete = phase === "done" || index < current;
    const isCurrent = !complete && index === current;
    const phaseGate = PHASE_GATE[name];
    const note = isCurrent && status === "blocked_on_user" && gate !== "none"
      ? `waiting at ${gateLabel(gate)}`
      : phaseGate ? `gate · ${gateLabel(phaseGate)}` : name === "done" ? "complete" : "no gate";
    return `<li class="${complete ? "is-complete" : isCurrent ? "is-current" : ""}"><span class="ad-timeline-marker">${complete ? "✓" : index + 1}</span><span class="ad-timeline-text"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(note)}</small></span></li>`;
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
  return `<section class="ad-panel is-warning">
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

const jsonToHtml = (value: unknown): string => {
  if (value === null || value === undefined) return '<span class="has-text-grey">null</span>';
  if (typeof value === "boolean" || typeof value === "number") return escapeHtml(String(value));
  if (typeof value === "string") return escapeHtml(value);
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="has-text-grey">[]</span>';
    return `<ul>${value.map((item) => `<li>${jsonToHtml(item)}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '<span class="has-text-grey">{}</span>';
    return `<table><tbody>${entries.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${jsonToHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  }
  return escapeHtml(String(value));
};

/* ---------------------------------------------------------------------------
 * Client script shared across dashboard and detail page.
 * All dynamic text is written with textContent; never innerHTML of user data.
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
const toast = (message, kind = "info", detail = "") => {
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
  body.textContent = message;
  if (detail) { const small = document.createElement("small"); small.textContent = detail; body.appendChild(small); }
  const close = document.createElement("button");
  close.className = "ad-toast-close";
  close.setAttribute("aria-label", "dismiss");
  close.textContent = "×";
  const dismiss = () => { item.classList.add("is-leaving"); setTimeout(() => item.remove(), 220); };
  close.addEventListener("click", dismiss);
  item.append(icon, body, close);
  stack.appendChild(item);
  setTimeout(dismiss, kind === "danger" ? 9000 : 4500);
};
const failureToast = (res, fallback) => {
  const message = (res.body && res.body.error) || fallback;
  toast(message, "danger", res.status === 401 ? "Paste the session token in Settings (top right) and retry." : "HTTP " + res.status);
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
const openTaskModal = async (id) => {
  const body = document.getElementById("task-modal-body");
  const link = document.getElementById("task-modal-open");
  if (body) body.innerHTML = "<p class='has-text-grey'>Loading…</p>";
  if (link) link.href = "/tasks/" + encodeURIComponent(id);
  openModal("task-modal");
  try {
    const response = await fetch("/partial/tasks/" + encodeURIComponent(id));
    if (body) body.innerHTML = response.ok ? await response.text() : "<p class='has-text-danger'>Failed to load task detail.</p>";
  } catch (error) {
    if (body) body.innerHTML = "<p class='has-text-danger'>Failed to load task detail.</p>";
  }
};
const isTyping = (target) => !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const REQUIREMENT_LIMIT = 8192;
document.addEventListener("DOMContentLoaded", () => {
  const tokenInput = document.getElementById("settings-token-input");
  if (tokenInput) tokenInput.value = storedToken();
  const tokenState = document.getElementById("settings-token-state");
  const renderTokenState = () => { if (tokenState) tokenState.textContent = storedToken() ? "Token saved in this browser" : "No token saved"; };
  renderTokenState();
  document.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openModal(el.getAttribute("data-open"))));
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => closeAllModals()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeAllModals(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target) || document.querySelector(".modal.is-active")) return;
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
      toast("Task " + res.body.taskId + " created", "success", daemon.started ? "Started the loop daemon (pid " + daemon.pid + ")" : "Picked up by the running daemon");
      closeAllModals();
      setTimeout(() => location.reload(), 1200);
    } else failureToast(res, "Could not create the task");
  }));

  document.querySelectorAll("[data-task-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openTaskModal(link.getAttribute("data-task-link"));
    });
  });

  const viewKey = "aidlc-view";
  const applyView = (view) => {
    const kanban = document.getElementById("kanban-view");
    const list = document.getElementById("list-view");
    if (kanban) kanban.style.display = view === "kanban" ? "" : "none";
    if (list) list.style.display = view === "list" ? "" : "none";
    document.querySelectorAll("[data-view-toggle]").forEach((el) => {
      const active = el.getAttribute("data-view-toggle") === view;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  };
  document.querySelectorAll("[data-view-toggle]").forEach((el) => el.addEventListener("click", () => { const v = el.getAttribute("data-view-toggle"); localStorage.setItem(viewKey, v); applyView(v); }));
  applyView(localStorage.getItem(viewKey) || "kanban");

  // Client-side filtering over server-rendered cards and rows (no extra API calls).
  const search = document.getElementById("task-search");
  const statusFilter = document.getElementById("filter-status");
  const riskFilter = document.getElementById("filter-risk");
  const resultCount = document.getElementById("result-count");
  const applyFilter = () => {
    const terms = (search ? search.value : "").toLowerCase().split(/\\s+/).filter(Boolean);
    const status = statusFilter ? statusFilter.value : "";
    const risk = riskFilter ? riskFilter.value : "";
    const matches = (el) => (!status || el.getAttribute("data-status") === status) && (!risk || el.getAttribute("data-risk") === risk) && terms.every((term) => (el.getAttribute("data-search") || "").includes(term));
    let visible = 0;
    document.querySelectorAll("#kanban-view [data-task-item]").forEach((el) => { const show = matches(el); el.hidden = !show; if (show) visible += 1; });
    document.querySelectorAll("#list-view [data-task-item]").forEach((el) => { el.hidden = !matches(el); });
    document.querySelectorAll("[data-phase-column]").forEach((column) => {
      const count = column.querySelectorAll("[data-task-item]:not([hidden])").length;
      const badge = column.querySelector("[data-column-count]");
      if (badge) badge.textContent = String(count);
      const empty = column.querySelector("[data-column-empty]");
      if (empty) empty.hidden = count > 0;
    });
    const total = document.querySelectorAll("#kanban-view [data-task-item]").length;
    const filtered = terms.length || status || risk;
    if (resultCount) resultCount.textContent = filtered ? visible + " of " + total + " tasks" : total + (total === 1 ? " task" : " tasks");
    document.querySelectorAll("[data-no-match]").forEach((el) => el.classList.toggle("is-visible", !!filtered && visible === 0));
    document.querySelectorAll("[data-stat-filter]").forEach((el) => el.setAttribute("aria-pressed", String(el.getAttribute("data-stat-filter") === status && !terms.length && !risk)));
  };
  [search, statusFilter, riskFilter].forEach((el) => { if (el) el.addEventListener("input", applyFilter); });
  document.querySelectorAll("[data-stat-filter]").forEach((el) => el.addEventListener("click", () => {
    if (!statusFilter) return;
    const value = el.getAttribute("data-stat-filter") || "";
    statusFilter.value = statusFilter.value === value ? "" : value;
    if (search) search.value = "";
    if (riskFilter) riskFilter.value = "";
    applyFilter();
  }));
  const clearFilters = document.getElementById("filter-clear");
  if (clearFilters) clearFilters.addEventListener("click", () => { if (search) search.value = ""; if (statusFilter) statusFilter.value = ""; if (riskFilter) riskFilter.value = ""; applyFilter(); });
  if (search || statusFilter) applyFilter();
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-resume]");
  if (!button) return;
  event.preventDefault();
  const taskId = button.getAttribute("data-resume");
  withLoading(button, async () => {
    const res = await post("/api/loop/resume", { taskId });
    if (res.status >= 200 && res.status < 300) { toast("Resumed " + taskId, "success", "The daemon will pick it up on its next poll"); setTimeout(() => location.reload(), 1200); }
    else failureToast(res, "Could not resume " + taskId);
  });
});
</script>`;

/* ---------------------------------------------------------------------------
 * Dashboard: stats, review queue, filters, kanban (default) + list toggle.
 * ------------------------------------------------------------------------- */

interface CardTask { id: string; title: string; phase: string; gate: string; status: string; risk: string; areas: string[]; updatedAt?: string }

/** Per-status action: a paused task can be re-activated for the daemon; a task
 * waiting at a human gate links to the detail page that hosts gate approval. */
const taskAction = (task: { id: string; status: string }, handedOff = false): string => {
  if (handedOff) return `<a class="button is-small is-danger ad-soft" href="/tasks/${encodeURIComponent(task.id)}" title="handed off: follow the handoff actions">handoff</a>`;
  if (task.status === "paused") return `<button class="button is-small is-link ad-soft" data-resume="${escapeHtml(task.id)}">resume</button>`;
  if (task.status === "blocked_on_user") return `<a class="button is-small is-warning" href="/tasks/${encodeURIComponent(task.id)}">approve</a>`;
  return "";
};

const renderDaemonPill = (root: string): string => {
  const daemon = daemonStatus(root);
  return daemon.running
    ? `<span class="ad-pill is-success is-live" title="started ${escapeHtml(daemon.startedAt ?? "")}"><span class="ad-dot"></span>daemon running · pid ${daemon.pid}</span>`
    : `<span class="ad-pill is-ghost" title="start it with: aidlc-kit loop start (or New task)"><span class="ad-dot"></span>daemon stopped</span>`;
};

const renderHeader = (root: string): string => `<header class="ad-header">
  <div class="container ad-header-inner">
    <a class="ad-brand" href="/"><span class="ad-logo" aria-hidden="true">AI</span>AI-DLC Loop</a>
    ${renderDaemonPill(root)}
    <div class="ad-header-actions">
      <button class="button is-small" data-open="settings-modal" title="Settings">⚙<span class="ad-hide-mobile ml-1">Settings</span></button>
      <button class="button is-small is-primary" data-open="new-task-modal">＋ New task<kbd class="ad-hide-mobile">N</kbd></button>
    </div>
  </div>
</header>`;

/** Lower-cased haystack for client-side search (escaped when rendered). */
const searchText = (task: CardTask): string =>
  [task.id, task.title, task.phase, task.gate, gateLabel(task.gate), task.status, STATUS_META[task.status]?.label ?? "", task.risk, ...task.areas].join(" ").toLowerCase();

const itemAttrs = (task: CardTask, handedOff: boolean): string =>
  `data-task-item data-status="${escapeHtml(task.status)}" data-risk="${escapeHtml(task.risk)}"${handedOff ? ' data-handoff="true"' : ""} data-search="${escapeHtml(searchText(task))}"`;

const renderTaskCard = (task: CardTask, handedOff = false): string => {
  const href = `/tasks/${encodeURIComponent(task.id)}`;
  const attention = task.status === "blocked_on_user" && !handedOff;
  return `<article class="ad-card${attention ? " is-attention" : ""}" ${itemAttrs(task, handedOff)}>
    <div class="ad-card-top"><a class="ad-card-id" href="${href}" data-task-link="${escapeHtml(task.id)}" title="${escapeHtml(task.id)}">${escapeHtml(task.id)}</a>${statusPill(task.status, handedOff)}</div>
    <div class="ad-card-title"><a href="${href}" data-task-link="${escapeHtml(task.id)}">${escapeHtml(task.title)}</a></div>
    ${phaseSteps(task.phase)}
    <div class="ad-card-meta">${gatePill(task.gate)}${riskPill(task.risk)}</div>
    <div class="ad-card-foot"><span class="ad-areas" title="areas: ${escapeHtml(task.areas.join(", "))}">${escapeHtml(task.areas.join(", "))}</span>${task.updatedAt ? `<span>· ${relativeTime(task.updatedAt)}</span>` : ""}${taskAction(task, handedOff)}</div>
  </article>`;
};

const renderListRow = (task: CardTask, handedOff: boolean): string => `<tr ${itemAttrs(task, handedOff)}>
  <td><a href="/tasks/${encodeURIComponent(task.id)}" data-task-link="${escapeHtml(task.id)}"><code>${escapeHtml(task.id)}</code></a></td>
  <td class="has-text-weight-semibold">${escapeHtml(task.title)}</td>
  <td><div class="is-size-7 mb-1">${escapeHtml(task.phase)}</div>${phaseSteps(task.phase)}</td>
  <td>${gatePill(task.gate) || '<span class="has-text-grey">—</span>'}</td>
  <td>${statusPill(task.status, handedOff)}</td>
  <td>${riskPill(task.risk)}</td>
  <td class="is-size-7">${escapeHtml(task.areas.join(", "))}</td>
  <td class="is-size-7 has-text-grey">${relativeTime(task.updatedAt)}</td>
  <td class="has-text-right">${taskAction(task, handedOff)}</td>
</tr>`;

const renderStats = (tasks: CardTask[], handedOff: Set<string>): string => {
  const count = (predicate: (task: CardTask) => boolean): number => tasks.filter(predicate).length;
  const stat = (label: string, value: number, tone: string, filter: string): string =>
    `<button type="button" class="ad-stat ${tone}" data-stat-filter="${filter}" aria-pressed="false" title="${filter ? `Filter: ${escapeHtml(filter)}` : "Show all"}"><span class="ad-stat-label"><span class="ad-dot"></span>${escapeHtml(label)}</span><span class="ad-stat-value">${value}</span></button>`;
  return `<div class="ad-stats">
    ${stat("Total", tasks.length, "is-primary", "")}
    ${stat("Active", count((t) => t.status === "active"), "is-info", "active")}
    ${stat("Needs review", count((t) => t.status === "blocked_on_user" && !handedOff.has(t.id)), "is-warning", "blocked_on_user")}
    ${stat("Paused", count((t) => t.status === "paused"), "", "paused")}
    ${stat("Done", count((t) => t.status === "done"), "is-success", "done")}
  </div>`;
};

const renderReviewQueue = (tasks: CardTask[], handedOff: Set<string>): string => {
  const waiting = tasks.filter((task) => task.status === "blocked_on_user" && task.gate !== "none" && !handedOff.has(task.id));
  if (!waiting.length) return "";
  return `<section class="ad-attention" aria-labelledby="review-queue-title">
    <div class="ad-attention-head"><span aria-hidden="true">⏳</span><span id="review-queue-title">Needs your review</span><span class="ad-count">${waiting.length}</span></div>
    <ul class="ad-attention-list">${waiting.map((task) => `<li class="ad-attention-item">
      ${pill(gateLabel(task.gate), "is-warning", `gate: ${task.gate}`, false)}
      <code>${escapeHtml(task.id)}</code>
      <span class="ad-title">${escapeHtml(task.title)}</span>
      <span class="is-size-7 has-text-grey">${relativeTime(task.updatedAt)}</span>
      <span class="ad-actions"><a class="button is-small is-warning ad-soft" href="/tasks/${encodeURIComponent(task.id)}">Open review →</a></span>
    </li>`).join("")}</ul>
  </section>`;
};

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
        <p class="help">Printed once in the terminal that started this server. Required for New task, resume, and gate approve. Stored only in this browser's localStorage.</p>
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
<div id="task-modal" class="modal" role="dialog" aria-modal="true" aria-label="Task detail">
  <div class="modal-background" data-close></div>
  <div class="modal-card is-wide">
    <header class="modal-card-head">
      <p class="modal-card-title">Task</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body" id="task-modal-body"><p class="has-text-grey">Loading…</p></section>
    <footer class="modal-card-foot">
      <button class="button is-small" data-close>Close</button>
      <a id="task-modal-open" class="button is-small is-link" href="#" target="_blank" rel="noopener">Open full page ↗</a>
    </footer>
  </div>
</div>
<div id="toasts" class="ad-toasts" aria-live="polite"></div>`;

const renderDashboard = (options: UiOptions): string => {
  const state = loadState(options.root);
  const { items } = listTaskSummaries(state, { limit: 100 });
  const handedOff = new Set(Object.values(state.tasks).filter((task) => task.handoff).map((task) => task.id));

  const kanban = PHASES.map((phase, index) => {
    const tasks = items.filter((task) => task.phase === phase);
    const cards = tasks.map((task) => renderTaskCard(task, handedOff.has(task.id))).join("\n");
    return `<section class="ad-column" data-phase-column="${phase}">
      <header class="ad-column-head"><span class="ad-step-index">${index + 1}</span><span class="ad-column-title">${escapeHtml(phase)}</span><span class="ad-count" data-column-count>${tasks.length}</span></header>
      <div class="ad-column-body">${cards}<p class="ad-column-empty" data-column-empty${tasks.length ? " hidden" : ""}>No tasks</p></div>
    </section>`;
  }).join("\n");

  const rows = items.map((task) => renderListRow(task, handedOff.has(task.id))).join("\n");

  const board = items.length
    ? `${renderToolbar()}
    <div id="kanban-view"><div class="ad-board">${kanban}</div></div>
    <div id="list-view" style="display:none">
      <div class="ad-table-wrap"><table class="table ad-table is-fullwidth">
        <thead><tr><th>id</th><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>updated</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <p class="ad-no-match" data-no-match>No tasks match the current filters. <button type="button" id="filter-clear" class="button is-small is-text">Clear filters</button></p>`
    : `<div class="ad-empty">
      <div class="ad-empty-icon" aria-hidden="true">🌱</div>
      <h2>No tasks yet</h2>
      <p>Describe a requirement and the loop will create the task and drive it through clarify → plan → build → wrap.</p>
      <button class="button is-primary" data-open="new-task-modal">＋ New task</button>
    </div>`;

  return `${pageHead("AI-DLC Loop")}
${renderHeader(options.root)}
<main class="section ad-main">
  <div class="container">
    ${renderStats(items, handedOff)}
    ${renderReviewQueue(items, handedOff)}
    ${board}
    <p class="ad-help">Click a task to open a quick view; ctrl/cmd-click or middle-click opens the full detail page. "New task" creates a loop-owned task and starts the daemon if it is not running; "resume" re-activates a paused task. Gate approval stays available on the detail page and on the trusted terminal (<code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>). Shortcuts: <kbd>N</kbd> new task · <kbd>/</kbd> search · <kbd>Esc</kbd> close.</p>
  </div>
</main>
${renderModals()}
${sharedScript}
</body>
</html>`;
};

/* ---------------------------------------------------------------------------
 * Task detail (page and modal fragment share the same body).
 * ------------------------------------------------------------------------- */

/** The artifact a reviewer most likely needs at each gate opens by default. */
const GATE_ARTIFACT: Record<string, string> = { G0_confirm: "intent", G1_review: "design", G2_codereview: "workplan" };

const panel = (title: string, body: string, extra = "", flush = false): string =>
  `<section class="ad-panel"><header class="ad-panel-head"><h2>${escapeHtml(title)}</h2>${extra}</header><div class="ad-panel-body${flush ? " is-flush" : ""}">${body}</div></section>`;

const renderTaskDetail = async (options: UiOptions, id: string, fragment = false): Promise<string> => {
  const state = loadState(options.root);
  const task = loadTask(options.root, id, state);
  if (!task) {
    const body = `<p class="has-text-danger">Task not found: ${escapeHtml(id)}</p>`;
    return fragment ? body : `${pageHead("Task not found")}${renderHeader(options.root)}<main class="section ad-main"><div class="container"><div class="ad-empty"><div class="ad-empty-icon" aria-hidden="true">🔍</div><h2>Task not found</h2><p><code>${escapeHtml(id)}</code> is not in the local canonical state.</p><a class="button" href="/">← Back to dashboard</a></div></div></main>${renderModals()}${sharedScript}</body></html>`;
  }

  const waiting = task.status === "blocked_on_user" && task.gate !== "none";
  // A gate whose structural checks now fail (e.g. an artifact edited after the
  // wait was set) makes gateView throw; show the diagnostics instead of a 500.
  let gateBlock = "";
  if (waiting) {
    try {
      const gate = taskGatePayload(options.root, id);
      if (gate.ok && gate.view) gateBlock = renderGateViewHtml(gate.view);
    } catch (error) {
      const problems = (error instanceof Error ? error.message : String(error)).split("; ").filter(Boolean);
      gateBlock = `<section class="ad-panel is-danger">
        <header class="ad-panel-head"><span aria-hidden="true">⚠</span><h2>${escapeHtml(gateLabel(task.gate))} · gate check failing</h2><span class="ad-pill is-danger ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
          <p class="mb-3">The task waits at this gate, but its structural checks no longer pass. Approval will be rejected until these are fixed:</p>
          <ul class="ad-plain-list">${problems.map((problem) => `<li>${pill("ERROR", "is-danger")} ${escapeHtml(problem)}</li>`).join("")}</ul>
          <p class="is-size-7 has-text-grey mt-3">Re-check with <code>node .agents/aidlc/scripts/gate-check.mjs ${escapeHtml(task.id)} --gate ${escapeHtml(task.gate)}</code>.</p>
        </div>
      </section>`;
    }
  }

  const approveBlock = !fragment && waiting
    ? `<section class="ad-panel is-success" id="approve-panel">
        <header class="ad-panel-head"><h2>Approve · ${escapeHtml(gateLabel(task.gate))}</h2><span class="ad-pill is-ghost ad-panel-tools">${escapeHtml(task.gate)}</span></header>
        <div class="ad-panel-body">
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

  const openArtifact = waiting ? GATE_ARTIFACT[task.gate] : undefined;
  const artifacts = ARTIFACT_NAMES.map((name) => {
    const artifactPath = task.artifacts?.[name];
    if (!artifactPath) return "";
    const payload = artifactPayload(options.root, id, name);
    const content = payload.ok && payload.content !== undefined
      ? `<div class="content artifact">${markdownToHtml(payload.content)}</div>`
      : `<p class="help is-danger px-5 pb-4">${escapeHtml(payload.error ?? "unavailable")}</p>`;
    return `<details class="ad-artifact"${name === openArtifact ? " open" : ""}><summary>${escapeHtml(name)}<code>${escapeHtml(artifactPath)}</code></summary>${content}</details>`;
  }).join("\n");

  let loopStatus: string;
  try {
    loopStatus = `<div class="ad-kv">${jsonToHtml(await loopStatusJson(options.root, id))}</div>`;
  } catch (error) {
    const message = childError(error);
    const summary = message.split("\n").map((line) => line.trim()).find((line) => /error/i.test(line)) ?? message.split("\n")[0] ?? "";
    loopStatus = `<p class="help is-danger m-0">Loop status unavailable: ${escapeHtml(summary.slice(0, 240))}</p>${message.length > summary.length ? `<details class="mt-2 is-size-7"><summary class="has-text-grey">details</summary><pre class="mt-2" style="white-space:pre-wrap">${escapeHtml(message)}</pre></details>` : ""}`;
  }

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
    ? `<section class="ad-panel" style="box-shadow:0 0 0 1px var(--bulma-danger)"><header class="ad-panel-head"><h2>Handed off · ${escapeHtml(task.handoff.kind)}</h2></header><div class="ad-panel-body"><p>${escapeHtml(task.handoff.reason)}</p><p class="is-size-7 has-text-grey mt-2">Follow the handoff actions from <code>node .agents/aidlc/scripts/state.mjs task next ${escapeHtml(task.id)}</code>.</p></div></section>`
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

  const liveLog = fragment ? "" : `<section class="ad-terminal">
    <div class="ad-terminal-head"><span class="ad-lights" aria-hidden="true"><span></span><span></span><span></span></span><strong>Live log</strong><span id="log-state">connecting…</span>
      <div class="ad-terminal-tools"><button type="button" id="log-follow" aria-pressed="true">Follow</button><button type="button" id="log-clear">Clear</button></div>
    </div>
    <div id="log" class="log-panel" role="log" aria-live="off"><span class="ad-log-muted">connecting…</span></div>
  </section>`;

  const body = `<h1 class="ad-page-title">${escapeHtml(task.title)}</h1>
<div class="ad-page-sub"><code>${escapeHtml(task.id)}</code>${statusPill(task.status, Boolean(task.handoff))}${gatePill(task.gate)}${riskPill(task.risk)}</div>
<div class="columns is-desktop">
  <div class="column is-8-desktop">
    ${handoff}
    ${gateBlock}
    ${approveBlock}
    ${panel("Artifacts", artifacts || '<p class="ad-empty-line">No artifacts recorded</p>', `<span class="ad-count">${ARTIFACT_NAMES.filter((name) => task.artifacts?.[name]).length}</span>`, true)}
    ${panel("Decisions", decisions, `<span class="ad-count">${task.decisions.length}</span>`, true)}
    ${panel("Work items", workProgress + workItems, `<span class="ad-count">${doneItems}/${task.tasks.length}</span>`, true)}
    ${panel("Evidence", evidence, `<span class="ad-count">${task.evidence.length}</span>`, true)}
    ${liveLog}
  </div>
  <aside class="column is-4-desktop">
    <div class="ad-sticky">
      ${panel("Progress", phaseTimeline(task.phase, task.gate, task.status))}
      ${panel("Details", meta)}
      ${panel("Loop status", loopStatus)}
    </div>
  </aside>
</div>`;

  if (fragment) return body;

  const detailScript = `<script>
document.getElementById("approve-button")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const note = document.getElementById("source");
  const result = document.getElementById("approve-result");
  if (result) result.textContent = "";
  if (!note.value.trim()) { toast("Add an approval note first", "warning", "It is recorded as the approval source."); note.focus(); return; }
  withLoading(button, async () => {
    const res = await post("/api/gate/approve", { taskId: ${JSON.stringify(id)}, gate: ${JSON.stringify(task.gate)}, source: note.value });
    if (res.status >= 200 && res.status < 300) {
      const next = res.body && res.body.result && res.body.result.nextAction;
      toast(${JSON.stringify(`Approved ${gateLabel(task.gate)}`)}, "success", next && next.classification ? "Next: " + next.classification + (next.phase ? " · " + next.phase : "") : "");
      if (result) result.textContent = "Approved — reloading…";
      setTimeout(() => location.reload(), 1500);
    } else failureToast(res, "Approval failed");
  });
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
    } else {
      line.textContent = raw;
    }
    logEl.appendChild(line);
    while (logEl.childElementCount > MAX_LINES) logEl.firstElementChild.remove();
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  };
  const events = new EventSource("/api/events?task-id=" + encodeURIComponent(${JSON.stringify(id)}));
  events.onopen = () => { if (!started && stateEl) stateEl.textContent = "connected · waiting for events"; if (!started) logEl.innerHTML = "<span class='ad-log-muted'>No events for this task yet.</span>"; };
  events.onmessage = (message) => append(message.data);
  events.onerror = () => { if (stateEl) stateEl.textContent = started ? "reconnecting…" : "unavailable"; if (!started) logEl.innerHTML = "<span class='ad-log-muted'>Log stream unavailable (loop not running or sidecar missing).</span>"; };
})();
</script>`;

  return `${pageHead(`${task.title} · ${id}`)}
${renderHeader(options.root)}
<main class="section ad-main">
  <div class="container">
    <a class="ad-breadcrumb" href="/">← Dashboard</a>
    ${body}
  </div>
</main>
${renderModals()}
${sharedScript}
${detailScript}
</body>
</html>`;
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

    if (method === "GET" && path === "/api/events") return streamEvents(options, res, req, url);

    void (async () => {
      try {
        if (method === "GET" && path.startsWith("/assets/")) {
          const css = stylesheet(path);
          if (css !== undefined) return sendCss(res, css);
        }
        if (method === "GET" && path === "/") return sendHtml(res, renderDashboard(options));
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
          const summary = listTaskSummaries(loadState(options.root), {
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
            const payload = taskGatePayload(options.root, taskId);
            return sendJson(res, payload.ok ? 200 : 409, payload);
          }
          const artifactMatch = /^(.+)\/artifact\/(intent|design|workplan)$/.exec(id);
          if (artifactMatch) {
            const taskId = artifactMatch[1] ?? "";
            const payload = artifactPayload(options.root, taskId, artifactMatch[2] ?? "");
            return sendJson(res, payload.ok ? 200 : 404, payload);
          }
          const task = loadTask(options.root, id);
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
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          if (!tokenMatches(options.token ?? "", suppliedToken(req, fields))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const requirement = fields["requirement"] ?? "";
          if (!requirement.trim()) return sendJson(res, 400, { ok: false, error: "requirement is required" });
          if (Buffer.byteLength(requirement) > 8192) return sendJson(res, 400, { ok: false, error: "requirement exceeds 8192 bytes" });
          let created: { taskId: string; title: string };
          try { created = await intakeTask(options.root, requirement); }
          catch (error) { return sendJson(res, 409, { ok: false, error: childError(error) }); }
          return sendJson(res, 201, { ok: true, ...created, daemon: ensureDaemon(options.root) });
        }
        if (method === "POST" && path === "/api/loop/resume") {
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          if (!tokenMatches(options.token ?? "", suppliedToken(req, fields))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const taskId = fields["taskId"] ?? "";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          const task = loadTask(options.root, taskId);
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
          if (task.handoff) return sendJson(res, 409, { ok: false, error: "Task is handed off; follow its handoff actions (state.mjs task next) instead of resuming" });
          if (task.status === "blocked_on_user") return sendJson(res, 409, { ok: false, error: "Task is waiting at a human gate; approve it on the task detail page" });
          if (task.status !== "paused") return sendJson(res, 409, { ok: false, error: `Only a paused task can be resumed (status: ${task.status})` });
          try {
            return sendJson(res, 200, { ok: true, result: await activateTask(options.root, taskId), daemon: daemonStatus(options.root) });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: childError(error) });
          }
        }
        if (method === "POST" && path === "/api/gate/approve") {
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          if (!tokenMatches(options.token ?? "", suppliedToken(req, fields))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const taskId = fields["taskId"] ?? "";
          const source = fields["source"] ?? "";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          if (!source.trim()) return sendJson(res, 400, { ok: false, error: "source (approval note) is required" });
          const task = loadTask(options.root, taskId);
          if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
          if (task.status !== "blocked_on_user" || task.gate === "none") return sendJson(res, 409, { ok: false, error: "Task is not waiting at a human gate" });
          try {
            return sendJson(res, 200, { ok: true, result: await approveGate(options.root, taskId, task.gate, source) });
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
    const server = createServer(createUiHandler({ ...options, token }));
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolveServer({ server, port, token });
    });
  });
