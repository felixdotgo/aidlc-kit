#!/usr/bin/env node
import { resolve } from "node:path";
import { claimLocalAssignment, heartbeatLocalAssignment, reconcileLocalAssignments, releaseLocalAssignment, reportLocalAssignment, showLocalAssignments } from "./lib/assignment-store.mjs";
import { requireLocalAuthority } from "./lib/authority.mjs";

try {
  requireLocalAuthority();
  const args = process.argv.slice(2);
  const optionAt = args.findIndex((value) => value.startsWith("--"));
  const [command, taskId, assignmentOrItem] = args.slice(0, optionAt < 0 ? undefined : optionAt);
  const tail = optionAt < 0 ? [] : args.slice(optionAt);
  const options = new Map();
  for (let i = 0; i < tail.length; i += 2) {
    const name = tail[i];
    if (!name?.startsWith("--") || !tail[i + 1] || options.has(name)) throw new Error(`Invalid option: ${name}`);
    options.set(name, tail[i + 1]);
  }
  const allowed = new Set(["--root", "--worker", "--paths", "--lease-ms", "--base-commit", "--branch", "--session-id", "--checkpoint", "--commit", "--changed-paths"]);
  for (const name of options.keys()) if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
  const root = resolve(options.get("--root") ?? process.cwd());
  const number = (name, fallback) => options.has(name) ? Number(options.get(name)) : fallback;
  let result;
  if (command === "show" && taskId && !assignmentOrItem) result = showLocalAssignments(root, taskId);
  else if (command === "reconcile" && taskId && !assignmentOrItem) result = reconcileLocalAssignments(root, taskId);
  else if (command === "claim" && taskId && assignmentOrItem) result = claimLocalAssignment(root, {
    taskId, itemId: assignmentOrItem, workerId: options.get("--worker") ?? "", ownedPaths: (options.get("--paths") ?? "").split(","), leaseMs: number("--lease-ms", 300000), baseCommit: options.get("--base-commit") ?? null, branch: options.get("--branch") ?? null, sessionId: options.get("--session-id") ?? null
  });
  else if (command === "heartbeat" && taskId && assignmentOrItem) result = heartbeatLocalAssignment(root, taskId, assignmentOrItem, number("--lease-ms", 300000), options.get("--session-id"));
  else if (command === "report" && taskId && assignmentOrItem) result = reportLocalAssignment(root, taskId, assignmentOrItem, { checkpoint: options.get("--checkpoint") ?? null, commit: options.get("--commit") ?? null, changedPaths: options.has("--changed-paths") ? options.get("--changed-paths").split(",") : [] });
  else if (command === "release" && taskId && assignmentOrItem) result = releaseLocalAssignment(root, taskId, assignmentOrItem);
  else throw new Error("Usage: assignment.mjs show|reconcile <task-id> | claim <task-id> <item-id> --worker <id> --paths <comma-separated-paths> | heartbeat|report|release <task-id> <assignment-id>");
  console.log(JSON.stringify({ ok: true, result }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
