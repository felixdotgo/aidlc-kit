/** HTTP response helpers, HTML escaping, and request-body parsing. */
import type { IncomingMessage, ServerResponse } from "node:http";

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export const sendHtml = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

/** Static assets (CSS, client JS) are cacheable; script URLs carry a content hash to bust upgrades. */
export const sendAsset = (res: ServerResponse, contentType: string, body: string): void => {
  res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
  res.end(body);
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => {
  switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return "&#39;";
  }
});

/** A client error mapped to HTTP 400 by the request handler. */
export class BadRequest extends Error {}

/** Reads a request body up to `limit` bytes (default 8 KiB). Routes that carry an 8192-byte
 * text field pass a larger limit so JSON escaping does not count against the field. */
export const readBody = (req: IncomingMessage, limit = 8192): Promise<string> =>
  new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { reject(new BadRequest(`Request body exceeds ${limit} bytes`)); req.destroy(); return; }
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

export const readFields = (body: string, contentType: string | undefined): Record<string, string> => {
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
