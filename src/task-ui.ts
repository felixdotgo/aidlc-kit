/**
 * Local web UI for the AI-DLC loop and task status.
 *
 * Read-only over canonical local state (`.agents/data/state/aidlc-state.json`).
 * Loop start/resume are thin facades that spawn the installed `loop-entry.mjs`
 * exactly as `aidlc-kit loop` does; gate approval is a thin facade that spawns
 * the same atomic `state.mjs gate approve` command. This module never mutates
 * lifecycle state itself and never bypasses the fail-closed gate channel.
 *
 * Built on `node:http` only; Bulma CSS is vendored as a static asset (no CDN,
 * no runtime npm dependency). Mutating actions (loop start/resume, gate
 * approve) require a per-session token generated at server start and printed
 * once to the terminal.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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
const eventsLogPath = (root: string): string => join(root, ".agents", "data", "loop", "ui-events.jsonl");
const loopArgs = (root: string, action: string, taskId = ""): string[] => [loopEntryPath(root), action, taskId, root, "", "", "", ""];

const ARTIFACT_NAMES = ["intent", "design", "workplan"] as const;
const PHASES = ["clarify", "plan", "build", "wrap", "done"] as const;

const bulmaCssPath = fileURLToPath(new URL("../assets/ui/bulma.min.css", import.meta.url));
let bulmaCssCache: string | undefined;
const bulmaCss = (): string => {
  if (bulmaCssCache !== undefined) return bulmaCssCache;
  try { bulmaCssCache = readFileSync(bulmaCssPath, "utf8"); }
  catch { bulmaCssCache = ""; }
  return bulmaCssCache;
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
      if (size > 8192) { reject(new Error("Request body exceeds 8192 bytes")); req.destroy(); return; }
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

const readFields = (body: string, contentType: string | undefined): Record<string, string> => {
  if (isJson(contentType)) {
    const value = JSON.parse(body) as Record<string, unknown>;
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

const loopStatusJson = (root: string, taskId: string): unknown => {
  const output = execFileSync(process.execPath, loopArgs(root, "status", taskId), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as unknown;
};

const spawnLoop = (root: string, action: "start" | "resume", taskId: string, requirement?: string): number => {
  const child = spawn(process.execPath, loopArgs(root, action, taskId), {
    cwd: root,
    detached: true,
    stdio: requirement !== undefined ? ["pipe", "ignore", "ignore"] : ["ignore", "ignore", "ignore"],
    env: { ...process.env, AIDLC_LOOP_EVENT_LOG: eventsLogPath(root) },
  });
  if (requirement !== undefined && child.stdin) { child.stdin.write(requirement); child.stdin.end(); }
  child.unref();
  return child.pid ?? 0;
};

const approveGate = (root: string, taskId: string, gate: string, source: string): unknown => {
  const output = execFileSync(process.execPath, [stateScriptPath(root), "gate", "approve", taskId, "--gate", gate, "--source", source, "--root", root], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output) as unknown;
};

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
<link rel="stylesheet" href="/assets/bulma.css">
<style>
.log-panel { background: #1a1a1a; color: #e0e0e0; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.8rem; padding: 0.75rem; border-radius: 0.25rem; height: 24rem; overflow: auto; white-space: pre-wrap; }
.kanban-column { min-height: 12rem; }
.artifact { max-height: 32rem; overflow: auto; }
.artifact table { font-size: 0.85rem; }
.artifact pre { background: #f5f5f5; padding: 0.75rem; border-radius: 0.25rem; overflow: auto; }
.modal-card { max-width: 60rem; width: auto; }
</style>
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

const summarize = (counts: Record<string, number> | undefined): string => Object.entries(counts ?? {}).map(([k, n]) => `${n} ${k}`).join(" · ") || "none";

const renderGateViewHtml = (view: unknown): string => {
  const v = view as GateViewData;
  const task = v.task ?? {};
  const artifacts = v.artifacts ?? [];
  const evidence = v.evidence ?? [];
  const diagnostics = v.diagnostics ?? [];
  const levelClass = (level?: string): string => level === "ERROR" ? "is-danger" : level === "WARN" ? "is-warning" : "is-info";
  return `<div class="box">
    <h3 class="subtitle">${escapeHtml(String(v.icon ?? ""))} ${escapeHtml(String(v.title ?? ""))}</h3>
    <p><strong>Gate:</strong> <span class="tag is-info">${escapeHtml(String(v.gate ?? ""))}</span></p>
    <p><strong>Task:</strong> <code>${escapeHtml(task.id ?? "")}</code> — ${escapeHtml(task.title ?? "")}</p>
    <p><strong>Status:</strong> <span class="tag">${escapeHtml(task.status ?? "")}</span> <strong>Risk:</strong> <span class="tag">${escapeHtml(task.risk ?? "")}</span> <strong>Areas:</strong> ${escapeHtml((task.areas ?? []).join(", "))}</p>
    <h4 class="is-size-6 mt-3">Review artifacts</h4>
    ${artifacts.length ? `<ul>${artifacts.map((a) => `<li><code>${escapeHtml(a.name ?? "")}</code> → <code>${escapeHtml(a.path ?? "")}</code></li>`).join("")}</ul>` : "<p><em>none</em></p>"}
    <p><strong>Decisions:</strong> ${escapeHtml(summarize(v.decisions))}</p>
    <p><strong>Execution:</strong> ${escapeHtml(summarize(v.execution))}</p>
    <h4 class="is-size-6 mt-3">Verification evidence</h4>
    ${evidence.length ? `<table class="table is-fullwidth is-striped"><thead><tr><th>kind</th><th>result</th><th>source</th></tr></thead><tbody>${evidence.map((e) => `<tr><td>${escapeHtml(e.kind ?? "")}</td><td>${escapeHtml(e.result ?? "")}</td><td>${escapeHtml(e.source ?? "")}</td></tr>`).join("")}</tbody></table>` : "<p><em>none yet</em></p>"}
    ${diagnostics.length ? `<h4 class="is-size-6 mt-3">Diagnostics</h4><ul>${diagnostics.map((d) => `<li><span class="tag ${levelClass(d.level)}">${escapeHtml(d.level ?? "")}</span> <code>${escapeHtml(d.code ?? "")}</code> ${escapeHtml(d.message ?? "")}</li>`).join("")}</ul>` : ""}
    <p class="has-text-weight-semibold mt-3">Action required: ${escapeHtml(String(v.action ?? ""))}</p>
  </div>`;
};

const jsonToHtml = (value: unknown): string => {
  if (value === null || value === undefined) return '<span class="has-text-grey">null</span>';
  if (typeof value === "boolean" || typeof value === "number") return escapeHtml(String(value));
  if (typeof value === "string") return escapeHtml(value);
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="has-text-grey">[]</span>';
    return `<ul class="ml-4">${value.map((item) => `<li>${jsonToHtml(item)}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '<span class="has-text-grey">{}</span>';
    return `<table class="table is-narrow is-fullwidth is-striped"><tbody>${entries.map(([k, v]) => `<tr><td class="has-text-weight-semibold" style="width:16rem">${escapeHtml(k)}</td><td>${jsonToHtml(v)}</td></tr>`).join("")}</tbody></table>`;
  }
  return escapeHtml(String(value));
};

/* ---------------------------------------------------------------------------
 * Client script shared across dashboard and detail page.
 * ------------------------------------------------------------------------- */

const sharedScript = `<script>
const storedToken = () => (localStorage.getItem("aidlc-token") || "");
const setStoredToken = (value) => localStorage.setItem("aidlc-token", value);
const post = async (url, body) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": storedToken() }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const openModal = (id) => { const el = document.getElementById(id); if (el) el.classList.add("is-active"); };
const closeModal = (id) => { const el = document.getElementById(id); if (el) el.classList.remove("is-active"); };
const closeAllModals = () => document.querySelectorAll(".modal").forEach((m) => m.classList.remove("is-active"));
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
document.addEventListener("DOMContentLoaded", () => {
  const tokenInput = document.getElementById("settings-token-input");
  if (tokenInput) tokenInput.value = storedToken();
  document.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openModal(el.getAttribute("data-open"))));
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", () => closeAllModals()));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeAllModals(); });
  const saveBtn = document.getElementById("settings-token-save");
  if (saveBtn) saveBtn.addEventListener("click", () => { if (tokenInput) setStoredToken(tokenInput.value); closeModal("settings-modal"); });
  const clearBtn = document.getElementById("settings-token-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => { setStoredToken(""); if (tokenInput) tokenInput.value = ""; });
  const startBtn = document.getElementById("new-task-submit");
  if (startBtn) startBtn.addEventListener("click", async () => {
    const result = document.getElementById("new-task-result");
    const requirement = document.getElementById("new-task-requirement").value;
    if (result) result.textContent = "";
    const res = await post("/api/loop/start", { requirement });
    if (result) result.textContent = JSON.stringify(res.body, null, 2);
    if (res.status >= 200 && res.status < 300) setTimeout(() => location.reload(), 1500);
  });
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
    document.querySelectorAll("[data-view-toggle]").forEach((el) => el.classList.toggle("is-active", el.getAttribute("data-view-toggle") === view));
  };
  document.querySelectorAll("[data-view-toggle]").forEach((el) => el.addEventListener("click", () => { const v = el.getAttribute("data-view-toggle"); localStorage.setItem(viewKey, v); applyView(v); }));
  applyView(localStorage.getItem(viewKey) || "kanban");
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-resume]");
  if (!button) return;
  event.preventDefault();
  post("/api/loop/resume", { taskId: button.getAttribute("data-resume") }).then((res) => { window.alert(JSON.stringify(res.body, null, 2)); location.reload(); });
});
</script>`;

/* ---------------------------------------------------------------------------
 * Dashboard: kanban (default) + list toggle, modals for settings/new task/detail.
 * ------------------------------------------------------------------------- */

const riskClass = (risk: string): string => risk === "high" || risk === "regulated" ? "is-danger" : risk === "normal" ? "is-warning" : "is-success";

const renderTaskCard = (task: { id: string; title: string; phase: string; gate: string; status: string; risk: string; areas: string[] }): string => {
  const resume = task.status === "blocked_on_user" || task.status === "paused"
    ? `<button class="button is-small is-light" data-resume="${escapeHtml(task.id)}">resume</button>`
    : "";
  return `<div class="box mb-2">
    <p class="is-size-7 has-text-grey"><a href="/tasks/${encodeURIComponent(task.id)}" data-task-link="${escapeHtml(task.id)}"><code>${escapeHtml(task.id)}</code></a></p>
    <p class="has-text-weight-semibold">${escapeHtml(task.title)}</p>
    <div class="tags are-small mt-1">
      <span class="tag is-light">${escapeHtml(task.status)}</span>
      <span class="tag is-light">${escapeHtml(task.gate)}</span>
      <span class="tag ${riskClass(task.risk)}">${escapeHtml(task.risk)}</span>
    </div>
    <p class="is-size-7 has-text-grey">${escapeHtml(task.areas.join(", "))}</p>
    <div class="mt-2">${resume}</div>
  </div>`;
};

const renderModals = (): string => `
<div id="settings-modal" class="modal">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title">Settings</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <div class="field">
        <label class="label" for="settings-token-input">Approve token</label>
        <div class="control"><input id="settings-token-input" class="input" type="password" placeholder="session token"></div>
        <p class="help">Paste the token printed in the terminal that started this server. Required for loop actions and gate approve.</p>
      </div>
    </section>
    <footer class="modal-card-foot">
      <button id="settings-token-save" class="button is-primary">save</button>
      <button id="settings-token-clear" class="button is-light">clear</button>
      <button class="button" data-close>cancel</button>
    </footer>
  </div>
</div>
<div id="new-task-modal" class="modal">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title">Start a new task</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body">
      <div class="field">
        <label class="label" for="new-task-requirement">Requirement</label>
        <div class="control"><textarea id="new-task-requirement" class="textarea" rows="4" placeholder="Requirement (max 8192 bytes)"></textarea></div>
      </div>
      <pre id="new-task-result" class="mt-3"></pre>
    </section>
    <footer class="modal-card-foot">
      <button id="new-task-submit" class="button is-primary">start loop</button>
      <button class="button" data-close>cancel</button>
    </footer>
  </div>
</div>
<div id="task-modal" class="modal">
  <div class="modal-background" data-close></div>
  <div class="modal-card">
    <header class="modal-card-head">
      <p class="modal-card-title">Task</p>
      <button class="delete" aria-label="close" data-close></button>
    </header>
    <section class="modal-card-body" id="task-modal-body"><p class="has-text-grey">Loading…</p></section>
    <footer class="modal-card-foot">
      <a id="task-modal-open" class="button is-small" href="#" target="_blank" rel="noopener">open in page</a>
      <button class="button is-small" data-close>close</button>
    </footer>
  </div>
</div>`;

const renderDashboard = (options: UiOptions): string => {
  const { items } = listTaskSummaries(loadState(options.root));

  const kanban = PHASES.map((phase) => {
    const cards = items.filter((task) => task.phase === phase).map(renderTaskCard).join("\n");
    return `<div class="column kanban-column">
      <h3 class="subtitle is-6 has-text-centered">${escapeHtml(phase)} <span class="tag is-light">${items.filter((t) => t.phase === phase).length}</span></h3>
      ${cards || "<p class=\"has-text-grey is-size-7 has-text-centered\">none</p>"}
    </div>`;
  }).join("\n");

  const rows = items.length
    ? items.map((task) => {
      const resume = task.status === "blocked_on_user" || task.status === "paused"
        ? `<button class="button is-small" data-resume="${escapeHtml(task.id)}">resume</button>`
        : "";
      return `<tr><td><a href="/tasks/${encodeURIComponent(task.id)}" data-task-link="${escapeHtml(task.id)}"><code>${escapeHtml(task.id)}</code></a></td><td>${escapeHtml(task.title)}</td><td>${escapeHtml(task.phase)}</td><td>${escapeHtml(task.gate)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.risk)}</td><td>${escapeHtml(task.areas.join(", "))}</td><td>${resume}</td></tr>`;
    }).join("\n")
    : "<tr><td colspan=\"8\"><em>No active tasks</em></td></tr>";

  return `${pageHead("AI-DLC Loop")}
<section class="section">
  <div class="container">
    <nav class="level">
      <div class="level-left"><h1 class="title is-3">AI-DLC Loop</h1></div>
      <div class="level-right">
        <div class="buttons">
          <button class="button is-primary" data-open="new-task-modal">New task</button>
          <button class="button" data-open="settings-modal" title="Settings">⚙ Settings</button>
        </div>
      </div>
    </nav>
    <div class="level">
      <div class="level-left">
        <div class="buttons has-addons">
          <button class="button is-small" data-view-toggle="kanban">Kanban</button>
          <button class="button is-small" data-view-toggle="list">List</button>
        </div>
      </div>
    </div>
    <div id="kanban-view"><div class="columns">${kanban}</div></div>
    <div id="list-view" style="display:none">
      <table class="table is-fullwidth is-striped is-hoverable">
        <thead><tr><th>id</th><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="help">Click a task to open a quick detail modal; ctrl/cmd-click or middle-click opens the full detail page. Gate approval stays available on the detail page and on the trusted terminal (<code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>).</p>
  </div>
</section>
${renderModals()}
${sharedScript}
</body>
</html>`;
};

/* ---------------------------------------------------------------------------
 * Task detail (page and modal fragment share the same body).
 * ------------------------------------------------------------------------- */

const renderTaskDetail = (options: UiOptions, id: string, fragment = false): string => {
  const state = loadState(options.root);
  const task = loadTask(options.root, id, state);
  if (!task) {
    const body = `<p class="has-text-danger">Task not found: ${escapeHtml(id)}</p>`;
    return fragment ? body : `${pageHead("Task not found")}<section class="section"><div class="container"><h1 class="title">Task not found</h1><p><a href="/">← back</a></p></div></section></body></html>`;
  }

  const gate = task.status === "blocked_on_user" && task.gate !== "none"
    ? taskGatePayload(options.root, id)
    : undefined;

  const gateBlock = gate && gate.ok && gate.view
    ? renderGateViewHtml(gate.view)
    : "";

  const approveBlock = !fragment && task.status === "blocked_on_user" && task.gate !== "none"
    ? `<div class="box">
        <h3 class="subtitle">Approve ${escapeHtml(task.gate)}</h3>
        <div class="field"><div class="control"><input id="source" class="input" placeholder="approval note / source (required)"></div></div>
        <div class="control"><button id="approve-button" class="button is-success">approve</button></div>
        <pre id="approve-result" class="mt-3"></pre>
      </div>`
    : "";

  const artifacts = ARTIFACT_NAMES.map((name) => {
    const artifactPath = task.artifacts?.[name];
    if (!artifactPath) return "";
    const payload = artifactPayload(options.root, id, name);
    const content = payload.ok && payload.content !== undefined
      ? `<div class="content artifact">${markdownToHtml(payload.content)}</div>`
      : `<p class="help is-danger">${escapeHtml(payload.error ?? "unavailable")}</p>`;
    return `<details class="box mb-2"><summary>${escapeHtml(name)} <span class="tag is-light is-small">${escapeHtml(artifactPath)}</span></summary>${content}</details>`;
  }).join("\n");

  let loopStatus: string;
  try {
    loopStatus = `<div class="box"><h3 class="subtitle">Loop status</h3>${jsonToHtml(loopStatusJson(options.root, id))}</div>`;
  } catch (error) {
    loopStatus = `<div class="box"><h3 class="subtitle">Loop status</h3><p class="help is-danger">Loop status unavailable: ${escapeHtml(childError(error))}</p></div>`;
  }

  const decisions = task.decisions.length
    ? task.decisions.map((decision) => `<tr><td><code>${escapeHtml(decision.id)}</code></td><td>${escapeHtml(decision.status)}</td><td>${escapeHtml(decision.resolution ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"3\"><em>none</em></td></tr>";

  const workItems = task.tasks.length
    ? task.tasks.map((item) => `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.label ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"3\"><em>none</em></td></tr>";

  const evidence = task.evidence.length
    ? task.evidence.map((entry) => `<tr><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.result)}</td><td>${escapeHtml(entry.gate ?? "")}</td><td>${escapeHtml(entry.source ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"4\"><em>none</em></td></tr>";

  const body = `<h1 class="title">${escapeHtml(task.title)}</h1>
<p class="subtitle"><code>${escapeHtml(task.id)}</code> · ${escapeHtml(task.phase)} · ${escapeHtml(task.gate)} · ${escapeHtml(task.status)} · ${escapeHtml(task.risk)}</p>
<p>Areas: ${escapeHtml(task.areas.join(", "))}</p>
${gateBlock}
${approveBlock}
<h2 class="subtitle">Artifacts</h2>
${artifacts || "<p><em>No artifacts recorded</em></p>"}
${loopStatus}
<h2 class="subtitle">Decisions</h2>
<table class="table is-fullwidth is-striped"><thead><tr><th>id</th><th>status</th><th>resolution</th></tr></thead><tbody>${decisions}</tbody></table>
<h2 class="subtitle">Work items</h2>
<table class="table is-fullwidth is-striped"><thead><tr><th>id</th><th>status</th><th>label</th></tr></thead><tbody>${workItems}</tbody></table>
<h2 class="subtitle">Evidence</h2>
<table class="table is-fullwidth is-striped"><thead><tr><th>kind</th><th>result</th><th>gate</th><th>source</th></tr></thead><tbody>${evidence}</tbody></table>`;

  if (fragment) return body;

  const liveLog = `<h2 class="subtitle">Live log</h2><div id="log" class="log-panel">connecting…</div>`;
  const detailScript = `<script>
const post = async (url, body) => {
  const token = localStorage.getItem("aidlc-token") || "";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": token }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
document.getElementById("approve-button")?.addEventListener("click", async () => {
  const result = document.getElementById("approve-result");
  result.textContent = "";
  const res = await post("/api/gate/approve", { taskId: ${JSON.stringify(id)}, gate: ${JSON.stringify(task.gate)}, source: document.getElementById("source").value });
  result.textContent = JSON.stringify(res.body, null, 2);
  if (res.status >= 200 && res.status < 300) setTimeout(() => location.reload(), 1500);
});
const logEl = document.getElementById("log");
const events = new EventSource("/api/events");
events.onmessage = (message) => {
  if (logEl.textContent === "connecting…") logEl.textContent = "";
  logEl.textContent += message.data + "\\n";
  logEl.scrollTop = logEl.scrollHeight;
};
events.onerror = () => { if (logEl.textContent === "connecting…") logEl.textContent = "log stream unavailable (loop not running or sidecar missing)"; };
</script>`;

  return `${pageHead(`Task ${id}`)}
<section class="section">
  <div class="container">
    <nav class="level">
      <div class="level-left"><p><a href="/">← back to dashboard</a></p></div>
      <div class="level-right"><button class="button is-small" data-open="settings-modal" title="Settings">⚙ Settings</button></div>
    </nav>
    ${body}
    ${liveLog}
  </div>
</section>
${renderModals()}
${sharedScript}
${detailScript}
</body>
</html>`;
};

const streamEvents = (options: UiOptions, res: ServerResponse, req: IncomingMessage): void => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
  const path = eventsLogPath(options.root);
  const lastEventId = Number.parseInt(String(req.headers["last-event-id"] ?? "0"), 10);
  let cursor = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;
  const emit = (): void => {
    try {
      const content = existsSync(path) ? readFileSync(path, "utf8") : "";
      const lines = content.split("\n").filter((line) => line.length > 0);
      while (cursor < lines.length) {
        const line = lines[cursor] ?? "";
        cursor += 1;
        res.write(`id: ${cursor}\ndata: ${line}\n\n`);
      }
    } catch { /* transient read errors are ignored until the next poll */ }
  };
  emit();
  const timer = setInterval(emit, 500);
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

    if (method === "GET" && path === "/api/events") return streamEvents(options, res, req);

    void (async () => {
      try {
        if (method === "GET" && path === "/assets/bulma.css") return sendCss(res, bulmaCss());
        if (method === "GET" && path === "/") return sendHtml(res, renderDashboard(options));
        if (method === "GET" && path.startsWith("/partial/tasks/")) {
          const id = decodeURIComponent(path.slice("/partial/tasks/".length));
          if (!id) return sendJson(res, 404, { ok: false, error: "Not found" });
          return sendHtml(res, renderTaskDetail(options, id, true));
        }
        if (method === "GET" && path.startsWith("/tasks/")) {
          const id = decodeURIComponent(path.slice("/tasks/".length));
          if (!id) return sendJson(res, 404, { ok: false, error: "Not found" });
          return sendHtml(res, renderTaskDetail(options, id));
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
          return sendJson(res, 200, { ok: true, result: loopStatusJson(options.root, taskId) });
        }
        if (method === "POST" && path === "/api/loop/start") {
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          if (!tokenMatches(options.token ?? "", suppliedToken(req, fields))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const requirement = fields["requirement"] ?? "";
          if (!requirement.trim()) return sendJson(res, 400, { ok: false, error: "requirement is required" });
          const pid = spawnLoop(options.root, "start", "", requirement);
          return sendJson(res, 202, { ok: true, pid });
        }
        if (method === "POST" && path === "/api/loop/resume") {
          const body = await readBody(req);
          const fields = readFields(body, req.headers["content-type"]);
          if (!tokenMatches(options.token ?? "", suppliedToken(req, fields))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          const taskId = fields["taskId"] ?? "";
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          const pid = spawnLoop(options.root, "resume", taskId);
          return sendJson(res, 202, { ok: true, pid });
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
            return sendJson(res, 200, { ok: true, result: approveGate(options.root, taskId, task.gate, source) });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: childError(error) });
          }
        }
        return sendJson(res, 404, { ok: false, error: `Not found: ${method} ${path}` });
      } catch (error) {
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
