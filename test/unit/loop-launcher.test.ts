import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parseLauncherArgs, readUiRecord, uiStatePath } from "../../src/cli/loop-launcher.js";
import { applyPlan, planInit } from "../../src/installer.js";
import { daemonStatus, ensureDaemon, stopDaemon } from "../../src/ui/daemon.js";

const cli = resolve("dist/src/cli.js");

function project(loop?: { mode: "local" | "off"; agents?: { lead: "codex"; workers: Record<string, "codex"> } }) {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-launcher-"));
  const root = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(root); mkdirSync(home);
  applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false, ...(loop ? { loop } : {}) }));
  return { root, home, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const local = { mode: "local" as const, agents: { lead: "codex" as const, workers: { "worker-a": "codex" as const } } };
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, "loop", ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
/** Async variant: keeps this process's event loop running so it reaps the fake daemons it spawned
 * (a blocked spawnSync would leave them as zombies that still answer kill(pid, 0)). */
const runAsync = (args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((done) => {
  const child = spawn(process.execPath, [cli, "loop", ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => done({ status, stdout, stderr }));
});

/** A stand-in daemon: exits after `signals` SIGTERMs, appending one line to `count` per signal;
 * its pid goes into daemon.lock. */
async function fakeDaemon(root: string, signals: number, count = join(root, "signals.txt")): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", `const fs=require("fs");let n=0;process.on("SIGTERM",()=>{fs.appendFileSync(${JSON.stringify(count)},"x");if(++n>=${signals})process.exit(0)});process.stdout.write("ready\\n");setInterval(()=>{},1000)`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((ready) => child.stdout?.once("data", () => ready()));
  mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
  writeFileSync(join(root, ".agents/data/loop/daemon.lock"), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
  return child;
}
const exited = (child: ChildProcess): Promise<void> => new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", () => done()); });

test("parseLauncherArgs enforces the per-action allowlist and value flags", () => {
  const parsed = parseLauncherArgs(["--root", "/tmp/x", "--open", "--port", "5000"], ["--root", "--open", "--port"]);
  assert.equal(parsed.root, "/tmp/x");
  assert.equal(parsed.values.get("--port"), "5000");
  assert.ok(parsed.switches.has("--open"));
  assert.throws(() => parseLauncherArgs(["--bogus"], ["--root"]), /Unknown loop option: --bogus/);
  assert.throws(() => parseLauncherArgs(["--root"], ["--root"]), /--root requires a value/);
});

test("loop up explains how to enable the loop when loop mode is off", () => {
  const box = project();
  try {
    const result = run(["up", "--root", box.root, "--no-ui"], { HOME: box.home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Loop mode is off/);
    assert.match(result.stderr, /init --loop-mode local/);
    assert.equal(daemonStatus(box.root).running, false);
  } finally { box.cleanup(); }
});

test("loop up stops at the environment report when a required value is missing", () => {
  const box = project(local);
  try {
    const result = run(["up", "--root", box.root, "--no-ui", "--loop-env", join(box.root, "missing.env")], { HOME: box.home });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /env file not found/);
    assert.match(result.stderr, /Fix the errors above/);
    assert.equal(daemonStatus(box.root).running, false);
  } finally { box.cleanup(); }
});

test("loop env and loop status report the environment without printing secrets", () => {
  const box = project(local);
  try {
    writeFileSync(join(box.root, ".agents/loop.env"), "OPENAI_API_KEY=sk-from-file-secret\n");
    const env = run(["env", "--root", box.root], { HOME: box.home });
    assert.equal(env.status, 0, env.stdout + env.stderr);
    assert.match(env.stdout, /OPENAI_API_KEY\s+set\s+\[file\]/);
    assert.doesNotMatch(env.stdout, /sk-from-file-secret/);
    const status = run(["status", "--root", box.root], { HOME: box.home });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Daemon\s+: stopped/);
    assert.match(status.stdout, /Dashboard : not running/);
    const json = run(["status", "--root", box.root, "--json"], { HOME: box.home });
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.daemon.running, false);
    assert.equal(parsed.env.ok, true);
    assert.doesNotMatch(json.stdout, /sk-from-file-secret/);
  } finally { box.cleanup(); }
});

test("loop up with a running daemon and --no-ui reports it instead of starting another", async () => {
  const box = project(local);
  const child = await fakeDaemon(box.root, 1);
  try {
    const result = run(["up", "--root", box.root, "--no-ui"], { HOME: box.home, OPENAI_API_KEY: "x" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Loop daemon already running \\(pid ${child.pid}`));
    assert.match(result.stdout, /Dashboard not started/);
    assert.equal(ensureDaemon(box.root).started, false);
  } finally { child.kill("SIGKILL"); await exited(child); box.cleanup(); }
});

test("stopDaemon sends one signal to finish the turn, and a second with now", async () => {
  const box = project(local);
  try {
    assert.deepEqual(await stopDaemon(box.root), { wasRunning: false, stopped: true, pid: null });
    const graceful = await fakeDaemon(box.root, 1);
    const first = await stopDaemon(box.root, { timeoutMs: 3000 });
    assert.deepEqual(first, { wasRunning: true, stopped: true, pid: graceful.pid });
    await exited(graceful);

    const stubborn = await fakeDaemon(box.root, 2);
    const pending = await stopDaemon(box.root, { timeoutMs: 400 });
    assert.equal(pending.stopped, false, "a single signal only finishes the current turn");
    const forced = await stopDaemon(box.root, { now: true, timeoutMs: 3000 });
    assert.equal(forced.stopped, true);
    await exited(stubborn);
  } finally { box.cleanup(); }
});

test("loop down stops a recorded dashboard and the daemon", async () => {
  const box = project(local);
  const daemon = await fakeDaemon(box.root, 1);
  // A stand-in dashboard that answers /api/instance with the recorded id.
  const ui = spawn(process.execPath, ["-e", "const s=require('http').createServer((q,r)=>{r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({ok:true,instance:'fake-1'}))}).listen(0,'127.0.0.1',()=>process.stdout.write(String(s.address().port)+'\\n'));process.on('SIGTERM',()=>process.exit(0))"], { stdio: ["ignore", "pipe", "ignore"] });
  const port = await new Promise<string>((ready) => ui.stdout?.once("data", (chunk) => ready(String(chunk).trim())));
  try {
    writeFileSync(uiStatePath(box.root), JSON.stringify({ pid: ui.pid, url: `http://127.0.0.1:${port}`, instance: "fake-1", startedAt: new Date().toISOString() }));
    assert.equal(readUiRecord(box.root)?.running, true);
    const result = await runAsync(["down", "--root", box.root], { HOME: box.home });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Stopped the dashboard \\(pid ${ui.pid}\\)`));
    assert.match(result.stdout, new RegExp(`Stopped the loop daemon \\(pid ${daemon.pid}\\)`));
    assert.equal(readUiRecord(box.root), undefined);
    const again = await runAsync(["down", "--root", box.root], { HOME: box.home });
    assert.match(again.stdout, /Loop daemon is not running/);
  } finally { ui.kill("SIGKILL"); daemon.kill("SIGKILL"); await exited(ui); await exited(daemon); box.cleanup(); }
});

test("repeated stop requests never exceed the cancel stage (stop, then stop --now = exactly two signals)", async () => {
  const box = project(local);
  const count = join(box.root, "count.txt");
  const daemon = await fakeDaemon(box.root, 3, count); // a third signal would mean "exit immediately"
  try {
    assert.equal((await stopDaemon(box.root, { timeoutMs: 300 })).stopped, false);
    assert.equal((await stopDaemon(box.root, { timeoutMs: 300 })).stopped, false, "a repeated stop sends nothing new");
    assert.equal(readFileSync(count, "utf8"), "x");
    await stopDaemon(box.root, { now: true, timeoutMs: 300 });
    await stopDaemon(box.root, { now: true, timeoutMs: 300 });
    assert.equal(readFileSync(count, "utf8"), "xx", "never the third, hard-exit signal");
  } finally { daemon.kill("SIGKILL"); await exited(daemon); box.cleanup(); }
});

test("an expired daemon lease or an unreachable recorded dashboard is treated as stale", async () => {
  const box = project(local);
  const bystander = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    mkdirSync(join(box.root, ".agents/data/loop"), { recursive: true });
    writeFileSync(join(box.root, ".agents/data/loop/daemon.lock"), JSON.stringify({ pid: bystander.pid, startedAt: new Date(Date.now() - 600000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() }));
    assert.equal(daemonStatus(box.root).running, false, "a live pid behind an expired lease is not the daemon");
    writeFileSync(uiStatePath(box.root), JSON.stringify({ pid: bystander.pid, url: "http://127.0.0.1:9", instance: "gone", startedAt: new Date().toISOString() }));
    const result = await runAsync(["down", "--root", box.root], { HOME: box.home });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Stopped the dashboard/);
    assert.match(result.stdout, /did not answer as this project's dashboard; not stopping it/);
    assert.equal(bystander.exitCode, null, "the unrelated process was not signalled");
    bystander.kill("SIGKILL"); await exited(bystander);
    await runAsync(["down", "--root", box.root], { HOME: box.home });
    assert.equal(readUiRecord(box.root), undefined, "a record whose pid is gone is removed");
  } finally { bystander.kill("SIGKILL"); await exited(bystander); box.cleanup(); }
});

test("dashboardReachable matches the recorded instance id, not just any dashboard on the port", async () => {
  const { dashboardReachable } = await import("../../src/cli/loop-launcher.js");
  const { startUiServer } = await import("../../src/ui/server.js");
  const box = project(local);
  const { server, port } = await startUiServer({ root: box.root, host: "127.0.0.1", port: 0, instance: "instance-b" });
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.equal(await dashboardReachable({ url, instance: "instance-b" }), true);
    assert.equal(await dashboardReachable({ url, instance: "instance-a" }), false, "another project's dashboard on the same port");
    assert.equal(await dashboardReachable({ url }), false, "a record without an id is never trusted");
  } finally { await new Promise<void>((done) => server.close(() => done())); box.cleanup(); }
});
