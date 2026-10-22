import { randomUUID } from "node:crypto";

const responseMessage = (body, contentType, id) => {
  if (contentType.includes("text/event-stream")) {
    const events = body.split(/\r?\n\r?\n/).flatMap((block) => {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
    return events.find((event) => event.id === id && (event.result || event.error));
  }
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed.find((item) => item.id === id) : parsed;
};

export const callTool = async ({ url, token, name, args = {}, timeoutMs = 20000, fetchImpl = fetch }) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || typeof token !== "string" || !token || typeof name !== "string" || !name) throw new Error("MCP URL, token, and tool name are required");
  const id = randomUUID();
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${body.slice(0, 500)}`);
  const message = responseMessage(body, response.headers.get("content-type") ?? "", id);
  if (!message) throw new Error("MCP response did not contain a matching result");
  if (message.error) throw new Error(`MCP ${message.error.code}: ${message.error.message}`);
  const tool = message.result;
  if (!Array.isArray(tool?.content) || tool.content[0]?.type !== "text") throw new Error("MCP tool returned no JSON text");
  let value;
  try { value = JSON.parse(tool.content[0].text); } catch { throw new Error("MCP tool returned invalid JSON text"); }
  if (tool.isError) { const error = new Error(value.message ?? value.code ?? "MCP tool failed"); error.code = value.code; error.current = value.current; throw error; }
  return value;
};
