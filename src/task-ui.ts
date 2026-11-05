/**
 * Minimal local web UI for the AI-DLC loop and task status.
 *
 * Read-only over canonical local state (`.agents/data/state/aidlc-state.json`).
 * Loop start/resume are thin facades that spawn the installed `loop-entry.mjs`
 * exactly as `aidlc-kit loop` does — this module never mutates lifecycle state,
 * never approves a gate, and never bypasses the fail-closed gate channel.
 *
 * Built on `node:http` only; no new runtime dependencies.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { join } from "node:path";
import { listTaskSummaries, loadState, loadTask } from "./state.js";

export interface UiOptions {
  root: string;
  host: string;
  port: number;
}

const loopEntryPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs");
const loopArgs = (root: string, action: string, taskId = ""): string[] => [loopEntryPath(root), action, taskId, root, "", "", ""];

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const sendHtml = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
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

const readRequirement = (body: string, contentType: string | undefined): string => {
  if (isJson(contentType)) {
    const value = (JSON.parse(body) as Record<string, unknown>)["requirement"];
    return typeof value === "string" ? value : "";
  }
  return parseForm(body)["requirement"] ?? "";
};

const readTaskId = (body: string, contentType: string | undefined): string => {
  if (isJson(contentType)) {
    const value = (JSON.parse(body) as Record<string, unknown>)["taskId"];
    return typeof value === "string" ? value : "";
  }
  return parseForm(body)["taskId"] ?? "";
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
  });
  if (requirement !== undefined && child.stdin) { child.stdin.write(requirement); child.stdin.end(); }
  child.unref();
  return child.pid ?? 0;
};

const renderDashboard = (options: UiOptions): string => {
  const { items } = listTaskSummaries(loadState(options.root));
  const rows = items.length
    ? items.map((task) => {
      const controls = task.status === "blocked_on_user" || task.status === "paused"
        ? `<form method="POST" action="/api/loop/resume" style="display:inline"><input type="hidden" name="taskId" value="${escapeHtml(task.id)}"><button type="submit">resume</button></form>`
        : "";
      return `<tr><td><code>${escapeHtml(task.id)}</code></td><td>${escapeHtml(task.title)}</td><td>${escapeHtml(task.phase)}</td><td>${escapeHtml(task.gate)}</td><td>${escapeHtml(task.status)}</td><td>${escapeHtml(task.risk)}</td><td>${escapeHtml(task.areas.join(", "))}</td><td><a href="/api/loop/status?task-id=${encodeURIComponent(task.id)}">status</a> ${controls}</td></tr>`;
    }).join("\n")
    : "<tr><td colspan=\"8\"><em>No active tasks</em></td></tr>";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI-DLC Loop</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { border: 1px solid #ccc; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f4f4f4; }
code { font-size: 0.85em; }
button { cursor: pointer; }
</style>
</head>
<body>
<h1>AI-DLC Loop</h1>
<h2>Start a new task</h2>
<form method="POST" action="/api/loop/start">
  <textarea name="requirement" rows="3" cols="60" placeholder="Requirement (max 8192 bytes)" required></textarea><br>
  <button type="submit">start loop</button>
</form>
<h2>Tasks</h2>
<table>
<thead><tr><th>id</th><th>title</th><th>phase</th><th>gate</th><th>status</th><th>risk</th><th>areas</th><th>actions</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p><small>Gate approval remains on the trusted terminal (<code>node .agents/aidlc/scripts/loop-gate.mjs &lt;task-id&gt;</code>).</small></p>
</body>
</html>`;
};

/** Builds the request handler for the UI server (exported for unit tests). */
export const createUiHandler = (options: UiOptions): (req: IncomingMessage, res: ServerResponse) => void => {
  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host || "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;
    void (async () => {
      try {
        if (method === "GET" && path === "/") return sendHtml(res, renderDashboard(options));
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
          const requirement = readRequirement(body, req.headers["content-type"]);
          if (!requirement.trim()) return sendJson(res, 400, { ok: false, error: "requirement is required" });
          const pid = spawnLoop(options.root, "start", "", requirement);
          return sendJson(res, 202, { ok: true, pid });
        }
        if (method === "POST" && path === "/api/loop/resume") {
          const body = await readBody(req);
          const taskId = readTaskId(body, req.headers["content-type"]);
          if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
          const pid = spawnLoop(options.root, "resume", taskId);
          return sendJson(res, 202, { ok: true, pid });
        }
        return sendJson(res, 404, { ok: false, error: `Not found: ${method} ${path}` });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  };
};

/** Starts the UI HTTP server and resolves once it is listening. */
export const startUiServer = (options: UiOptions): Promise<{ server: Server; port: number }> =>
  new Promise((resolveServer, reject) => {
    const server = createServer(createUiHandler(options));
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolveServer({ server, port });
    });
  });
