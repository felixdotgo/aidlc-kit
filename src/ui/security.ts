/** Request guards: Host/Origin pinning and the session-token check for mutating endpoints. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { UiOptions } from "./options.js";

/** The approve token travels only in a header (`Authorization: Bearer` or `x-aidlc-token`). A custom
 * header forces a CORS preflight, so a cross-site form or `no-cors` request can never carry it; a body
 * field would (classic CSRF), so it is not accepted. */
export const suppliedToken = (req: IncomingMessage): string => {
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

export const tokenMatches = (token: string, supplied: string): boolean => {
  if (!token || !supplied) return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
};
