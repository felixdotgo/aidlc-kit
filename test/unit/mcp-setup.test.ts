import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyMcpSetup, planMcpSetup } from "../../src/mcp-setup.js";

const options = (root: string, dryRun: boolean) => ({ root, template: join(process.cwd(), "services/aidlc-coordination"), dryRun, deployment: "docker" as const, storage: "sqlite" as const, bind: "localhost" as const, workspace: "demo", pollMs: 30_000, tokenEnv: "AIDLC_MCP_TOKEN", providers: ["jira"], enable: false });

test("MCP setup previews safely and scaffolds Docker while keeping MCP disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-mcp-setup-"));
  try {
    const preview = planMcpSetup(options(root, true));
    assert.equal(preview.config.enabled, false); assert.equal(existsSync(join(root, ".agents/aidlc-coordination")), false);
    const applied = applyMcpSetup(options(root, false));
    assert.equal(applied.target, join(root, ".agents/aidlc-coordination"));
    assert.equal(existsSync(join(applied.target, "compose.yaml")), true);
    assert.match(readFileSync(join(root, ".agents/config.json"), "utf8"), /"enabled": false/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("MCP setup preserves $schema and toggles mcp.enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-mcp-schema-"));
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(join(root, ".agents/config.json"), JSON.stringify({ schemaVersion: 2, extends: ["topology/single"], specs: { roots: [] }, commands: {}, rules: { include: [] }, risk: { default: "normal" }, context: { maxChars: 16000 }, agentState: {}, "$schema": "./aidlc/schemas/config.schema.json" }));
    const applied = applyMcpSetup({ ...options(root, false), enable: true });
    const config = JSON.parse(readFileSync(join(root, ".agents/config.json"), "utf8")) as Record<string, unknown>;
    assert.equal(config.$schema, "./aidlc/schemas/config.schema.json");
    assert.equal((config.mcp as { enabled: boolean }).enabled, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
