#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callTool } from "./fleet-client.mjs";

const source = new URL("../../../assets/aidlc/scripts/lib/loop-fleet-cli.mjs", import.meta.url);
const packaged = new URL("../../../assets/.agents/aidlc/scripts/lib/loop-fleet-cli.mjs", import.meta.url);
const installed = new URL("../../aidlc/scripts/lib/loop-fleet-cli.mjs", import.meta.url);
const entry = [installed, source, packaged].find((candidate) => existsSync(fileURLToPath(candidate)));

try {
  if (!entry) throw new Error("Fleet runner assets are missing from this installation");
  const { runFleetCli } = await import(entry.href);
  await runFleetCli(process.argv.slice(2), { callTool });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
