#!/usr/bin/env node
import { verifyReleaseEvidence } from "./release.js";
import { packageVersion } from "../../src/workflow.js";

try {
  const args = process.argv.slice(2);
  const adapterIndex = args.indexOf("--adapters");
  if (args.filter((arg) => arg === "--adapters").length > 1) throw new Error("--adapters may be provided at most once");
  const adapterValue = adapterIndex >= 0 ? args[adapterIndex + 1] : undefined;
  if (adapterIndex >= 0 && (!adapterValue || adapterValue.startsWith("--"))) throw new Error("--adapters requires a comma-separated value");
  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--adapters");
  if (unknownFlags.length) throw new Error(`Unknown release-check flags: ${unknownFlags.join(", ")}`);
  const requiredAdapters = (adapterIndex >= 0 ? (adapterValue ?? "").split(",") : ["codex", "claude"]).map((adapter) => adapter.trim()).filter(Boolean);
  const positional = args.filter((arg, index) => !(adapterIndex >= 0 && (index === adapterIndex || index === adapterIndex + 1)) && !arg.startsWith("--"));
  if (positional.length > 1) throw new Error("release-check accepts at most one evidence path");
  const path = positional[0] ?? ".agents/project/release-eval.json";
  const evidence = verifyReleaseEvidence(path, packageVersion(), { requiredAdapters });
  console.log(`PACKAGE READY: evaluator certification is current (${requiredAdapters.join(",")} via ${evidence.reports.length} real report(s) for AI-DLC ${evidence.packageVersion}).`);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`RELEASE BLOCKED: evaluator certification is not current (${reason}).`);
  process.exitCode = 1;
}
