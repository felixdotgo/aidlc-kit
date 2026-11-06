import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet-supervisor.mjs"));
const task = { id: "T1", phase: "plan", gate: "G1_review", status: "active", evidence: [] };

test("fleet supervisor binds a fresh run claim to the current task", async () => {
  const { runFleetSupervisor } = await load(); const calls: string[] = [];
  const repository = {
    claimSupervisor: async () => { calls.push("supervisor"); }, renewSupervisor: async () => { calls.push("renew"); }, releaseSupervisor: async () => { calls.push("release"); },
    readGateCheckpoint: async () => null, readTask: async () => ({ task, revision: 2, nextAction: { classification: "run_phase" } }),
    claimLead: async (args: any) => { assert.equal(args.expectedStateRevision, 2); assert.match(args.expectedTaskDigest, /^[a-f0-9]{64}$/); calls.push("run"); return { epoch: 9 }; }
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1", coordinator: async ({ claimedLead }: any) => { assert.equal(claimedLead.epoch, 9); calls.push("coordinator"); return { status: "blocked" }; } });
  assert.equal(result.status, "blocked"); assert.deepEqual(calls, ["supervisor", "renew", "run", "coordinator", "release"]);
});

test("fleet supervisor refuses an uncertain consumed checkpoint", async () => {
  const { runFleetSupervisor } = await load(); let claimed = false;
  const repository = { claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {}, readGateCheckpoint: async () => ({ status: "consumed" }), readTask: async () => ({ task, revision: 2, nextAction: { classification: "run_phase" } }), claimLead: async () => { claimed = true; } };
  const result = await runFleetSupervisor({ repository, taskId: "T1" });
  assert.equal(result.status, "blocked"); assert.equal(claimed, false);
});

test("fleet supervisor re-reads instead of blocking when the approval lands between its two reads", async () => {
  const { runFleetSupervisor } = await load();
  const approvedCheckpoint = { status: "approved", gate: "G0_confirm", snapshotId: "snap-1", approvalRevision: 3, taskDigest: "0".repeat(64) };
  let reads = 0;
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {},
    readGateCheckpoint: async () => approvedCheckpoint,
    readTask: async () => {
      reads += 1;
      // First read predates the atomic reviewer approval; the second sees it.
      if (reads === 1) return { task: { ...task, phase: "clarify", status: "blocked_on_user" }, revision: 2, nextAction: { classification: "await_user", gate: "G0_confirm" } };
      return { task: { ...task, phase: "plan" }, revision: 3, nextAction: { classification: "run_phase" } };
    },
    claimLead: async (args: any) => { assert.equal(args.expectedStateRevision, 3); return { epoch: 4 }; }
  };
  const events: any[] = [];
  const result = await runFleetSupervisor({ repository, taskId: "T1", onEvent: (event: any) => events.push(event), coordinator: async () => ({ status: "complete", taskId: "T1" }) });
  assert.equal(result.status, "complete");
  assert.equal(reads, 2);
  assert.ok(events.some((event) => event.type === "resync"));
});

test("fleet supervisor resumes a rejected checkpoint when the task is active at the same gate", async () => {
  const { runFleetSupervisor } = await load();
  const rejectedCheckpoint = { status: "rejected", gate: "G0_confirm", phase: "clarify", snapshotId: "snap-1" };
  let claimArgs: any = null, coordinated = false;
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {},
    readGateCheckpoint: async () => rejectedCheckpoint,
    readTask: async () => ({ task: { ...task, phase: "clarify", gate: "G0_confirm", status: "active" }, revision: 2, nextAction: { classification: "run_phase" } }),
    claimLead: async (args: any) => { claimArgs = args; return { epoch: 5 }; }
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1", coordinator: async () => { coordinated = true; return { status: "complete", taskId: "T1" }; } });
  assert.equal(result.status, "complete");
  assert.ok(claimArgs);
  assert.equal(claimArgs.expectedStateRevision, 2);
  assert.equal(coordinated, true);
});

test("fleet supervisor blocks a rejected checkpoint that does not match an active same-gate task", async () => {
  const { runFleetSupervisor } = await load();
  const rejectedCheckpoint = { status: "rejected", gate: "G0_confirm", phase: "clarify", snapshotId: "snap-1" };
  let claimed = false;
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {},
    readGateCheckpoint: async () => rejectedCheckpoint,
    readTask: async () => ({ task: { ...task, phase: "clarify", gate: "G0_confirm", status: "blocked_on_user" }, revision: 2, nextAction: { classification: "await_user", gate: "G0_confirm" } }),
    claimLead: async () => { claimed = true; return { epoch: 5 }; }
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1" });
  assert.equal(result.status, "blocked");
  assert.equal(claimed, false);
});

const gateTask = { ...task, phase: "clarify", gate: "G0_confirm" };
const digestOf = async (value: unknown) => (await import("node:crypto")).createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("untilStop returns the published gate instead of waiting and releases the supervisor", async () => {
  const { runFleetSupervisor } = await load(); const calls: string[] = []; const events: any[] = [];
  let checkpoint: any = null; let current: any = { ...gateTask, status: "active" };
  const repository = {
    claimSupervisor: async () => { calls.push("supervisor"); }, renewSupervisor: async () => {}, releaseSupervisor: async () => { calls.push("release"); },
    readGateCheckpoint: async () => { calls.push("checkpoint"); return checkpoint; },
    readTask: async () => ({ task: current, revision: 2, nextAction: current.status === "active" ? { classification: "run_phase" } : { classification: "await_user", gate: "G0_confirm" } }),
    claimLead: async () => { calls.push("run"); return { epoch: 3 }; }
  };
  const coordinator = async () => {
    current = { ...current, status: "blocked_on_user" };
    checkpoint = { status: "pending", gate: "G0_confirm", snapshotId: "snap-1", taskDigest: await digestOf(current) };
    return { status: "gate", taskId: "T1", gate: "G0_confirm", snapshotId: "snap-1", revision: 2, gateView: "Review" };
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1", pollMs: 1, untilStop: true, onEvent: (event: any) => events.push(event), coordinator });
  assert.deepEqual(result, { status: "gate", taskId: "T1", gate: "G0_confirm", snapshotId: "snap-1", gateView: "Review" });
  assert.deepEqual(calls, ["supervisor", "checkpoint", "run", "release"]);
  assert.ok(events.some((event) => event.type === "gate" && event.snapshotId === "snap-1"));
  assert.ok(!events.some((event) => event.type === "waiting"));
});

test("untilStop returns waiting for a pending checkpoint without claiming the run", async () => {
  const { runFleetSupervisor } = await load(); let claimed = false, released = false;
  const blocked = { ...gateTask, status: "blocked_on_user" };
  const checkpoint = { status: "pending", gate: "G0_confirm", snapshotId: "snap-1", taskDigest: await digestOf(blocked) };
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => { released = true; },
    readGateCheckpoint: async () => checkpoint,
    readTask: async () => ({ task: blocked, revision: 2, nextAction: { classification: "await_user", gate: "G0_confirm" } }),
    claimLead: async () => { claimed = true; }
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1", pollMs: 1, untilStop: true });
  assert.deepEqual(result, { status: "waiting", taskId: "T1", gate: "G0_confirm", snapshotId: "snap-1" });
  assert.equal(claimed, false); assert.equal(released, true);
});

test("a fresh untilStop supervisor resumes an approved checkpoint through claimLead", async () => {
  const { runFleetSupervisor } = await load(); let claimArgs: any = null;
  const checkpoint = { status: "approved", gate: "G0_confirm", snapshotId: "snap-1", approvalRevision: 3 };
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {},
    readGateCheckpoint: async () => checkpoint,
    readTask: async () => ({ task: { ...gateTask, phase: "plan", gate: null, status: "active" }, revision: 3, nextAction: { classification: "run_phase" } }),
    claimLead: async (args: any) => { claimArgs = args; return { epoch: 6 }; }
  };
  const result = await runFleetSupervisor({ repository, taskId: "T1", untilStop: true, coordinator: async ({ claimedLead }: any) => ({ status: "complete", taskId: "T1", epoch: claimedLead.epoch }) });
  assert.equal(result.status, "complete"); assert.equal(result.epoch, 6);
  assert.equal(claimArgs.checkpoint, checkpoint); assert.equal(claimArgs.expectedStateRevision, 3);
});

test("supervisor stop signal reaches the coordinator as a turn-boundary stop, not a turn abort", async () => {
  const { runFleetSupervisor } = await load();
  const stop = new AbortController(), cancel = new AbortController();
  const repository = {
    claimSupervisor: async () => {}, renewSupervisor: async () => {}, releaseSupervisor: async () => {},
    readGateCheckpoint: async () => null, readTask: async () => ({ task, revision: 2, nextAction: { classification: "run_phase" } }), claimLead: async () => ({ epoch: 1 })
  };
  let seen: any;
  const result = await runFleetSupervisor({ repository, taskId: "T1", signal: stop.signal, cancelSignal: cancel.signal, coordinator: async (options: any) => { seen = options; stop.abort(); return { status: "stopped", taskId: "T1" }; } });
  assert.equal(result.status, "stopped");
  assert.equal(seen.stopSignal, stop.signal); assert.equal(seen.cancelSignal, cancel.signal);
  assert.equal(seen.supervisorSignal.aborted, false, "a stop request must not abort the in-flight turn");
});
