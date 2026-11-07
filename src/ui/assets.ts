/**
 * Vendored static assets under `assets/ui` (copied to `dist/assets/ui` by the build): Bulma, the
 * dashboard theme layer, and the classic client scripts. Only whitelisted routes are served; each
 * file is read once and cached in memory.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

/** Client scripts, loaded as classic scripts in this order: `common` first, page scripts after. */
export type ClientScript = "common" | "dashboard" | "detail" | "live-log" | "changes";

const ASSETS = new Map<string, { file: string; contentType: string }>([
  ["/assets/bulma.css", { file: "bulma.min.css", contentType: CSS }],
  ["/assets/dashboard.css", { file: "dashboard.css", contentType: CSS }],
  ...(["common", "dashboard", "detail", "live-log", "changes"] satisfies ClientScript[]).map((name) => [`/assets/${name}.js`, { file: `${name}.js`, contentType: JS }] as const),
]);

const cache = new Map<string, { body: string; version: string }>();
const load = (route: string, file: string): { body: string; version: string } => {
  const cached = cache.get(route);
  if (cached) return cached;
  let body = "";
  try { body = readFileSync(fileURLToPath(new URL(`../../assets/ui/${file}`, import.meta.url)), "utf8"); }
  catch { /* serve an empty asset rather than failing the page */ }
  const entry = { body, version: createHash("sha256").update(body).digest("hex").slice(0, 12) };
  cache.set(route, entry);
  return entry;
};

/** The whitelisted asset for a request path, or undefined (the caller answers 404). */
export const staticAsset = (route: string): { contentType: string; body: string } | undefined => {
  const asset = ASSETS.get(route);
  return asset ? { contentType: asset.contentType, body: load(route, asset.file).body } : undefined;
};

/** `<script src>` for a client script; `?v=<content hash>` makes an upgrade bust the browser cache. */
export const scriptTag = (name: ClientScript): string => {
  const route = `/assets/${name}.js`;
  return `<script src="${route}?v=${load(route, `${name}.js`).version}"></script>`;
};
