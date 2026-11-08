import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-worker-log.mjs"));
function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "aidlc-worker-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const workersDir = (root: string) => join(root, ".agents/data/tasks/task-a/runtime/workers");
const readIndex = (root: string) => JSON.parse(readFileSync(join(workersDir(root), "index.json"), "utf8"));
const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
const ids = { taskId: "task-a", assignmentId: "assignment-1", itemId: "T1", workerId: "worker-a", agent: "codex", mode: "local" as const };

test("worker log records index entries and tees stdout and stderr verbatim", async (t) => {
  const root = fixture(t), { openWorkerLog } = await load();
  const log = openWorkerLog({ root, ...ids });
  log.turnStart("aidlc-worker-one", 1);
  const [entry] = readIndex(root);
  assert.equal(entry.name, "aidlc-worker-one"); assert.equal(entry.assignmentId, "assignment-1"); assert.equal(entry.itemId, "T1");
  assert.equal(entry.workerId, "worker-a"); assert.equal(entry.agent, "codex"); assert.equal(entry.mode, "local"); assert.equal(entry.host, hostname());
  assert.equal(entry.turn, 1); assert.match(entry.startedAt, /^\d{4}-/); assert.equal(entry.log, "assignment-1.log");
  assert.equal("endedAt" in entry, false); assert.equal("exitCode" in entry, false);
  const child = fakeChild();
  assert.equal(log.tee(child), child);
  child.stdout.write('{"type":"thread.started"}\n');
  child.stderr.write("warning: raw stderr\n");
  child.stdout.write(Buffer.from([0xe2, 0x9c, 0x93, 0x0a]));
  log.turnEnd(0);
  log.turnStart("aidlc-worker-two", 2);
  log.turnEnd(null);
  log.close();
  const text = readFileSync(join(workersDir(root), "assignment-1.log"), "utf8");
  assert.match(text, /^--- turn 1 container aidlc-worker-one \d{4}-\d{2}-\d{2}T[^ ]+ ---\n\{"type":"thread.started"\}\nwarning: raw stderr\n✓\n--- end turn 1 container aidlc-worker-one exit 0 [^ ]+ ---\n--- turn 2 container aidlc-worker-two [^ ]+ ---\n--- end turn 2 container aidlc-worker-two exit signal [^ ]+ ---\n$/);
  const entries = readIndex(root);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].exitCode, 0); assert.match(entries[0].endedAt, /^\d{4}-/);
  assert.equal(entries[1].name, "aidlc-worker-two"); assert.equal(entries[1].turn, 2); assert.equal(entries[1].exitCode, null);
  // Entries of further assignments of the same task share the index.
  const second = openWorkerLog({ root, ...ids, assignmentId: "assignment-2", mode: "fleet" });
  second.turnStart("aidlc-worker-three", 1); second.close();
  const all = readIndex(root);
  assert.equal(all.length, 3); assert.equal(all[2].mode, "fleet"); assert.equal(all[2].log, "assignment-2.log");
  assert.equal(all[2].exitCode, null, "close() ends a dangling turn");
});

test("worker log rotates at the size cap and tolerates a corrupt index", async (t) => {
  const root = fixture(t), { openWorkerLog, readWorkerIndex } = await load();
  mkdirSync(workersDir(root), { recursive: true });
  const indexPath = join(workersDir(root), "index.json");
  writeFileSync(indexPath, "{not json");
  assert.deepEqual(readWorkerIndex(root, "task-a"), []);
  const log = openWorkerLog({ root, ...ids, maxBytes: 400 });
  log.turnStart("aidlc-worker-one", 1);
  assert.equal(readIndex(root).length, 1, "corrupt index is replaced");
  const child = fakeChild(); log.tee(child);
  child.stdout.write("a".repeat(150) + "\n");
  child.stdout.write("b".repeat(150) + "\n");
  log.close();
  const current = readFileSync(join(workersDir(root), "assignment-1.log"), "utf8"), rotated = readFileSync(join(workersDir(root), "assignment-1.log.1"), "utf8");
  // Header (~64 B) + two 151 B chunks fit in 400 B; the trailer would exceed it,
  // so the file rotates to `.1` (one generation) and the trailer starts a fresh file.
  assert.match(rotated, /^--- turn 1 container aidlc-worker-one [^ ]+ ---\na{150}\nb{150}\n$/);
  assert.match(current, /^--- end turn 1 container aidlc-worker-one exit signal [^ ]+ ---\n$/);
  assert.ok(Buffer.byteLength(rotated) <= 400);
  // A further rotation overwrites the single kept generation.
  const again = openWorkerLog({ root, ...ids, maxBytes: 400 });
  again.turnStart("aidlc-worker-two", 2);
  const next = fakeChild(); again.tee(next); next.stdout.write("c".repeat(300) + "\n"); again.close();
  assert.match(readFileSync(join(workersDir(root), "assignment-1.log.1"), "utf8"), /^--- end turn 1 [^\n]+\n--- turn 2 container aidlc-worker-two [^ ]+ ---\n$/);
  assert.match(readFileSync(join(workersDir(root), "assignment-1.log"), "utf8"), /^c{300}\n--- end turn 2 /);
  // Index keeps at most 500 entries, dropping the oldest.
  const busy = openWorkerLog({ root, ...ids, assignmentId: "assignment-9" });
  for (let i = 0; i < 505; i++) busy.turnStart(`aidlc-worker-${i}`, i + 1);
  busy.close();
  const entries = readIndex(root);
  assert.equal(entries.length, 500); assert.equal(entries[0].name, "aidlc-worker-5"); assert.equal(entries[499].name, "aidlc-worker-504");
});
test("worker log rejects invalid ids, bad modes, and symlinked paths; write errors surface once", async (t) => {
  const root = fixture(t), { openWorkerLog } = await load();
  assert.throws(() => openWorkerLog({ root, ...ids, taskId: "../escape" }), /Invalid task id/);
  assert.throws(() => openWorkerLog({ root, ...ids, assignmentId: "a/b" }), /Invalid assignment id/);
  assert.throws(() => openWorkerLog({ root, ...ids, itemId: "" }), /Invalid item id/);
  assert.throws(() => openWorkerLog({ root, ...ids, workerId: "w x" }), /Invalid worker id/);
  assert.throws(() => openWorkerLog({ root, ...ids, mode: "remote" }), /mode/);
  assert.throws(() => openWorkerLog({ root: "", ...ids }), /root/);
  // A planted symlink anywhere on the path is refused; the failure is reported once and never thrown.
  mkdirSync(join(root, ".agents/data/tasks/task-a"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(root, ".agents/data/tasks/task-a/runtime"));
  const errors: Error[] = [];
  const log = openWorkerLog({ root, ...ids, onError: (error: Error) => errors.push(error) });
  log.turnStart("aidlc-worker-one", 1);
  const child = fakeChild(); log.tee(child); child.stdout.write("x\n"); child.stderr.write("y\n");
  log.turnEnd(0); log.close();
  assert.equal(errors.length, 1); assert.match(errors[0]!.message, /symlink/);
  assert.equal(existsSync(join(root, "elsewhere", "workers")), false);
  // Invalid container names or turns are reported, not thrown.
  const bad: Error[] = [];
  const other = openWorkerLog({ root, ...ids, taskId: "task-b", onError: (error: Error) => bad.push(error) });
  other.turnStart("bad name", 1); other.turnStart("aidlc-worker-one", -1); other.close();
  assert.equal(bad.length, 1);
  assert.equal(existsSync(join(root, ".agents/data/tasks/task-b/runtime/workers/index.json")), false);
});
