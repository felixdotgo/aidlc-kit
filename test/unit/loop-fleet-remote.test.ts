import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet-remote.mjs"));

test("remote adapter maps fenced service revisions and job IDs", async () => {
  const { createFleetRemoteRepository } = await load();
  const calls: Array<{ name: string; args: any }> = [];
  let revision = 1;
  const fleet: any = { features: {}, leads: {}, jobs: {} };
  const callTool = async ({ name, args }: any) => {
    calls.push({ name, args });
    if (name === "fleet_get") return { workspace: "demo", revision, fleet };
    if (name === "task_get") return { task: { id: "task-a", tasks: [] }, nextAction: { classification: "run_phase" }, revision: 5 };
    assert.equal(args.expectedRevision, revision);
    revision++;
    if (name === "run_claim") fleet.leads[args.taskId] = { epoch: 3, expiresAt: "2030-01-01T00:00:00Z" };
    if (name === "job_schedule") fleet.jobs[args.jobId] = { id: args.jobId, taskId: args.taskId, itemId: args.itemId, workerId: args.workerId, attempt: args.attempt, state: "ready" };
    if (name === "job_claim") { fleet.jobs[args.jobId].state = "leased"; fleet.jobs[args.jobId].epoch = 4; }
    return { workspace: "demo", revision, fleet };
  };
  const repo = createFleetRemoteRepository({ callTool, url: "http://service/mcp", token: "token", workspace: "demo", root: "/tmp/project", workerId: "worker-a" });
  const snapshot = await repo.readTask({ taskId: "task-a" });
  assert.equal(snapshot.revision, 5);
  const lead = await repo.claimLead({ taskId: "task-a", leaseMs: 300000, idempotencyKey: "claim-a" });
  assert.equal(lead.epoch, 3);
  const ownerToken = calls.find((call) => call.name === "run_claim")?.args.ownerToken;
  assert.ok(typeof ownerToken === "string" && ownerToken.length >= 32);
  const job = await repo.scheduleJob({ taskId: "task-a", itemId: "T1", workerId: "worker-a", leadEpoch: 3, baseCommit: "a".repeat(40), branch: "aidlc/task-a/T1", ownedPaths: ["src/a.ts"], agent: "codex", idempotencyKey: "job-a" });
  assert.equal(job.assignmentId, job.id);
  assert.equal(calls.find((call) => call.name === "job_schedule")?.args.ownerToken, ownerToken);
  const claimed = await repo.claimJob({ workerId: "worker-a", leaseMs: 300000, idempotencyKey: "claim-job" });
  assert.equal(claimed.epoch, 4);
  assert.equal(calls.find((call) => call.name === "task_get")?.args.clientProjectRoot, "/tmp/project");
  assert.ok(calls.every((call) => call.args.workspace === "demo"));
});

test("remote adapter uses fenced upsert after Git integration without approval", async () => {
  const { createFleetRemoteRepository } = await load();
  let sent: any;
  const callTool = async ({ name, args }: any) => {
    if (name === "fleet_get") return { revision: 1, fleet: { leads: {} } };
    if (name === "run_claim") return { fleet: { leads: { "task-a": { epoch: 3, expiresAt: "2030-01-01T00:00:00Z" } } } };
    if (name === "state_apply") { sent = args; return { revision: 9 }; }
    throw new Error(`Unexpected ${name}`);
  };
  const repo = createFleetRemoteRepository({ callTool, url: "http://service/mcp", token: "token", workspace: "demo", root: "/tmp/project" });
  await repo.claimLead({ taskId: "task-a", leaseMs: 300000 });
  const task = { id: "task-a", tasks: [{ id: "T1", status: "in_progress" }], evidence: [] };
  await repo.completeItem({ taskId: "task-a", itemId: "T1", job: { assignmentId: "job-a" }, integrated: { integrationCommit: "a".repeat(40), commitSha: "b".repeat(40) }, snapshot: { task, revision: 8 }, leadEpoch: 3 });
  assert.equal(sent.leadEpoch, 3); assert.equal(sent.expectedRevision, 8);
  assert.equal(sent.leadOwnerToken, repo.leadOwnerToken());
  assert.equal(sent.command.task.tasks[0].status, "done");
  assert.match(sent.command.task.evidence[0].source, /Git integration/);
  assert.ok(!sent.command.task.evidence.some((entry: any) => entry.kind === "approval"));
});

test("supervised run claim binds ownership and approved checkpoint", async () => {
  const { createFleetRemoteRepository } = await load();
  let revision = 0; const calls: Array<{ name: string; args: any }> = [];
  const fleet: any = { supervisors: {}, leads: {} };
  const callTool = async ({ name, args }: any) => {
    calls.push({ name, args });
    if (name === "fleet_get") return { revision, fleet };
    if (name === "supervisor_claim") fleet.supervisors[args.taskId] = { epoch: 7, expiresAt: "2030-01-01" };
    if (name === "run_claim") fleet.leads[args.taskId] = { epoch: 3, expiresAt: "2030-01-01" };
    revision++; return { revision, fleet };
  };
  const repo = createFleetRemoteRepository({ callTool, url: "http://service/mcp", token: "token", workspace: "demo", root: "/tmp/project" });
  await repo.claimSupervisor({ taskId: "task-a", leaseMs: 60000 });
  await repo.claimLead({ taskId: "task-a", leaseMs: 60000, expectedStateRevision: 4, expectedTaskDigest: "a".repeat(64), checkpoint: { status: "approved", snapshotId: "snap", approvalRevision: 4 } });
  const supervisor = calls.find((c) => c.name === "supervisor_claim")!.args;
  const run = calls.find((c) => c.name === "run_claim")!.args;
  assert.equal(run.supervisorEpoch, 7); assert.equal(run.supervisorOwnerToken, supervisor.ownerToken);
  assert.notEqual(run.ownerToken, supervisor.ownerToken); assert.equal(run.checkpointSnapshotId, "snap");
  assert.equal(run.checkpointApprovalRevision, 4); assert.equal(run.expectedStateRevision, 4);
});
