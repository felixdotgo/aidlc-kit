import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-supervisor.mjs"));
const waiting = (revision = 2) => ({ revision, task: { id: "task-a", phase: "clarify", gate: "G0_confirm", status: "blocked_on_user", evidence: [] }, nextAction: { classification: "await_user", gate: "G0_confirm" } });
const approved = (revision = 3) => ({ revision, task: { id: "task-a", phase: "plan", gate: "G1_review", status: "active", evidence: [{ kind: "approval", gate: "G0_confirm", result: "pass", source: "yes" }] }, nextAction: { classification: "run_phase" } });

test("gate requires new matching approval and exact checkpoint evidence", async () => {
  const { makeGateCheckpoint, checkGateCheckpoint } = await load();
  const checkpoint = makeGateCheckpoint({ taskId: "task-a", authority: "local", snapshot: waiting(), result: { gate: "G0_confirm" } });
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: waiting() })).status, "wait");
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: approved() })).status, "resume");
  const stale = approved(); stale.task.evidence[0].gate = "G1_review";
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: stale })).status, "blocked");
  const paused = approved(); paused.task.status = "paused";
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: paused })).status, "blocked");
  const previous: any = waiting(); previous.task.evidence.push({ kind: "approval", gate: "G0_confirm", result: "pass", source: "old" });
  const earlier = makeGateCheckpoint({ taskId: "task-a", authority: "local", snapshot: previous, result: { gate: "G0_confirm" } });
  assert.equal((await checkGateCheckpoint({ checkpoint: earlier, snapshot: approved() })).status, "blocked");
});

test("fleet requires an approval event for the exact snapshot and a newer revision", async () => {
  const { makeGateCheckpoint, checkGateCheckpoint } = await load();
  const checkpoint = makeGateCheckpoint({ taskId: "task-a", authority: "fleet", snapshot: waiting(), result: { gate: "G0_confirm", snapshotId: "snapshot-a" } });
  await assert.rejects(checkGateCheckpoint({ checkpoint, snapshot: approved() }), /verifyFleetApproval/);
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: approved(), verifyFleetApproval: async () => false })).status, "blocked");
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: approved(2), verifyFleetApproval: async () => true })).status, "blocked");
  const changed: any = waiting(); changed.task.evidence.push({ kind: "diagnostic", result: "pass", source: "change" });
  assert.equal((await checkGateCheckpoint({ checkpoint, snapshot: changed, verifyFleetApproval: async () => true })).status, "blocked");
  const result = await checkGateCheckpoint({ checkpoint, snapshot: approved(), verifyFleetApproval: async ({ checkpoint: c }: any) => c.snapshotId === "snapshot-a" });
  assert.equal(result.status, "resume"); assert.equal(result.precondition.revision, 3);
});

test("supervisor persists gate, releases runner to approve, and resumes with a fenced precondition", async () => {
  const { runSupervisor } = await load();
  let canonical: any = { ...waiting(), task: { ...waiting().task, status: "active" }, nextAction: { classification: "run_phase" } };
  let checkpoint: any = null, calls = 0, release = 0;
  const events: string[] = [];
  const result = await runSupervisor({ taskId: "task-a", authority: "local", pollMs: 1,
    acquireSupervisor: async () => ({ assertOwned: async () => {}, release: async () => { release++; } }),
    readTask: async () => canonical,
    loadCheckpoint: async () => checkpoint,
    saveCheckpoint: async ({ checkpoint: value }: any) => { checkpoint = value; },
    clearCheckpoint: async () => { checkpoint = null; },
    onEvent: async ({ type }: any) => { events.push(type); canonical = approved(); },
    runTurn: async ({ precondition }: any) => { calls++; if (calls === 1) { canonical = waiting(); return { status: "gate", gate: "G0_confirm" }; } assert.equal(precondition.gate, "G0_confirm"); assert.equal(typeof precondition.taskHash, "string"); return { status: "complete", taskId: "task-a" }; }
  });
  assert.equal(result.status, "complete"); assert.equal(calls, 2); assert.deepEqual(events, ["gate"]); assert.equal(release, 1); assert.equal(checkpoint, null);
});

test("checkpoint recovery rejects changed phase, ownership mismatch and missing checkpoint", async () => {
  const { runSupervisor, makeGateCheckpoint } = await load();
  const checkpoint = makeGateCheckpoint({ taskId: "task-a", authority: "local", snapshot: waiting(), result: { gate: "G0_confirm" } });
  let calls = 0, release = 0;
  const common: any = { taskId: "task-a", authority: "local", pollMs: 1, acquireSupervisor: async () => ({ assertOwned: async () => {}, release: async () => { release++; } }), readTask: async () => waiting(), runTurn: async () => { calls++; }, loadCheckpoint: async () => null, saveCheckpoint: async () => {}, clearCheckpoint: async () => {} };
  const missing = await runSupervisor(common);
  assert.equal(missing.status, "blocked"); assert.match(missing.reason, /checkpoint missing/); assert.equal(calls, 0);
  await assert.rejects(runSupervisor({ ...common, loadCheckpoint: async () => ({ ...checkpoint, authority: "fleet" }) }), /mismatch/);
  const changed = { ...approved(), task: { ...approved().task, phase: "build" } };
  const stale = await runSupervisor({ ...common, loadCheckpoint: async () => checkpoint, readTask: async () => changed });
  assert.equal(stale.status, "blocked"); assert.equal(calls, 0); assert.equal(release, 3);
});

test("restart after approval uses persisted gate; ownership loss prevents a turn", async () => {
  const { runSupervisor, makeGateCheckpoint } = await load();
  const checkpoint = makeGateCheckpoint({ taskId: "task-a", authority: "local", snapshot: waiting(), result: { gate: "G0_confirm" } });
  let calls = 0, released = false;
  const common: any = { taskId: "task-a", authority: "local", loadCheckpoint: async () => checkpoint, readTask: async () => approved(), saveCheckpoint: async () => {}, clearCheckpoint: async () => {}, runTurn: async ({ precondition }: any) => { calls++; assert.equal(precondition.gate, "G0_confirm"); return { status: "complete" }; } };
  const result = await runSupervisor({ ...common, acquireSupervisor: async () => ({ assertOwned: async () => {}, release: async () => { released = true; } }) });
  assert.equal(result.status, "complete"); assert.equal(calls, 1); assert.equal(released, true);
  await assert.rejects(runSupervisor({ ...common, acquireSupervisor: async () => ({ assertOwned: async () => { throw new Error("lost lease"); }, release: async () => {} }) }), /lost lease/);
  assert.equal(calls, 1);
});
