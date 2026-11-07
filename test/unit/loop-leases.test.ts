import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { applyPlan, planInit } from "../../src/installer.js";

const lib = resolve("dist/assets/.agents/aidlc/scripts/lib");
const leases = async (): Promise<any> => import(join(lib, "loop-leases.mjs"));
const daemon = async (): Promise<any> => import(join(lib, "loop-daemon.mjs"));
const lease = async (): Promise<any> => import(join(lib, "loop-lease.mjs"));
const DEAD_PID = 2147483647;

const v2 = (patch: Record<string, unknown>) => {
  const now = Date.now();
  return { schemaVersion: 2, kind: "lease", scope: "task:x", pid: DEAD_PID, host: hostname(), command: "loop start", purpose: "test", activity: "waiting", token: "t", startedAt: new Date(now - 5000).toISOString(), heartbeatAt: new Date(now - 5000).toISOString(), expiresAt: new Date(now + 55000).toISOString(), ...patch };
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aidlc-leases-"));
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
  const loop = join(root, ".agents/data/loop");
  mkdirSync(join(loop, "assignments"), { recursive: true });
  return { root, loop };
}

function seed(root: string, loop: string) {
  const old = (Date.now() - 60000) / 1000;
  // Stale v2 task lease (dead pid) and a v1 leftover supervisor lease + guard.
  writeFileSync(join(loop, "stale-task.lease"), JSON.stringify(v2({ scope: "task:stale-task" })));
  writeFileSync(join(loop, "old-task.supervisor.lease"), JSON.stringify({ taskId: "old-task", pid: DEAD_PID, token: "v1" }));
  writeFileSync(join(loop, "old-task.supervisor.guard"), JSON.stringify({ taskId: "old-task", pid: DEAD_PID, token: "g" }));
  utimesSync(join(loop, "old-task.supervisor.guard"), old, old);
  // Stale v1 assignment lock and claims: one overdue leased claim, one reported.
  writeFileSync(join(loop, "assignments/build-task.lock"), JSON.stringify({ pid: DEAD_PID, token: "lock" }));
  const claim = (id: string, itemId: string, state: string, expires: number) => ({ id, taskId: "build-task", itemId, workerId: `w-${itemId}`, ownedPaths: [`src/${itemId}`], attempt: 1, state, leaseExpiresAt: new Date(expires).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  writeFileSync(join(loop, "assignments/build-task.json"), JSON.stringify({ schemaVersion: 1, taskId: "build-task", assignments: [claim("asg-1", "api", "leased", Date.now() - 1000), claim("asg-2", "ui", "reported", Date.now() + 60000), claim("asg-3", "docs", "integrated", Date.now() - 1000)] }));
  // A lifecycle state lock held by a dead pid but recent (still counts as live).
  writeFileSync(join(root, ".agents/data/state/.aidlc-state.lock"), JSON.stringify({ token: "s", pid: DEAD_PID, createdAt: Date.now() }));
}

test("leases lists daemon, task, legacy, assignment lock, claims, and state lock with blocks and remedies", async () => {
  const { root, loop } = fixture();
  const releaseDaemon = (await daemon()).acquireDaemonLock(root);
  const taskLease = (await lease()).acquireTaskLease(root, "live-task", { activity: "turn", label: "loop runner" });
  try {
    seed(root, loop);
    const { collectLocalLeases } = await leases();
    const entries = collectLocalLeases(root);
    const find = (category: string, scope: string) => entries.find((entry: any) => entry.category === category && entry.scope === scope);
    const d = find("daemon", "daemon");
    assert.equal(d.state, "live");
    assert.equal(d.holder.pid, process.pid);
    assert.equal(d.clearable, false);
    assert.match(d.blocks, /second `loop start`/);
    const live = find("task", "task:live-task");
    assert.equal(live.state, "live");
    assert.equal(live.holder.activity, "turn");
    assert.match(live.blocks, /gate approve live-task/);
    const stale = find("task", "task:stale-task");
    assert.equal(stale.state, "stale");
    assert.equal(stale.clearable, true);
    assert.match(stale.remedy, /leases --clear-stale/);
    assert.equal(find("legacy", "task:old-task (v1 supervisor)")?.state, "stale");
    assert.ok(entries.some((entry: any) => entry.kind === "guard" && entry.category === "legacy" && entry.state === "stale"));
    assert.equal(find("assignment-lock", "assignments:build-task")?.state, "stale");
    const expired = find("claim", "item:build-task/api");
    assert.equal(expired.state, "expired");
    assert.equal(expired.holder.persistedState, "leased");
    assert.equal(expired.holder.effectiveState, "expired");
    assert.equal(expired.clearable, false);
    assert.match(expired.remedy, /assignment\.mjs reconcile build-task/);
    assert.match(expired.remedy, /assignment\.mjs release build-task asg-1/);
    assert.equal(find("claim", "item:build-task/ui")?.state, "live");
    assert.equal(find("claim", "item:build-task/docs"), undefined, "integrated claims block nothing");
    const stateLock = find("state-lock", "lifecycle-state");
    assert.equal(stateLock.state, "live");
    assert.equal(stateLock.clearable, false);
    // Task filter.
    const only = collectLocalLeases(root, { taskId: "build-task" });
    assert.ok(only.every((entry: any) => entry.scope.includes("build-task") || entry.category === "state-lock"));
  } finally { taskLease.release(); releaseDaemon(); rmSync(root, { recursive: true, force: true }); }
});

test("--clear-stale removes only stale holders and guards; live holders, claims, and the state lock stay", async () => {
  const { root, loop } = fixture();
  const releaseDaemon = (await daemon()).acquireDaemonLock(root);
  try {
    seed(root, loop);
    writeFileSync(join(loop, "fresh-corrupt.lease"), "{");
    const claimsBefore = readFileSync(join(loop, "assignments/build-task.json"), "utf8");
    const { runLeases, formatLeases } = await leases();
    const report = await runLeases({ root, clearStale: true });
    assert.deepEqual([...report.cleared].sort(), [join(loop, "assignments/build-task.lock"), join(loop, "old-task.supervisor.guard"), join(loop, "old-task.supervisor.lease"), join(loop, "stale-task.lease")].sort());
    assert.ok(existsSync(join(loop, "daemon.lock")));
    assert.ok(existsSync(join(loop, "fresh-corrupt.lease")), "a recent corrupt file is not removed");
    assert.ok(existsSync(join(root, ".agents/data/state/.aidlc-state.lock")));
    assert.equal(readFileSync(join(loop, "assignments/build-task.json"), "utf8"), claimsBefore);
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.entries.some((entry: any) => entry.category === "task" && entry.state === "corrupt" && /becomes reclaimable/.test(entry.remedy)));
    const text = formatLeases(report);
    assert.match(text, /lock = short mutex .* lease = process ownership .* claim = a worker's ownership/);
    assert.match(text, /Cleared 4 stale file\(s\)/);
    assert.match(text, /LIVE {4}lease daemon {2}\[daemon\]/);
    assert.match(text, /EXPIRED claim item:build-task\/api/);
    assert.match(text, /fix: {5}.*assignment\.mjs reconcile build-task/);
  } finally { releaseDaemon(); rmSync(root, { recursive: true, force: true }); }
});

test("fleet summary names lead lease and job claims and shows supervisor epoch only when it differs", async () => {
  const { summarizeFleet, runLeases, formatLeases } = await leases();
  const now = Date.parse("2030-01-01T00:00:00Z");
  const fleet = {
    leads: { a: { epoch: 3, actor: "lead-1", expiresAt: "2030-01-01T00:04:00Z" }, b: { epoch: 2, actor: "lead-2", expiresAt: "2029-12-31T23:00:00Z" } },
    supervisors: { a: { epoch: 3, expiresAt: "2030-01-01T00:04:00Z" }, b: { epoch: 5, expiresAt: "2030-01-01T00:04:00Z" } },
    jobs: { j1: { id: "j1", taskId: "a", itemId: "api", workerId: "w1", state: "leased", epoch: 7, expiresAt: "2030-01-01T00:01:00Z" }, j2: { id: "j2", taskId: "a", itemId: "ui", workerId: "w2", state: "integrated" } },
  };
  const entries = summarizeFleet(fleet, { now });
  const a = entries.find((entry: any) => entry.category === "fleet-lead" && entry.scope === "task:a");
  assert.equal(a.state, "live");
  assert.equal(a.holder.leadEpoch, 3);
  assert.equal("supervisorEpoch" in a.holder, false);
  const b = entries.find((entry: any) => entry.category === "fleet-lead" && entry.scope === "task:b");
  assert.equal(b.state, "expired");
  assert.equal(b.holder.supervisorEpoch, 5);
  const job = entries.find((entry: any) => entry.category === "fleet-job");
  assert.equal(job.kind, "claim");
  assert.equal(job.holder.jobEpoch, 7);
  assert.equal(entries.filter((entry: any) => entry.category === "fleet-job").length, 1);
  const root = mkdtempSync(join(tmpdir(), "aidlc-leases-fleet-"));
  try {
    const ok = await runLeases({ root, fleetReader: async () => ({ revision: 4, fleet }), now });
    assert.equal(ok.fleet.revision, 4);
    assert.match(formatLeases(ok), /Fleet \(coordination service, revision 4\):[\s\S]*lead-1, lead epoch 3/);
    const failed = await runLeases({ root, fleetReader: async () => { throw new Error("Remote coordination unavailable: offline"); } });
    assert.equal(failed.fleet.error, "Remote coordination unavailable: offline");
    assert.match(formatLeases(failed), /unavailable: Remote coordination unavailable: offline/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("loop-entry leases and aidlc-kit loop leases print the report; JSON keeps a stable schema", async () => {
  const { root, loop } = fixture();
  try {
    writeFileSync(join(loop, "stale-task.lease"), JSON.stringify(v2({ scope: "task:stale-task" })));
    const entry = join(root, ".agents/aidlc/scripts/loop-entry.mjs");
    const text = spawnSync(process.execPath, [entry, "leases", "", root], { encoding: "utf8" });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /STALE {3}lease task:stale-task/);
    assert.match(text.stdout, /can be removed with: node \.agents\/aidlc\/scripts\/loop-entry\.mjs leases --clear-stale/);
    const json = spawnSync(process.execPath, [entry, "leases", "stale-task", root, "--json"], { encoding: "utf8" });
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.taskId, "stale-task");
    assert.deepEqual(Object.keys(report.entries[0]).sort(), ["blocks", "category", "clearable", "expiresAt", "heartbeatAt", "holder", "kind", "path", "reason", "remedy", "scope", "state", "ttlMs"]);
    assert.equal(report.fleet, null);
    const bad = spawnSync(process.execPath, [entry, "leases", "", root, "--force"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /Unknown leases option: --force/);
    const cli = resolve("dist/src/cli.js");
    const viaCli = spawnSync(process.execPath, [cli, "loop", "leases", "--root", root, "--json", "--clear-stale"], { encoding: "utf8" });
    assert.equal(viaCli.status, 0, viaCli.stderr);
    assert.deepEqual(JSON.parse(viaCli.stdout).cleared, [join(loop, "stale-task.lease")]);
    assert.equal(existsSync(join(loop, "stale-task.lease")), false);
    const badCli = spawnSync(process.execPath, [cli, "loop", "leases", "--root", root, "--json", "--json"], { encoding: "utf8" });
    assert.notEqual(badCli.status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
