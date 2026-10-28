import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet.mjs"));
const task = (status = "todo") => ({ id: "task-a", phase: "build", tasks: [{ id: "T1", status, dependsOn: [] }] });
const action = { classification: "run_phase", phase: "build", itemId: "T1" };

test("coordinator schedules dependency-ready work under a fenced lead claim", async () => {
  const { runFleetCoordinator } = await load();
  const calls: string[] = [];
  let scheduled = false;
  const repository = {
    readTask: async () => ({ task: task(), nextAction: scheduled ? { classification: "await_user", gate: "G2_codereview" } : action, revision: 3 }),
    claimLead: async () => { calls.push("claim"); return { epoch: 7 }; },
    renewLead: async () => { calls.push("renew"); },
    releaseLead: async ({ epoch }: any) => { assert.equal(epoch, 7); calls.push("release"); },
    listJobs: async () => [],
    scheduleJob: async (input: any) => { assert.equal(input.leadEpoch, 7); assert.equal(input.itemId, "T1"); calls.push("schedule"); scheduled = true; return { assignmentId: "job-a", itemId: "T1", state: "ready" }; },
    saveGateSnapshot: async ({ integrationCommit, gateView }: any) => { assert.equal(integrationCommit, "a".repeat(40)); assert.match(gateView, /Integration commit: a{40}/); return { snapshotId: "snap-a" }; }
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a", ownerId: "lead-a", workerIds: ["worker-a"], pollMs: 1, gateView: async () => "Review", handoff: { prepare: async () => ({ baseCommit: "abc", branch: "worker/T1", ownedPaths: ["src/a.ts"], agent: "codex" }), currentCommit: async () => "a".repeat(40) } });
  assert.equal(result.status, "gate");
  assert.deepEqual(calls, ["claim", "schedule", "release"]);
});

test("coordinator publishes gate snapshot and never runs agent or approval", async () => {
  const { runFleetCoordinator } = await load();
  let approved = false;
  const repository = {
    readTask: async () => ({ task: task(), nextAction: { classification: "await_user", gate: "G1_review" }, revision: 4 }),
    claimLead: async () => ({ epoch: 9 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [], scheduleJob: async () => {},
    saveGateSnapshot: async (input: any) => { assert.equal(input.expectedRevision, 4); assert.equal(input.leadEpoch, 9); return { snapshotId: "snap-a" }; },
    approveGate: async () => { approved = true; }
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a", gateView: async () => "Human review G1" });
  assert.equal(result.status, "gate"); assert.equal(result.snapshotId, "snap-a"); assert.equal(approved, false);
});

test("G0 and G1 each stop for separate reviewer approval before the next phase", async () => {
  const { runFleetCoordinator } = await load();
  let phase: "clarify" | "plan" = "clarify";
  const seen: string[] = [];
  const repository = {
    readTask: async () => ({ task: { ...task(), phase }, nextAction: { classification: "await_user", gate: phase === "clarify" ? "G0_confirm" : "G1_review" }, revision: phase === "clarify" ? 1 : 2 }),
    claimLead: async () => ({ epoch: phase === "clarify" ? 1 : 2 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [], scheduleJob: async () => {},
    saveGateSnapshot: async ({ gate, expectedRevision }: any) => { seen.push(`${gate}:${expectedRevision}`); return { snapshotId: `snapshot-${gate}` }; },
    approveGate: async () => { throw new Error("coordinator must not approve"); }
  };
  const first = await runFleetCoordinator({ repository, taskId: "task-a", gateView: async () => "Confirm requirements" });
  assert.equal(first.gate, "G0_confirm");
  // A later reviewer action changes canonical state outside the coordinator.
  phase = "plan";
  const second = await runFleetCoordinator({ repository, taskId: "task-a", gateView: async () => "Approve plan" });
  assert.equal(second.gate, "G1_review");
  assert.deepEqual(seen, ["G0_confirm:1", "G1_review:2"]);
});

test("a released lead can claim again with a fresh idempotency key", async () => {
  const { runFleetCoordinator } = await load();
  const keys: string[] = [];
  const repository = {
    readTask: async () => ({ task: task(), nextAction: { classification: "await_user", gate: "G0_confirm" }, revision: 1 }),
    claimLead: async ({ idempotencyKey }: any) => { keys.push(idempotencyKey); return { epoch: keys.length }; },
    renewLead: async () => {}, releaseLead: async () => {}, listJobs: async () => [], scheduleJob: async () => {}, saveGateSnapshot: async () => ({ snapshotId: "snap" })
  };
  await runFleetCoordinator({ repository, taskId: "task-a", ownerId: "lead", gateView: async () => "G0" });
  await runFleetCoordinator({ repository, taskId: "task-a", ownerId: "lead", gateView: async () => "G0" });
  assert.equal(keys.length, 2); assert.notEqual(keys[0], keys[1]);
});

test("coordinator leaves overlapping owned paths for a later assignment", async () => {
  const { runFleetCoordinator } = await load();
  let scheduled = false;
  const repository = {
    readTask: async () => ({ task: task(), nextAction: action, revision: 3 }),
    claimLead: async () => ({ epoch: 7 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [], scheduleJob: async () => { scheduled = true; }, saveGateSnapshot: async () => {}
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a", workerIds: ["worker-a"], reservedJobs: [{ state: "leased", ownedPaths: ["src/"] }], handoff: { prepare: async () => ({ baseCommit: "abc", branch: "worker/T1", ownedPaths: ["src/a.ts"], agent: "codex" }) }, packet: async () => "phase", driver: async () => { throw new Error("no phase progress"); }, limits: { maxTurns: 1 } }).catch((error: Error) => error);
  assert.equal(scheduled, false);
  assert.match(String(result), /no phase progress/);
});

test("expired worker lease becomes uncertain before any redispatch", async () => {
  const { runFleetCoordinator } = await load();
  let scheduled = false;
  let reconciled = false;
  const repository = {
    readTask: async () => ({ task: task(), nextAction: action, revision: 5 }),
    claimLead: async () => ({ epoch: 10 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [{ taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 3, state: "leased", expiresAt: "2020-01-01T00:00:00Z" }],
    reconcileJob: async (input: any) => { assert.equal(input.leadEpoch, 10); assert.equal(input.decision, "uncertain"); reconciled = true; },
    scheduleJob: async () => { scheduled = true; }, saveGateSnapshot: async () => {}
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a" });
  assert.equal(result.status, "reconcile"); assert.equal(reconciled, true); assert.equal(scheduled, false);
});

test("offline worker pickup is bounded and leaves an uncertain assignment", async () => {
  const { runFleetCoordinator } = await load();
  let uncertain = false;
  const repository = {
    readTask: async () => ({ task: task(), nextAction: action, revision: 1 }),
    claimLead: async () => ({ epoch: 1 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [{ taskId: "task-a", itemId: "T1", assignmentId: "job-a", state: "ready", workerId: "worker-a", ownedPaths: ["src/a.ts"] }],
    scheduleJob: async () => { throw new Error("duplicate schedule"); },
    reconcileJob: async ({ decision }: any) => { assert.equal(decision, "uncertain"); uncertain = true; }, saveGateSnapshot: async () => {}
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a", workerIds: ["worker-a"], pollMs: 1, pickupTimeoutMs: 3 });
  assert.equal(result.status, "blocked"); assert.match(result.reason, /did not claim/); assert.equal(uncertain, true);
});

test("code-only retry requires quiescence and a confirmed absent pushed branch", async () => {
  const { reconcileFleetJobs } = await load();
  const now = Date.parse("2026-01-01T00:10:00Z");
  const job = { taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 2, state: "uncertain", uncertainAt: "2026-01-01T00:00:00Z" };
  let requeued = 0; const retryKeys: string[] = [];
  const repository = { listJobs: async () => [{ ...job }], reconcileJob: async ({ decision, idempotencyKey }: any) => { assert.equal(decision, "ready"); requeued++; retryKeys.push(idempotencyKey); } };
  const handoff = { recover: async () => ({ recovered: false, retryable: true, reason: "Assigned remote branch has no pushed commit" }) };
  const snapshot = { task: task(), nextAction: action, revision: 1 };
  const disabled = await reconcileFleetJobs({ repository, taskId: "task-a", leadEpoch: 3, snapshot, handoff, now, quiesceMs: 1000 });
  assert.equal(disabled.pending.length, 1); assert.equal(requeued, 0);
  const waiting = await reconcileFleetJobs({ repository, taskId: "task-a", leadEpoch: 3, snapshot, handoff, now, allowCodeOnlyRetry: true, quiesceMs: 700000 });
  assert.equal(waiting.pending[0].waitUntil, Date.parse(job.uncertainAt) + 700000); assert.equal(requeued, 0);
  const ready = await reconcileFleetJobs({ repository, taskId: "task-a", leadEpoch: 3, snapshot, handoff, now, allowCodeOnlyRetry: true, quiesceMs: 1000 });
  assert.equal(ready.pending.length, 0); assert.equal(ready.jobs[0].state, "ready"); assert.equal(requeued, 1);
  await reconcileFleetJobs({ repository, taskId: "task-a", leadEpoch: 3, snapshot, handoff, now, allowCodeOnlyRetry: true, quiesceMs: 1000 });
  assert.equal(requeued, 2); assert.notEqual(retryKeys[0], retryKeys[1]);
});

test("lost report after push is recovered, integrated, and canonically completed once", async () => {
  const { runFleetCoordinator } = await load();
  let done = false; let integrations = 0; let reconciled = false; let recoveredReport = false;
  const job: any = { taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 3, state: "uncertain", baseCommit: "a".repeat(40), branch: "worker/job-a", ownedPaths: ["src/a.ts"] };
  const repository = {
    readTask: async () => ({ task: task(done ? "done" : "todo"), nextAction: done ? { classification: "await_user", gate: "G2_codereview" } : action, revision: done ? 6 : 5 }),
    claimLead: async () => ({ epoch: 10 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [job], scheduleJob: async () => { throw new Error("duplicate schedule"); },
    recoverJob: async ({ commitSha, changedPaths }: any) => { assert.equal(commitSha, "b".repeat(40)); assert.deepEqual(changedPaths, ["src/a.ts"]); recoveredReport = true; job.state = "reported"; },
    reconcileJob: async ({ decision }: any) => { assert.equal(decision, "integrated"); assert.equal(job.state, "reported"); assert.equal(done, true); reconciled = true; job.state = "integrated"; },
    saveGateSnapshot: async () => ({ snapshotId: "snap-a" })
  };
  const handoff = {
    recover: async () => ({ recovered: true, valid: true, report: { commitSha: "b".repeat(40), changedPaths: ["src/a.ts"] } }),
    currentCommit: async () => "c".repeat(40),
    integrate: async ({ job: received }: any) => { assert.equal(received.report.commitSha, "b".repeat(40)); integrations++; return { integrationCommit: "c".repeat(40), commitSha: "b".repeat(40) }; }
  };
  const result = await runFleetCoordinator({ repository, taskId: "task-a", workerIds: ["worker-a"], handoff, completeItem: async () => { done = true; }, gateView: async () => "G2 review" });
  assert.equal(result.status, "gate"); assert.equal(integrations, 1); assert.equal(recoveredReport, true); assert.equal(reconciled, true);
});

test("restart after canonical completion finalizes an uncertain report without redispatch", async () => {
  const { runFleetCoordinator } = await load();
  let recovered = false; let integrated = false;
  const repository = {
    readTask: async () => ({ task: task("done"), nextAction: { classification: "await_user", gate: "G2_codereview" }, revision: 9 }),
    claimLead: async () => ({ epoch: 11 }), renewLead: async () => {}, releaseLead: async () => {},
    listJobs: async () => [{ taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 3, state: "uncertain" }],
    recoverJob: async ({ leadEpoch }: any) => { assert.equal(leadEpoch, 11); recovered = true; },
    reconcileJob: async ({ decision }: any) => { assert.equal(decision, "integrated"); assert.equal(recovered, true); integrated = true; },
    scheduleJob: async () => { throw new Error("duplicate schedule"); }, saveGateSnapshot: async () => ({ snapshotId: "snap-a" })
  };
  const gate = await runFleetCoordinator({ repository, taskId: "task-a", gateView: async () => "G2 review", handoff: { recover: async () => ({ recovered: true, valid: true, alreadyIntegrated: true, commitSha: "b".repeat(40), report: { commitSha: "b".repeat(40), changedPaths: ["src/a.ts"] } }), currentCommit: async () => "c".repeat(40) } });
  assert.equal(gate.status, "gate"); assert.equal(integrated, true);
});

test("worker saves exact session ID before reporting Git commit", async () => {
  const { runFleetWorker } = await load();
  const calls: string[] = [];
  const repository = {
    claimJob: async () => ({ taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 5, agent: "codex", state: "leased" }),
    renewJob: async () => {},
    checkpointJob: async ({ sessionId, epoch }: any) => { assert.equal(sessionId, "session-a"); assert.equal(epoch, 5); calls.push("checkpoint"); },
    reportJob: async ({ report }: any) => { assert.equal(report.commitSha, "abc123"); assert.deepEqual(report.changedPaths, ["src/a.ts"]); calls.push("report"); },
    readTask: async () => ({ task: task(), nextAction: action, revision: 1 })
  };
  const driver = async ({ onSessionId }: any) => { await onSessionId("session-a"); calls.push("driver-end"); return { sessionId: "session-a" }; };
  const handoff = { prepare: async () => ({ root: "/tmp/worker-a" }), observe: async () => ({ done: true }), finish: async () => ({ commitSha: "abc123", changedPaths: ["src/a.ts"] }) };
  const result = await runFleetWorker({ repository, workerId: "worker-a", driver, packet: async () => "Do T1", handoff });
  assert.equal(result.status, "reported"); assert.deepEqual(calls, ["checkpoint", "driver-end", "report"]);
});

test("worker skips canonically completed item after restart", async () => {
  const { runFleetWorker } = await load();
  let invoked = false;
  const repository = {
    claimJob: async () => ({ taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 2, epoch: 6, agent: "claude" }),
    renewJob: async () => {}, checkpointJob: async () => {},
    reportJob: async ({ report }: any) => { assert.equal(report.status, "superseded"); },
    readTask: async () => ({ task: task("done"), nextAction: { classification: "complete" }, revision: 9 })
  };
  const handoff = { prepare: async () => ({ root: "/tmp/worker-a" }), observe: async () => ({ done: false }), finish: async () => {} };
  const result = await runFleetWorker({ repository, driver: async () => { invoked = true; }, packet: async () => "packet", handoff });
  assert.equal(result.status, "superseded"); assert.equal(invoked, false);
});

test("worker resets stalls on changed fingerprints and stops on repeated observations", async () => {
  const { runFleetWorker } = await load();
  let turns = 0;
  let report: any;
  const repository = {
    claimJob: async () => ({ taskId: "task-a", itemId: "T1", assignmentId: "job-a", attempt: 1, epoch: 1, agent: "codex" }),
    renewJob: async () => {}, checkpointJob: async () => {},
    reportJob: async (input: any) => { report = input.report; },
    readTask: async () => ({ task: task(), nextAction: action, revision: 1 })
  };
  const fingerprints = ["a", "a", "b", "b", "b"];
  const handoff = { prepare: async () => ({ root: "/tmp/worker-a" }), observe: async () => ({ done: false, fingerprint: fingerprints[turns - 1] }), finish: async () => {} };
  const result = await runFleetWorker({ repository, workerId: "worker-a", driver: async () => { turns++; return {}; }, packet: async () => "packet", handoff, limits: { maxStallTurns: 2 } });
  assert.equal(turns, 5);
  assert.equal(result.status, "uncertain");
  assert.match(report.reason, /2 worker turns without observable progress/);
});
