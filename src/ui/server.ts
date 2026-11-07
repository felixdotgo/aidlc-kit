/**
 * Request routing and server start-up. Every request first passes the Host/Origin
 * guard; routes are then tried in table order (first match wins) and mutating
 * routes marked `token` require the session token before their handler runs.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { listTaskSummaries } from "../state.js";
import { staticAsset } from "./assets.js";
import { activateTask, approveGate, childError, daemonStatus, ensureDaemon, feedbackGate, intakeTask, loopStatusJson, runNode } from "./daemon.js";
import { taskChanges } from "./changes.js";
import { artifactPayload, readUiState, readUiTask, taskGatePayload } from "./data.js";
import { BadRequest, readBody, readFields, sendAsset, sendHtml, sendJson } from "./http.js";
import { livePayload } from "./live.js";
import { loopArgs, resolveUiMode, uiMode, type UiOptions } from "./options.js";
import { requestAllowed, suppliedToken, tokenMatches } from "./security.js";
import { streamEvents } from "./sse.js";
import { renderDashboard } from "./views/board.js";
import { renderChangesPage } from "./views/changes.js";
import { gateLabel } from "./views/components.js";
import { renderTaskDetail } from "./views/task.js";

/** Path parameters a route's matcher extracted (already URI-decoded). */
export type RouteParams = Record<string, string>;

export interface RouteContext {
  options: UiOptions;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: RouteParams;
}

export interface Route {
  method: "GET" | "POST";
  /** Params when the path matches, else undefined. May throw `URIError` (answered with 400). */
  match: (path: string) => RouteParams | undefined;
  /** Mutating routes: the session token must arrive in a header before the handler runs. */
  token?: boolean;
  handle: (ctx: RouteContext) => unknown;
}

/** Exact path. */
export const exact = (route: string) => (path: string): RouteParams | undefined => path === route ? {} : undefined;
/** `<prefix><rest>`: `rest` is URI-decoded into `params[name]` (may be empty or contain `/`). */
export const prefixed = (prefix: string, name = "id") => (path: string): RouteParams | undefined =>
  path.startsWith(prefix) ? { [name]: decodeURIComponent(path.slice(prefix.length)) } : undefined;

/** `<prefix><id><suffix>` with a single non-empty path segment as `params.id` (URI-decoded). */
export const taskSubpath = (prefix: string, suffix: string) => (path: string): RouteParams | undefined => {
  if (!path.startsWith(prefix) || !path.endsWith(suffix) || path.length <= prefix.length + suffix.length) return undefined;
  const raw = path.slice(prefix.length, path.length - suffix.length);
  return raw.includes("/") ? undefined : { id: decodeURIComponent(raw) };
};

/** The optional `?item=` selector (empty means the whole task). */
const itemParam = (url: URL): string | null => url.searchParams.get("item") || null;

/** A POST body's fields (JSON object or form-encoded, 8 KiB cap). */
const fieldsOf = async (req: IncomingMessage): Promise<Record<string, string>> => readFields(await readBody(req), req.headers["content-type"]);

const NOT_FOUND = { ok: false, error: "Not found" };

/** Routes in match order. Add a more specific route before a broader prefix it overlaps
 * (e.g. `/tasks/:id/<page>` before `/tasks/`, `/api/tasks/:id/<api>` before `/api/tasks/`). */
export const ROUTES: Route[] = [
  // SSE first: the stream writes its headers synchronously and stays open.
  { method: "GET", match: exact("/api/events"), handle: ({ options, res, req, url }) => streamEvents(options, res, req, url) },
  {
    method: "GET",
    match: (path) => (path.startsWith("/assets/") && staticAsset(path) ? {} : undefined),
    handle: ({ res, url }) => { const asset = staticAsset(url.pathname)!; sendAsset(res, asset.contentType, asset.body); },
  },
  { method: "GET", match: exact("/"), handle: async ({ options, res }) => sendHtml(res, await renderDashboard(options)) },
  { method: "GET", match: exact("/api/live"), handle: async ({ options, res, url }) => sendJson(res, 200, await livePayload(options, url)) },
  // Code changes: only a task id and an item id come from the request; SHAs come from records.
  {
    method: "GET",
    match: taskSubpath("/tasks/", "/changes"),
    handle: async ({ options, res, url, params }) => { const page = await renderChangesPage(options, params.id ?? "", itemParam(url)); sendHtml(res, page.html, page.status); },
  },
  {
    method: "GET",
    match: taskSubpath("/api/tasks/", "/changes"),
    handle: async ({ options, res, url, params }) => { const result = await taskChanges(options, params.id ?? "", itemParam(url)); sendJson(res, result.status, result.payload); },
  },
  {
    method: "GET",
    match: prefixed("/partial/tasks/"),
    handle: async ({ options, res, params }) => params.id ? sendHtml(res, await renderTaskDetail(options, params.id, true)) : sendJson(res, 404, NOT_FOUND),
  },
  {
    method: "GET",
    match: prefixed("/tasks/"),
    handle: async ({ options, res, params }) => params.id ? sendHtml(res, await renderTaskDetail(options, params.id)) : sendJson(res, 404, NOT_FOUND),
  },
  {
    method: "GET",
    match: exact("/api/tasks"),
    handle: async ({ options, res, url }) => {
      const query = url.searchParams;
      const summary = listTaskSummaries(await readUiState(options), {
        includeArchive: query.get("archive") === "1",
        statuses: query.get("statuses") ? query.get("statuses")!.split(",").filter(Boolean) : undefined,
        query: query.get("query") ?? undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        cursor: query.get("cursor") ? Number(query.get("cursor")) : undefined,
      });
      sendJson(res, 200, summary);
    },
  },
  {
    method: "GET",
    match: (path) => {
      if (!path.startsWith("/api/tasks/") || !path.endsWith("/gate")) return undefined;
      return { id: decodeURIComponent(path.slice("/api/tasks/".length)).slice(0, -"/gate".length) };
    },
    handle: async ({ options, res, params }) => {
      const payload = await taskGatePayload(options, params.id ?? "");
      sendJson(res, payload.ok ? 200 : 409, payload);
    },
  },
  {
    method: "GET",
    match: (path) => {
      const rest = prefixed("/api/tasks/")(path)?.id;
      const artifact = rest === undefined ? null : /^(.+)\/artifact\/(intent|design|workplan)$/.exec(rest);
      return artifact ? { id: artifact[1] ?? "", name: artifact[2] ?? "" } : undefined;
    },
    handle: async ({ options, res, params }) => {
      const taskId = params.id ?? "";
      const payload = artifactPayload(options.root, taskId, params.name ?? "", readUiTask(options, taskId, await readUiState(options)));
      sendJson(res, payload.ok ? 200 : 404, payload);
    },
  },
  {
    method: "GET",
    match: prefixed("/api/tasks/"),
    handle: async ({ options, res, params }) => {
      const id = params.id ?? "";
      const task = readUiTask(options, id, await readUiState(options));
      if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${id}` });
      sendJson(res, 200, { ok: true, task });
    },
  },
  {
    method: "GET",
    match: exact("/api/loop/status"),
    handle: async ({ options, res, url }) => {
      const taskId = url.searchParams.get("task-id") ?? "";
      if (!taskId) return sendJson(res, 400, { ok: false, error: "task-id query parameter is required" });
      try { sendJson(res, 200, { ok: true, result: await loopStatusJson(options.root, taskId) }); }
      catch (error) { sendJson(res, 502, { ok: false, error: childError(error) }); }
    },
  },
  {
    method: "POST",
    match: exact("/api/loop/start"),
    token: true,
    handle: async ({ options, req, res }) => {
      const fields = await fieldsOf(req);
      const requirement = fields["requirement"] ?? "";
      if (!requirement.trim()) return sendJson(res, 400, { ok: false, error: "requirement is required" });
      if (Buffer.byteLength(requirement) > 8192) return sendJson(res, 400, { ok: false, error: "requirement exceeds 8192 bytes" });
      let created: { taskId: string; title: string };
      try { created = await intakeTask(options.root, requirement); }
      catch (error) { return sendJson(res, 409, { ok: false, error: childError(error) }); }
      sendJson(res, 201, { ok: true, ...created, daemon: ensureDaemon(options.root) });
    },
  },
  {
    method: "POST",
    match: exact("/api/loop/resume"),
    token: true,
    handle: async ({ options, req, res }) => {
      const fields = await fieldsOf(req);
      const taskId = fields["taskId"] ?? "";
      if (!taskId.trim()) return sendJson(res, 400, { ok: false, error: "taskId is required" });
      const task = readUiTask(options, taskId, await readUiState(options));
      if (!task) return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
      if (task.handoff) return sendJson(res, 409, { ok: false, error: "Task is handed off; follow its handoff actions (state.mjs task next) instead of resuming" });
      if (task.status === "blocked_on_user") return sendJson(res, 409, { ok: false, error: "Task is waiting at a human gate; approve it on the task detail page" });
      if (task.status !== "paused") return sendJson(res, 409, { ok: false, error: `Only a paused task can be resumed (status: ${task.status})` });
      try {
        const result = uiMode(options) === "fleet" ? JSON.parse(await runNode(options.root, loopArgs(options.root, "resume-task", taskId), { timeout: 30000 })) as unknown : await activateTask(options.root, taskId);
        sendJson(res, 200, { ok: true, result, daemon: daemonStatus(options.root) });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: childError(error) });
      }
    },
  },
  {
    method: "POST",
    match: exact("/api/gate/feedback"),
    token: true,
    handle: async ({ options, req, res }) => {
      const fields = await fieldsOf(req);
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
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: childError(error) });
      }
    },
  },
  {
    method: "POST",
    match: exact("/api/gate/approve"),
    token: true,
    handle: async ({ options, req, res }) => {
      const fields = await fieldsOf(req);
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
        sendJson(res, 200, { ok: true, result });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: childError(error) });
      }
    },
  },
];

/** Builds the request handler for the UI server (exported for unit tests). */
export const createUiHandler = (options: UiOptions): (req: IncomingMessage, res: ServerResponse) => void => {
  return (req, res) => {
    const url = new URL(req.url ?? "/", `http://${options.host || "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;
    const guard = requestAllowed(options, req);
    if (!guard.ok) return sendJson(res, 403, { ok: false, error: guard.error });

    void (async () => {
      try {
        for (const route of ROUTES) {
          if (route.method !== method) continue;
          const params = route.match(path);
          if (!params) continue;
          if (route.token && !tokenMatches(options.token ?? "", suppliedToken(req))) return sendJson(res, 401, { ok: false, error: "Invalid or missing approve token" });
          await route.handle({ options, req, res, url, params });
          return;
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
