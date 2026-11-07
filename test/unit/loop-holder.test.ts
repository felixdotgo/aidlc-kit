import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const modulePath = resolve("dist/assets/.agents/aidlc/scripts/lib/loop-holder.mjs");
const load = async (): Promise<any> => import(modulePath);
const DEAD_PID = 2147483647;

const withDir = async (fn: (dir: string) => Promise<void> | void) => {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-holder-"));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

const v2 = (patch: Record<string, unknown> = {}) => {
  const now = Date.now();
  return {
    schemaVersion: 2, kind: "lease", scope: "task:t1", pid: process.pid, host: hostname(), command: "test", purpose: "test",
    activity: null, token: "other-token", startedAt: new Date(now - 1000).toISOString(), heartbeatAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(), ...patch,
  };
};

const runChild = (code: string): Promise<{ code: number | null; stdout: string; stderr: string }> => new Promise((done) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (exit) => done({ code: exit, stdout, stderr }));
});

test("acquire writes a v2 lease, readHolder reports it live, release removes it", async () => withDir(async (dir) => {
  const { acquireHolder, readHolder } = await load();
  const path = join(dir, "t1.lease");
  const handle = acquireHolder({ path, kind: "lease", scope: "task:t1", purpose: "loop run", activity: "waiting", heartbeatMs: 0 });
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.schemaVersion, 2);
  assert.equal(onDisk.kind, "lease");
  assert.equal(onDisk.scope, "task:t1");
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.host, hostname());
  assert.equal(onDisk.activity, "waiting");
  assert.equal(onDisk.token, handle.token);
  assert.ok(Date.parse(onDisk.expiresAt) - Date.parse(onDisk.heartbeatAt) === 60000);
  const entry = readHolder(path);
  assert.equal(entry.state, "live");
  assert.equal(entry.version, 2);
  handle.release();
  assert.equal(existsSync(path), false);
  assert.equal(readHolder(path).state, "absent");
  handle.release();
}));

test("a live holder blocks acquire with a message naming pid, host, scope, and the leases command", async () => withDir(async (dir) => {
  const { acquireHolder } = await load();
  const path = join(dir, "t1.lease");
  const first = acquireHolder({ path, kind: "lease", scope: "task:t1", activity: "turn", heartbeatMs: 0, command: "loop.mjs run t1" });
  try {
    assert.throws(() => acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0 }), (error: any) => {
      assert.equal(error.code, "HOLDER_BUSY");
      assert.match(error.message, new RegExp(`lease task:t1 is held by pid ${process.pid} on ${hostname()} \\(loop.mjs run t1, turn\\)`));
      assert.match(error.message, /expires .*Inspect: node \.agents\/aidlc\/scripts\/loop-entry\.mjs leases/);
      return true;
    });
    assert.throws(() => acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0, busyMessage: () => "custom busy" }), /custom busy/);
  } finally { first.release(); }
}));

test("expired and dead-pid holders are stale and reclaimed with a warning", async () => withDir(async (dir) => {
  const { acquireHolder, readHolder } = await load();
  const path = join(dir, "t1.lease");
  // Expired even though the pid (this process) is alive: a recycled pid no longer keeps a holder live.
  writeFileSync(path, JSON.stringify(v2({ expiresAt: new Date(Date.now() - 1000).toISOString() })));
  assert.equal(readHolder(path).state, "stale");
  assert.match(readHolder(path).reason, /expired/);
  const warnings: any[] = [];
  let handle = acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0, onWarning: (w: any) => warnings.push(w) });
  assert.equal(warnings[0]?.type, "holder_reclaimed");
  assert.equal(warnings[0]?.previous.token, "other-token");
  handle.release();
  // Dead pid on this host, not yet expired.
  writeFileSync(path, JSON.stringify(v2({ pid: DEAD_PID })));
  assert.equal(readHolder(path).state, "stale");
  assert.match(readHolder(path).reason, /not running/);
  handle = acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0 });
  handle.release();
}));

test("a holder on another host is judged by TTL only", async () => withDir(async (dir) => {
  const { readHolder } = await load();
  const path = join(dir, "t1.lease");
  writeFileSync(path, JSON.stringify(v2({ pid: DEAD_PID, host: `${hostname()}-elsewhere` })));
  assert.equal(readHolder(path).state, "live");
  writeFileSync(path, JSON.stringify(v2({ pid: DEAD_PID, host: `${hostname()}-elsewhere`, expiresAt: new Date(Date.now() - 1).toISOString() })));
  assert.equal(readHolder(path).state, "stale");
}));

test("v1 holder files are read with pid-only liveness and replaced by v2", async () => withDir(async (dir) => {
  const { acquireHolder, readHolder } = await load();
  const path = join(dir, "t1.lease");
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, taskId: "t1", runId: "r", pid: process.pid, token: "v1", createdAt: new Date(0).toISOString() }));
  assert.equal(readHolder(path).state, "live");
  assert.equal(readHolder(path).version, 1);
  assert.throws(() => acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0 }), /held by pid/);
  writeFileSync(path, JSON.stringify({ pid: DEAD_PID, token: "v1-lock" }));
  assert.equal(readHolder(path).state, "stale");
  const handle = acquireHolder({ path, kind: "lock", scope: "assignments:t1" });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 2);
  handle.release();
}));

test("a recent corrupt file fails closed with path, age, and clear-stale command; an old one is reclaimed", async () => withDir(async (dir) => {
  const { acquireHolder, readHolder } = await load();
  const path = join(dir, "t1.lease");
  writeFileSync(path, "{not json");
  assert.equal(readHolder(path).state, "corrupt");
  assert.throws(() => acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0 }), (error: any) => {
    assert.equal(error.code, "HOLDER_CORRUPT");
    assert.ok(error.message.includes(`Corrupt lease file ${path} (modified `));
    assert.match(error.message, /leases --clear-stale/);
    return true;
  });
  const old = (Date.now() - 120000) / 1000;
  utimesSync(path, old, old);
  assert.equal(readHolder(path).reclaimable, true);
  const warnings: any[] = [];
  const handle = acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0, onWarning: (w: any) => warnings.push(w) });
  assert.equal(warnings[0]?.type, "holder_reclaimed");
  handle.release();
}));

test("heartbeat and setActivity renew the holder; takeover makes assertOwned fail", async () => withDir(async (dir) => {
  const { acquireHolder } = await load();
  const path = join(dir, "t1.lease");
  const handle = acquireHolder({ path, kind: "lease", scope: "task:t1", activity: "waiting", heartbeatMs: 0 });
  const before = JSON.parse(readFileSync(path, "utf8"));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(handle.heartbeat(), true);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Date.parse(after.expiresAt) > Date.parse(before.expiresAt));
  assert.equal(after.startedAt, before.startedAt);
  handle.setActivity("turn");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).activity, "turn");
  assert.equal(handle.holder().activity, "turn");
  handle.assertOwned();
  // Expired but still ours: assertOwned renews instead of failing.
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), expiresAt: new Date(Date.now() - 1).toISOString() }));
  handle.assertOwned();
  assert.ok(Date.parse(JSON.parse(readFileSync(path, "utf8")).expiresAt) > Date.now());
  // Another process took over.
  writeFileSync(path, JSON.stringify(v2({ pid: process.pid, token: "intruder" })));
  assert.throws(() => handle.assertOwned(), /lease ownership lost: lease task:t1 was taken over/);
  assert.equal(handle.heartbeat(), false);
  handle.release();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "intruder");
}));

test("guard: an abandoned guard is removed and a live guard times out with a remedy", async () => withDir(async (dir) => {
  const { withHolderGuard } = await load();
  const path = join(dir, "daemon.lock");
  writeFileSync(`${path}.guard`, JSON.stringify({ pid: DEAD_PID, token: "g" }));
  assert.equal(withHolderGuard(path, () => 7), 7);
  assert.equal(existsSync(`${path}.guard`), false);
  // Legacy daemon guard content was a bare pid; an old guard is abandoned regardless of pid.
  writeFileSync(`${path}.guard`, String(process.pid));
  const old = (Date.now() - 20000) / 1000;
  utimesSync(`${path}.guard`, old, old);
  assert.equal(withHolderGuard(path, () => 8), 8);
  writeFileSync(`${path}.guard`, JSON.stringify({ pid: process.pid, token: "live" }));
  assert.throws(() => withHolderGuard(path, () => 9, { waitMs: 50 }), /Timed out waiting for holder guard .*leases --clear-stale/);
}));

test("clearStaleHolder removes only stale or old corrupt holders", async () => withDir(async (dir) => {
  const { acquireHolder, clearStaleHolder } = await load();
  const path = join(dir, "t1.lease");
  const handle = acquireHolder({ path, kind: "lease", scope: "task:t1", heartbeatMs: 0 });
  assert.equal(clearStaleHolder(path), null);
  assert.equal(existsSync(path), true);
  handle.release();
  writeFileSync(path, JSON.stringify(v2({ pid: DEAD_PID })));
  assert.equal(clearStaleHolder(path)?.state, "stale");
  assert.equal(existsSync(path), false);
  writeFileSync(path, "");
  assert.equal(clearStaleHolder(path), null);
  assert.equal(existsSync(path), true);
}));

test("a lock waits for a holder in another process to release", async () => withDir(async (dir) => {
  const { acquireHolder } = await load();
  const path = join(dir, "t1.lock");
  const ready = join(dir, "ready");
  const child = runChild(`
    import { writeFileSync } from "node:fs";
    const { acquireHolder } = await import(${JSON.stringify(modulePath)});
    const h = acquireHolder({ path: ${JSON.stringify(path)}, kind: "lock", scope: "assignments:t1" });
    writeFileSync(${JSON.stringify(ready)}, "1");
    setTimeout(() => { h.release(); }, 300);
  `);
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(ready));
  assert.throws(() => acquireHolder({ path, kind: "lock", scope: "assignments:t1" }), (e: any) => e.code === "HOLDER_BUSY");
  const handle = acquireHolder({ path, kind: "lock", scope: "assignments:t1", waitMs: 4000 });
  handle.release();
  assert.equal((await child).code, 0);
}));

test("concurrent acquirers racing to reclaim a stale lease: exactly one wins", async () => withDir(async (dir) => {
  const path = join(dir, "t1.lease");
  writeFileSync(path, JSON.stringify(v2({ pid: DEAD_PID })));
  const code = `
    const { acquireHolder } = await import(${JSON.stringify(modulePath)});
    try {
      const h = acquireHolder({ path: ${JSON.stringify(path)}, kind: "lease", scope: "task:t1", heartbeatMs: 0 });
      process.stdout.write("won:" + h.token);
      await new Promise((r) => setTimeout(r, 800));
    } catch (error) { process.stdout.write(error.code === "HOLDER_BUSY" ? "busy" : "error:" + error.message); }
  `;
  const results = await Promise.all(Array.from({ length: 6 }, () => runChild(code)));
  const outputs = results.map((r) => r.stdout);
  const winners = outputs.filter((o) => o.startsWith("won:"));
  assert.equal(winners.length, 1, outputs.join(" | "));
  assert.equal(outputs.filter((o) => o === "busy").length, 5, outputs.join(" | "));
}));

test("explainFleetConflict explains lease/claim conflicts and keeps the original text", async () => {
  const { explainFleetConflict } = await load();
  const explained = explainFleetConflict("stale or expired lead claim");
  assert.match(explained, /^Fleet conflict: the lead lease \(run_claim\) is no longer valid/);
  assert.match(explained, /Inspect: node \.agents\/aidlc\/scripts\/loop-entry\.mjs leases \(stale or expired lead claim\)$/);
  assert.equal(explainFleetConflict(explained), explained);
  assert.match(explainFleetConflict("expired job lease requires lead reconciliation"), /lead must reconcile/);
  assert.equal(explainFleetConflict("fleet revision conflict"), "fleet revision conflict");
});

test("a failed setActivity keeps the requested activity and the next heartbeat writes it", async () => withDir(async (dir) => {
  const { acquireHolder } = await load();
  const path = join(dir, "t1.lease");
  const handle = acquireHolder({ path, kind: "lease", scope: "task:t1", activity: "turn", heartbeatMs: 0 });
  // A live guard held by someone else makes the write time out after 5s.
  writeFileSync(`${path}.guard`, JSON.stringify({ pid: process.pid, token: "busy" }));
  assert.throws(() => handle.setActivity("waiting"), /Timed out waiting for holder guard/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).activity, "turn");
  rmSync(`${path}.guard`);
  assert.equal(handle.heartbeat(), true);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).activity, "waiting");
  handle.release();
}));

test("onLost fires once when a heartbeat finds the holder taken over", async () => withDir(async (dir) => {
  const { acquireHolder } = await load();
  const path = join(dir, "daemon.lock");
  const reasons: string[] = [];
  const handle = acquireHolder({ path, kind: "lease", scope: "daemon", heartbeatMs: 0, onLost: (reason: string) => reasons.push(reason) });
  writeFileSync(path, JSON.stringify(v2({ scope: "daemon", token: "other" })));
  assert.equal(handle.heartbeat(), false);
  assert.equal(handle.heartbeat(), false);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0] ?? "", /lease daemon was taken over/);
  handle.release();
  assert.equal(reasons.length, 1, "release does not report a loss");
}));
