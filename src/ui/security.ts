/**
 * Request guards for a dashboard that has no session credential: the dashboard is meant for
 * trusted local/LAN networks, so what remains to defend against is a browser on the same
 * machine being used as a confused deputy (DNS rebinding, cross-site form posts, cross-site
 * `fetch`). Three request-shape checks cover that:
 *
 * - **Host** must name the bound address (any loopback name when bound to loopback). A DNS
 *   rebinding attack reaches the server with the attacker's hostname in `Host`, so it is
 *   rejected before any route runs. A wildcard bind cannot be pinned to one name, so it
 *   accepts only IP-literal or `localhost` Hosts (rebinding needs a DNS name) and otherwise
 *   relies on the remaining checks (the launcher warns when exposing it).
 * - **Origin** must be present and equal to `http://<Host>` on every state-changing request.
 *   Browsers always attach `Origin` to cross-site `POST`s (forms and `fetch` alike), so a
 *   foreign page can never make it match; a missing `Origin` is treated as foreign too.
 *   **Sec-Fetch-Site**, when the browser sends it, must say `same-origin` (or `none` for a
 *   direct navigation), which closes the same hole from the browser's own point of view.
 * - A custom **x-aidlc-request** header must be present. It is not a "simple" header, so a
 *   cross-site `fetch` cannot send it without a CORS preflight that this server never
 *   answers, and an HTML form cannot set headers at all. The client sends `x-aidlc-request: 1`
 *   on every `POST` (see `assets/ui/common.js` `post()`).
 *
 * `GET`/`HEAD`/`OPTIONS` are read-only and pass with just the Host check.
 */
import type { IncomingMessage } from "node:http";
import type { UiOptions } from "./options.js";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
/** Methods that never change state and therefore need only the Host check. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** `host:port` forms that are not DNS names: IPv4, bracketed IPv6, or `localhost`. */
const ADDRESS_HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|localhost):\d{1,5}$/;
/** Custom header every state-changing request must carry (any value). */
export const REQUEST_HEADER = "x-aidlc-request";

/** DNS-rebinding guard plus the request-shape CSRF guards described in the module doc. */
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
  } else if (!ADDRESS_HOST.test(host)) {
    // A wildcard bind cannot be pinned to one name, but DNS rebinding needs a DNS name:
    // accept only IP literals and `localhost` (with the bound port) so a rebound page is still refused.
    return { ok: false, error: "Host header must be an IP address or localhost on a wildcard bind" };
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (READ_METHODS.has(method)) return { ok: true };
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.toLowerCase() !== `http://${host}`) return { ok: false, error: "Cross-origin request rejected: Origin must match this dashboard" };
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return { ok: false, error: "Cross-site request rejected" };
  if (req.headers[REQUEST_HEADER] === undefined) return { ok: false, error: `Request rejected: missing ${REQUEST_HEADER} header` };
  return { ok: true };
};
