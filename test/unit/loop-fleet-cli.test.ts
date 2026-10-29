import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet-cli.mjs"));

test("worker without Docker configuration fails before claiming a job", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-legacy-worker-"));
  const job = { id: "job-a", taskId: "task-a", itemId: "T1", workerId: "worker-a", agent: "claude", state: "ready" };
  const calls: string[] = [];
  const callTool = async ({ name }: { name: string }) => {
    calls.push(name);
    if (name === "fleet_get") return { revision: 1, fleet: { jobs: { "job-a": job } } };
    if (name === "job_claim") return { fleet: { jobs: { "job-a": { ...job, state: "leased", epoch: 1, attempt: 1 } } } };
    throw new Error(`Unexpected call ${name}`);
  };
  try {
    const env = { PATH: root, AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_ID: "worker-a", AIDLC_FLEET_WORKTREES_ROOT: `${root}-worktrees` };
    const { runFleetCli } = await load();
    await assert.rejects(runFleetCli(["worker", "--once"], { callTool, env, out: () => {} }), /AIDLC_WORKER_DOCKER_IMAGE is required/);
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet CLI provider mapping accepts opencode for the host lead and workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-opencode-"));
  try {
    mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
    writeFileSync(join(root, ".agents/aidlc/scripts/remote-state.mjs"), "");
    const fleet = { jobs: {}, leads: { first: { epoch: 1 } } };
    const callTool = async ({ name }: { name: string }) => {
      if (name === "fleet_get") return { revision: 1, fleet };
      if (name === "task_get") return { revision: 1, task: { id: "first", title: "Review", gate: "G0_confirm", status: "blocked_on_user", risk: "normal", areas: ["root"], artifacts: {}, decisions: [], tasks: [], evidence: [] }, nextAction: { classification: "await_user", gate: "G0_confirm" } };
      if (name === "run_claim" || name === "run_release") return { fleet };
      if (name === "gate_snapshot_put") return { id: "snapshot-1" };
      throw new Error(`Unexpected call ${name}`);
    };
    const env = { PATH: process.env.PATH ?? "", AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_IDS: "worker", AIDLC_FLEET_WORKER_PROVIDERS: JSON.stringify({ worker: "opencode" }), AIDLC_FLEET_AGENT: "opencode", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_POLL_MS: "1000" };
    const { runFleetCli } = await load();
    const result = await runFleetCli(["coordinator", "first", "--once"], { callTool, env, out: () => {} });
    assert.equal(result.status, "gate");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fleet worker execution rejects opencode before any Docker dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-opencode-worker-"));
  try {
    const calls: string[] = [];
    const env = { PATH: root, AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_ID: "worker-a", AIDLC_FLEET_WORKER_AGENT: "opencode" };
    const { runFleetCli } = await load();
    await assert.rejects(runFleetCli(["worker", "--once"], { callTool: async ({ name }: { name: string }) => { calls.push(name); throw new Error("unexpected remote call"); }, env, out: () => {} }), (error: unknown) => error instanceof Error && error.message === "OpenCode workers require file-based credentials and are not available in isolated containers yet");
    assert.deepEqual(calls, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const role of ["coordinator", "feature"]) for (const once of [false, true]) {
  test(`${role} returns a gate without polling or dispatching further tasks${once ? " (--once)" : ""}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-cli-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const reads: string[] = [];
    const fleet = { features: { feature: { integrationBranch: "main" } }, jobs: {}, leads: { first: { epoch: 1 } } };
    const callTool = async ({ name, args }: { name: string; args: Record<string, any> }) => {
      if (name === "fleet_get") return { revision: 1, fleet };
      if (name === "feature_ready") return { items: [{ taskId: "first", ready: true, blockers: [] }, { taskId: "second", ready: true, blockers: [] }] };
      if (name === "task_get") {
        reads.push(args.taskId);
        return { revision: 1, task: { id: args.taskId, title: "Review", gate: "G0_confirm", status: "blocked_on_user", risk: "normal", areas: ["root"], artifacts: {}, decisions: [], tasks: [], evidence: [] }, nextAction: { classification: "await_user", gate: "G0_confirm" } };
      }
      if (name === "run_claim" || name === "run_release") return { fleet };
      if (name === "gate_snapshot_put") return { id: "snapshot-1" };
      throw new Error(`Unexpected call ${name}`);
    };
    try {
      mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
      writeFileSync(join(root, ".agents/aidlc/scripts/remote-state.mjs"), "");
      const env = { AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_IDS: "worker", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_POLL_MS: "1000" };
      const { runFleetCli } = await load();
      const result = await runFleetCli([role, role === "feature" ? "feature" : "first", ...(once ? ["--once"] : [])], { callTool, env, out: () => {}, signal: controller.signal });
      assert.equal(result.status, "gate");
      const gate = role === "feature" ? result.results[0] : result;
      assert.equal(gate.snapshotId, "snapshot-1");
      assert.equal(gate.taskId, "first");
      assert.match(gate.gateView, /Confirm requirements/);
      assert.ok(reads.length > 0);
      assert.ok(reads.every((id) => id === "first"));
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("supervisor waits at a fenced gate checkpoint and resumes after real reviewer approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-supervisor-cli-"));
  try {
    mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
    writeFileSync(join(root, ".agents/aidlc/scripts/remote-state.mjs"), "");
    let revision = 2;
    let task: any = { id: "first", phase: "clarify", gate: "G0_confirm", status: "active", evidence: [] };
    let checkpoint: any = null;
    const fleet: any = { jobs: {}, leads: {}, supervisors: {} };
    const calls: string[] = [];
    const events: any[] = [];
    const claims: any[] = [];
    const callTool = async ({ name, args }: { name: string; args: Record<string, any> }) => {
      calls.push(name);
      if (name === "fleet_get") return { revision, fleet };
      if (name === "supervisor_claim") { fleet.supervisors.first = { epoch: 7 }; return { fleet: { supervisors: { first: { epoch: 7 } } } }; }
      if (name === "supervisor_heartbeat" || name === "supervisor_release") return { fleet: {} };
      if (name === "task_get") return { revision, task, nextAction: task.status === "active" ? { classification: "run_phase" } : { classification: "await_user", gate: task.gate } };
      if (name === "gate_checkpoint_get") return checkpoint;
      if (name === "run_claim") { const epoch = 5 + claims.length; fleet.leads.first = { epoch }; claims.push(args); return { fleet: { leads: { first: { epoch } } } }; }
      throw new Error(`Unexpected call ${name}`);
    };
    const turns: any[] = [];
    const taskDigestOf = (value: any) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const coordinator = async (options: any) => {
      turns.push(options);
      if (turns.length === 1) {
        assert.equal(options.claimedLead.epoch, 5);
        assert.deepEqual(options.workerIds, ["worker"]);
        assert.equal(options.workerProviders.worker, "codex");
        task = { ...task, status: "blocked_on_user" };
        checkpoint = { status: "pending", gate: "G0_confirm", snapshotId: "snapshot-1", taskId: "first", taskDigest: taskDigestOf(task) };
        return { status: "gate", taskId: "first", gate: "G0_confirm", snapshotId: "snapshot-1", revision, gateView: "Confirm requirements" };
      }
      return { status: "complete", taskId: "first" };
    };
    const flip = setTimeout(() => {
      checkpoint = { status: "approved", gate: "G0_confirm", snapshotId: "snapshot-1", approvalRevision: revision, taskId: "first" };
      task = { ...task, phase: "plan", status: "active" };
    }, 400);
    try {
      const env = { PATH: process.env.PATH ?? "", AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_IDS: "worker", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_POLL_MS: "1000" };
      const { runFleetCli } = await load();
      const result = await runFleetCli(["supervisor", "first"], { callTool, env, out: (line: string) => events.push(JSON.parse(line)), coordinator });
      assert.equal(result.status, "complete");
      assert.equal(turns.length, 2);
      assert.ok(claims.length >= 2);
      assert.equal(claims[0].supervisorEpoch, 7);
      assert.equal(claims[0].checkpointSnapshotId, undefined);
      assert.equal(claims[1].supervisorEpoch, 7);
      assert.equal(claims[1].supervisorOwnerToken.length >= 32, true);
      assert.equal(claims[1].checkpointSnapshotId, "snapshot-1");
      assert.equal(claims[1].checkpointApprovalRevision, revision);
      assert.ok(calls.includes("supervisor_claim"));
      assert.ok(calls.includes("supervisor_release"));
      assert.ok(events.some((event) => event.type === "waiting"));
      assert.ok(events.some((event) => event.type === "gate"));
      await assert.rejects(runFleetCli(["supervisor", "first", "--once"], { callTool, env, out: () => {} }), /Usage: aidlc-fleet/);
    } finally { clearTimeout(flip); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
