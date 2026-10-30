import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const serviceRoot = join(fileURLToPath(new URL("..", import.meta.url)));

test("health endpoint is public and non-fleet auth is timing-safe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-hz-"));
  const db = join(dir, "state.db");
  const token = randomBytes(16).toString("hex");
  const env = {
    ...process.env,
    MCP_STATE_DATABASE: "sqlite",
    MCP_STATE_SQLITE_PATH: db,
    MCP_STATE_HOST: "127.0.0.1",
    MCP_STATE_PORT: "0",
    MCP_STATE_AUTH_TOKEN: token,
  };
  const child = spawn(process.execPath, [join(serviceRoot, "src", "server.mjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout waiting for listening: " + stderr)), 10000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        const match = stderr.match(/listening at http:\/\/[^:]+:(\d+)\/mcp/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error("server exited " + code + ": " + stderr));
      });
    });

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
    assert.equal(noAuth.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong-token" } });
    assert.equal(wrong.status, 401);

    const correct = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    assert.notEqual(correct.status, 401);

    assert.match(stderr, /listening at http:/);
    assert.ok(!stderr.includes(token), "stderr must not contain the token");
  } finally {
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});