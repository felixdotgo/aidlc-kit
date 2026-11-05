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
.gate-view { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85rem; }
</style>
</head>
<body>`;

const tokenScript = `<script>
const storedToken = () => (localStorage.getItem("aidlc-token") || "");
const setStoredToken = (value) => { localStorage.setItem("aidlc-token", value); };
const syncToken = () => { const input = document.getElementById("token-input"); if (input) input.value = storedToken(); };
const saveToken = () => { const input = document.getElementById("token-input"); if (input) setStoredToken(input.value); };
document.addEventListener("DOMContentLoaded", syncToken);
</script>`;

const renderDashboard = (options: UiOptions): string => {
  const { items } = listTaskSummaries(loadState(options.root));
  const rows = items.length
    ? items.map((task) => {
      const resume = task.status === "blocked_on_user" || task.status === "paused"
        ? `<button class="button is-small" data-resume="${escapeHtml(task.id)}">resume</button>`
        : "";
      return `<tr><td><a href="/tasks/${encodeURIComponent(task.id)}"><code>${escapeHtml(task.id)}</code></a></td><td>${escapeHtml(task.title)}</td><td>${escapeHtml(task.phase)}</td><td>${escapeHtml(task.gate)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.risk)}</td><td>${escapeHtml(task.areas.join(", "))}</td><td><a class="button is-small" href="/api/loop/status?task-id=${encodeURIComponent(task.id)}">status</a> ${resume}</td></tr>`;
    }).join("\n")
    : "<tr><td colspan=\"8\"><em>No active tasks</em></td></tr>";

  return `${pageHead("AI-DLC Loop")}
${tokenScript}
<section class="section">
  <div class="container">
    <h1 class="title">AI-DLC Loop</h1>
    <div class="box">
      <h2 class="subtitle">Approve token</h2>
      <div class="field has-addons">
        <div class="control is-expanded"><input id="token-input" class="input" type="password" placeholder="session token (required for loop actions and approve)" oninput="saveToken()"></div>
      </div>
      <p class="help">Paste the token printed in the terminal that started this server.</p>
    </div>
    <div class="box">
      <h2 class="subtitle">Start a new task</h2>
      <div class="field"><div class="control"><textarea id="requirement" class="textarea" rows="3" placeholder="Requirement (max 8192 bytes)"></textarea></div></div>
      <div class="control"><button id="start-button" class="button is-primary">start loop</button></div>
      <pre id="start-result" class="mt-3"></pre>
    </div>
    <h2 class="subtitle">Tasks</h2>
    <table class="table is-fullwidth is-striped is-hoverable">
      <thead><tr><th>id</th><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="help">Gate approval is available from the task detail page and stays available on the trusted terminal (<code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>).</p>
  </div>
</section>
<script>
const post = async (url, body) => {
  const token = storedToken();
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-aidlc-token": token }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
document.getElementById("start-button").addEventListener("click", async () => {
  const result = document.getElementById("start-result");
  result.textContent = "";
  const res = await post("/api/loop/start", { requirement: document.getElementById("requirement").value });
  result.textContent = JSON.stringify(res.body, null, 2);
  if (res.status >= 200 && res.status < 300) setTimeout(() => location.reload(), 1500);
});
document.querySelectorAll("[data-resume]").forEach((button) => {
  button.addEventListener("click", async () => {
    const res = await post("/api/loop/resume", { taskId: button.getAttribute("data-resume") });
    window.alert(JSON.stringify(res.body, null, 2));
    location.reload();
  });
});
</script>
</body>
</html>`;
};

const renderTaskDetail = (options: UiOptions, id: string): string => {
  const state = loadState(options.root);
  const task = loadTask(options.root, id, state);
  if (!task) return `${pageHead("Task not found")}<section class="section"><div class="container"><h1 class="title">Task not found</h1><p><a href="/">← back</a></p></div></section></body></html>`;

  const gate = task.status === "blocked_on_user" && task.gate !== "none"
    ? taskGatePayload(options.root, id)
    : undefined;

  const artifactLinks = ARTIFACT_NAMES.map((name) => task.artifacts?.[name]
    ? `<a class="button is-small" href="/api/tasks/${encodeURIComponent(id)}/artifact/${name}">${name}</a>`
    : "").join(" ");

  const decisions = task.decisions.length
    ? task.decisions.map((decision) => `<tr><td><code>${escapeHtml(decision.id)}</code></td><td>${escapeHtml(decision.status)}</td><td>${escapeHtml(decision.resolution ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"3\"><em>none</em></td></tr>";

  const workItems = task.tasks.length
    ? task.tasks.map((item) => `<tr><td><code>${escapeHtml(item.id)}</code></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.label ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"3\"><em>none</em></td></tr>";

  const evidence = task.evidence.length
    ? task.evidence.map((entry) => `<tr><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.result)}</td><td>${escapeHtml(entry.gate ?? "")}</td><td>${escapeHtml(entry.source ?? "")}</td></tr>`).join("\n")
    : "<tr><td colspan=\"4\"><em>none</em></td></tr>";

  const gateBlock = gate && gate.ok && gate.view
    ? `<div class="box">
        <h3 class="subtitle">${escapeHtml(String((gate.view as { title?: string }).title ?? ""))}</h3>
        <pre class="gate-view">${escapeHtml(JSON.stringify(gate.view, null, 2))}</pre>
      </div>`
    : "";

  const approveBlock = task.status === "blocked_on_user" && task.gate !== "none"
    ? `<div class="box">
        <h3 class="subtitle">Approve ${escapeHtml(task.gate)}</h3>
        <div class="field"><div class="control"><input id="source" class="input" placeholder="approval note / source (required)"></div></div>
        <div class="control"><button id="approve-button" class="button is-success">approve</button></div>
        <pre id="approve-result" class="mt-3"></pre>
      </div>`
    : "";

  return `${pageHead(`Task ${id}`)}
${tokenScript}
<section class="section">
  <div class="container">
    <p><a href="/">← back to dashboard</a></p>
    <h1 class="title">${escapeHtml(task.title)}</h1>
    <p class="subtitle"><code>${escapeHtml(task.id)}</code> · ${escapeHtml(task.phase)} · ${escapeHtml(task.gate)} · ${escapeHtml(task.status)} · ${escapeHtml(task.risk)}</p>
    <p>Areas: ${escapeHtml(task.areas.join(", "))}</p>
    <p>Artifacts: ${artifactLinks}</p>
    ${gateBlock}
    ${approveBlock}
    <h2 class="subtitle">Decisions</h2>
    <table class="table is-fullwidth is-striped"><thead><tr><th>id</th><th>status</th><th>resolution</th></tr></thead><tbody>${decisions}</tbody></table>
    <h2 class="subtitle">Work items</h2>
    <table class="table is-fullwidth is-striped"><thead><tr><th>id</th><th>status</th><th>label</th></tr></thead><tbody>${workItems}</tbody></table>
    <h2 class="subtitle">Evidence</h2>
    <table class="table is-fullwidth is-striped"><thead><tr><th>kind</th><th>result</th><th>gate</th><th>source</th></tr></thead><tbody>${evidence}</tbody></table>
    <h2 class="subtitle">Live log</h2>
    <div id="log" class="log-panel">connecting…</div>
  </div>
</section>
<script>
const post = async (url, body) => {
  const token = storedToken();
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
</script>
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
