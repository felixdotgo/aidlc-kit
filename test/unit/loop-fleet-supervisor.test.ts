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
