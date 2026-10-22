import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scripts = resolve("dist/assets/.agents/aidlc/scripts");
const { runRemoteState, runRemoteReview, runRemoteFeature, runRemoteLease, readIntegrationCommit } = await import(pathToFileURL(resolve(scripts, "remote-state.mjs")).href);
const { callRemoteTool, remoteConfig, reviewerConfig } = await import(pathToFileURL(resolve(scripts, "lib/remote-state-client.mjs")).href);

test("remote lifecycle keeps the server response canonical and requires a revisioned write", async () => {
  let revision = 0;
  const state: any = { schemaVersion: 4, tasks: {}, archive: {} };
  const client: any = {
    get: async () => ({ revision, state: structuredClone(state) }),
    apply: async (expected: number, id: string, task: any) => {
      assert.equal(expected, revision);
      assert.equal(id, "fleet-task");
      state.tasks[id] = structuredClone(task);
      revision += 1;
      return { revision, state: structuredClone(state), nextActions: { [id]: { classification: "run_phase" } } };
    }
  };
  const created = await runRemoteState(["task", "create", "fleet-task", "--title", "Fleet task"], client, "/tmp/project");
  assert.equal(created.result.revision, 1);
  assert.equal(created.nextAction.classification, "run_phase");
  const next = await runRemoteState(["task", "next", "fleet-task"], client, "/tmp/project");
  assert.equal(next.result.phase, "clarify");
  assert.match(next.nextAction.command, /remote-state\.mjs"? phase context/);
  assert.doesNotMatch(next.nextAction.command, /--root/);
  await assert.rejects(() => runRemoteState(["gate", "approve", "fleet-task"], client, "/tmp/project"), /reviewer-only/);
});

test("remote lifecycle fails closed when canonical state is unavailable", async () => {
  await assert.rejects(() => runRemoteState(["task", "next", "fleet-task"], { get: async () => { throw new Error("outage"); } } as any, "/tmp/project"), /outage/);
  assert.throws(() => remoteConfig({ AIDLC_FLEET_URL: "http://localhost/mcp" } as any), /requires/);
  assert.throws(() => reviewerConfig({ AIDLC_FLEET_URL: "http://localhost/mcp" } as any), /requires/);
});

test("reviewer approves only the exact current gate snapshot", async () => {
  const task = { id: "fleet-task", gate: "G1_review", status: "blocked_on_user" };
  let approvals = 0;
  const client: any = {
    get: async () => ({ revision: 5, state: { tasks: { "fleet-task": task } } }),
    inbox: async () => [{ id: "snapshot-4", taskId: "fleet-task", stateRevision: 4, gate: "G1_review" }],
    approve: async (revision: number, id: string, snapshot: string, source: string) => {
      assert.deepEqual([revision, id, snapshot, source], [5, "fleet-task", "snapshot-4", "approve"]);
      approvals += 1;
      return { revision: 6, state: { tasks: { "fleet-task": { ...task, phase: "build", status: "active" } } }, nextActions: { "fleet-task": { classification: "run_phase" } } };
    }
  };
  assert.equal((await runRemoteReview(["gate", "inbox"], client)).result.length, 1);
  await assert.rejects(() => runRemoteReview(["gate", "approve", "fleet-task", "--snapshot", "stale", "--source", "approve"], client), /stale/);
  assert.equal(approvals, 0);
  const approved = await runRemoteReview(["gate", "approve", "fleet-task", "--snapshot", "snapshot-4", "--source", "approve"], client);
  assert.equal(approved.result.revision, 6);
  assert.equal(approvals, 1);
});

test("MCP client rejects tool errors and never treats them as success", async () => {
  const fetchImpl: any = async (_url: string, options: any) => {
    const id = JSON.parse(options.body).id;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "REVISION_CONFLICT", message: "stale" }) }] } }), { headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => callRemoteTool({ url: "http://localhost/mcp", token: "test" }, "state_get", {}, fetchImpl), /stale/);
});

test("remote wrap lesson disposition and closure mutate only the leased task", async () => {
  let revision = 3;
  const task: any = { id: "fleet-task", title: "Fleet task", type: "infra", phase: "wrap", gate: "none", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/fleet-task/intent.md", design: ".agents/data/tasks/fleet-task/design.md", workplan: ".agents/data/tasks/fleet-task/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" };
  const state: any = { schemaVersion: 4, tasks: { "fleet-task": task }, archive: {} };
  const client: any = { get: async () => ({ revision, state: structuredClone(state) }), apply: async (expected: number, id: string, candidate: any) => { assert.equal(expected, revision); assert.equal(id, "fleet-task"); state.tasks[id] = structuredClone(candidate); revision++; return { revision, state: structuredClone(state), nextActions: { [id]: { classification: "run_phase" } } }; } };
  const lesson = await runRemoteState(["lesson", "none", "fleet-task", "--reason", "No reusable lesson", "--source", "lead review"], client, resolve("."));
  assert.equal(lesson.result.task.lessonDisposition.status, "none");
  const closed = await runRemoteState(["task", "close", "fleet-task", "--reason", "stopped", "--source", "user request"], client, resolve("."));
  assert.equal(closed.result.task.status, "closed");
});

test("feature manifest is revisioned remotely and ready derives from remote lifecycle", async () => {
  let revision = 0;
  let feature: any = null;
  const client: any = {
    featureGet: async () => ({ revision, feature: structuredClone(feature) }),
    featureApply: async (expected: number, candidate: any) => { assert.equal(expected, revision); feature = structuredClone(candidate); feature.revision = 1; revision++; return { revision, fleet: { features: { "login": feature } } }; },
    featureReady: async () => ({ stateRevision: 9, items: [{ taskId: "a", ready: false, blockers: [] }, { taskId: "b", ready: true, blockers: [] }] }),
    get: async () => ({ revision: 9, state: { tasks: { a: { featureId: "login" }, b: { featureId: "login" } }, archive: {} } })
  };
  const created = await runRemoteFeature(["feature", "create", "login", "--branch", "feature/login", "--tasks", "a,b"], client);
  assert.equal(created.result.feature.tasks.length, 2);
  await runRemoteFeature(["feature", "link", "login", "b", "--depends-on", "a"], client);
  const ready = await runRemoteFeature(["feature", "ready", "login"], client);
  assert.equal(ready.result.items.find((item: any) => item.taskId === "b").ready, true);
});

test("feature bootstrap creates task records with membership before manifest", async () => {
  const state: any = { schemaVersion: 4, tasks: {}, archive: {} };
  const client: any = {
    get: async () => ({ revision: 0, state: structuredClone(state) }),
    featureGet: async () => ({ revision: 0, feature: null }),
    apply: async (_revision: number, id: string, task: any) => { state.tasks[id] = structuredClone(task); return { revision: 1, state: structuredClone(state), nextActions: { [id]: { classification: "run_phase" } } }; }
  };
  const result = await runRemoteState(["task", "create", "task-a", "--title", "A", "--feature", "login"], client, resolve("."));
  assert.equal(result.result.task.featureId, "login");
});

test("phase packet uses the remote task snapshot", async () => {
  const task: any = { id: "remote-packet", title: "Remote phase packet", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/remote-packet/intent.md", design: ".agents/data/tasks/remote-packet/design.md", workplan: ".agents/data/tasks/remote-packet/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" };
  const client: any = { get: async () => ({ revision: 7, state: { schemaVersion: 4, tasks: { "remote-packet": task }, archive: {} } }) };
  const packet = await runRemoteState(["phase", "context", "remote-packet"], client, resolve("."));
  assert.equal(packet.result.canonicalRevision, 7);
  assert.match(packet.result.content, /Remote phase packet/);
});

test("lead can claim before task creation and release the fenced epoch", async () => {
  let revision = 0;
  const client: any = {
    fleetGet: async () => ({ revision, fleet: { leads: {} } }),
    runClaim: async (expected: number, taskId: string, leaseMs: number) => { assert.deepEqual([expected, taskId, leaseMs], [0, "task-a", 300000]); revision++; return { revision, fleet: { leads: { "task-a": { epoch: 2, expiresAt: "2026-10-22T12:00:00.000Z" } } } }; },
    runRelease: async (expected: number, taskId: string, epoch: number) => { assert.deepEqual([expected, taskId, epoch], [1, "task-a", 2]); revision++; return { revision }; }
  };
  const claimed = await runRemoteLease(["run", "claim", "task-a"], client);
  assert.equal(claimed.result.epoch, 2);
  const released = await runRemoteLease(["run", "release", "task-a", "--epoch", "2"], client);
  assert.equal(released.result.released, true);
  await assert.rejects(() => runRemoteLease(["run", "claim", "task-a", "--lease-ms", "5"], client), /60000/);
});

test("G2 reviewer verifies remote integration ref and passes exact snapshot SHA", async () => {
  const sha = "a".repeat(40);
  let approvals = 0;
  const client: any = {
    get: async () => ({ revision: 8, state: { tasks: { build: { gate: "G2_codereview", status: "blocked_on_user" } } } }),
    inbox: async () => [{ id: "g2-snapshot", taskId: "build", gate: "G2_codereview", integrationCommit: sha }],
    approve: async (revision: number, taskId: string, snapshot: string, source: string, commit: string) => { assert.deepEqual([revision, taskId, snapshot, source, commit], [8, "build", "g2-snapshot", "approve", sha]); approvals++; return { revision: 9, state: { tasks: { build: { phase: "wrap" } } } }; }
  };
  await assert.rejects(() => runRemoteReview(["gate", "approve", "build", "--snapshot", "g2-snapshot", "--source", "approve"], client, { readRemoteRef: async () => "b".repeat(40) }), /changed/);
  assert.equal(approvals, 0);
  await runRemoteReview(["gate", "approve", "build", "--snapshot", "g2-snapshot", "--source", "approve"], client, { readRemoteRef: async () => sha });
  assert.equal(approvals, 1);
});

test("Git integration ref check uses argument array and rejects missing ref", async () => {
  const sha = "f".repeat(40);
  const config = { projectRoot: "/tmp/project", integrationBranch: "feature/login", gitRemote: "origin" };
  const actual = await readIntegrationCommit(config, async (binary: string, args: string[], options: any) => {
    assert.equal(binary, "git");
    assert.deepEqual(args, ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/feature/login"]);
    assert.equal(options.cwd, "/tmp/project");
    return { stdout: `${sha}\trefs/heads/feature/login\n` };
  });
  assert.equal(actual, sha);
  await assert.rejects(() => readIntegrationCommit(config, async () => ({ stdout: "" })), /missing or ambiguous/);
});

test("G2 lead snapshot includes live integration commit", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "aidlc-g2-"));
  try {
    const reviewFile = resolve(directory, "review.txt");
    await writeFile(reviewFile, "Reviewed integrated change");
    const sha = "c".repeat(40);
    const client: any = {
      get: async () => ({ revision: 11, state: { tasks: { build: { gate: "G2_codereview", status: "blocked_on_user" } } } }),
      snapshot: async (revision: number, taskId: string, gate: string, text: string, commit: string) => {
        assert.deepEqual([revision, taskId, gate, text, commit], [11, "build", "G2_codereview", "Reviewed integrated change", sha]);
        return { id: "snapshot", integrationCommit: commit };
      }
    };
    const result = await runRemoteState(["gate", "snapshot", "build", "--gate", "G2_codereview", "--review-file", reviewFile], client, directory, { readRemoteRef: async () => sha });
    assert.equal(result.result.integrationCommit, sha);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("G0 and G1 snapshots do not require Git integration configuration", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "aidlc-early-gate-"));
  try {
    const reviewFile = resolve(directory, "review.txt");
    await writeFile(reviewFile, "Review content");
    for (const gate of ["G0_confirm", "G1_review"]) {
      const client: any = {
        get: async () => ({ revision: 1, state: { tasks: { task: { gate, status: "blocked_on_user" } } } }),
        snapshot: async (_revision: number, _id: string, actualGate: string, _text: string, commit: string | undefined) => { assert.equal(actualGate, gate); assert.equal(commit, undefined); return { gate }; }
      };
      const result = await runRemoteState(["gate", "snapshot", "task", "--gate", gate, "--review-file", reviewFile], client, directory, { readRemoteRef: async () => { throw new Error("Git must not be read"); } });
      assert.equal(result.result.gate, gate);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
