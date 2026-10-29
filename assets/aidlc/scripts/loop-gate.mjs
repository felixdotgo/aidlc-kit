#!/usr/bin/env node
// This host-only terminal is deliberately not available to lead/worker containers.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { acquireStateLock, approveAndAdvance, checkGate, loadState, saveState } from "./lib/store.mjs";
import { formatGateView } from "./lib/runtime.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";
import { leadArtifactDigest } from "./lib/loop-lead-artifacts.mjs";
import { readLocalGateCheckpoint, writeLocalGateReceipt } from "./lib/loop-local-gate-receipt.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function snapshot(root, taskId, state) {
  const task = state.tasks[taskId];
  if (!task || task.status !== "blocked_on_user") throw new Error("Task is not waiting at a human gate");
  const pending = join(root, ".agents", "data", "tasks", taskId, ".lead-artifact-journal.json");
  try { lstatSync(pending); throw new Error("Pending artifact journal requires supervised recovery before review"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const checks = checkGate(root, state, taskId, task.gate);
  if (checks.some((entry) => entry.level === "ERROR")) throw new Error("Gate checks failed; repair before approval");
  const artifacts = Object.fromEntries(["intent", "design", "workplan"].map((name) => [name, leadArtifactDigest({ root, taskId, task, name })]));
  let commit = null;
  if (task.gate === "G2_codereview") {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 30000 }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8", timeout: 30000 });
    if (status.split("\0").filter(Boolean).some((entry) => !entry.slice(3).startsWith(".agents/data/"))) throw new Error("G2 review requires a clean integration checkout outside workflow data");
  }
  const checkpoint = readLocalGateCheckpoint(root, task);
  return { taskId, phase: task.phase, gate: task.gate, taskHash: digest(task), checkpointHash: digest(checkpoint), artifacts, commit, view: formatGateView(task, checks, "plain") };
}
async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Gate approval requires the trusted host terminal");
  const [taskId, ...args] = process.argv.slice(2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId ?? "") || (args.length && (args.length !== 2 || args[0] !== "--root" || !args[1]))) throw new Error("Usage: loop-gate.mjs <task-id> [--root <path>]");
  const root = resolve(args[1] ?? "."); requireLocalAuthority();
  let release = acquireStateLock(root), review;
  try { review = snapshot(root, taskId, loadState(root)); } finally { release(); }
  console.log(review.view.trimEnd());
  console.log(`Review identity: ${JSON.stringify({ taskId, phase: review.phase, gate: review.gate, taskHash: review.taskHash, artifacts: review.artifacts, integrationCommit: review.commit })}`);
  const rl = createInterface({ input: stdin, output: stdout });
  let answer; try { answer = await rl.question("Type approve to approve this exact review: "); } finally { rl.close(); }
  if (answer.trim() !== "approve") throw new Error("Review was not approved");
  release = acquireStateLock(root);
  try {
    const state = loadState(root), fresh = snapshot(root, taskId, state);
    if (digest({ ...fresh, view: undefined }) !== digest({ ...review, view: undefined })) throw new Error("Review changed while waiting for approval; inspect the new review");
    const checkpoint = readLocalGateCheckpoint(root, state.tasks[taskId]);
    const reviewHash = digest({ ...review, view: undefined });
    const outcome = approveAndAdvance(root, state, taskId, review.gate, `Trusted host terminal: approve (${reviewHash})`);
    saveState(root, state);
    writeLocalGateReceipt(root, checkpoint, outcome.task, reviewHash);
    console.log(`Approved ${review.gate}; next action: ${JSON.stringify(outcome.nextAction)}`);
  } finally { release(); }
}
main().catch((error) => { console.error(`loop-gate: ${error.message}`); process.exitCode = 1; });
