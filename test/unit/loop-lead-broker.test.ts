import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
const { applyLeadProposal, leadTaskDigest, parseLeadProposal } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-broker.mjs"));

const task = () => ({ id: "task", status: "active", phase: "plan", tasks: [{ id: "base" }] });
const proposal = (operation: object, current = task()) => JSON.stringify({ version: 1, taskId: current.id, phase: current.phase, taskDigest: leadTaskDigest(current), operation });
const artifact = { kind: "artifact", name: "design", content: "Design", expectedDigest: null };
test("broker permits one phase-scoped proposal inside fenced transaction", async () => {
  const current = task(), seen: string[] = [];
  const adapter = { withTaskLock: async (_id: string, f: (tx: object) => Promise<unknown>) => f({ assertOwned: async () => { seen.push("fence"); }, readTask: async () => current, nextAction: async () => ({ classification: "run_phase", phase: "plan" }), applyOne: async () => { seen.push("apply"); } }) };
  await applyLeadProposal(proposal(artifact, current), adapter);
  assert.deepEqual(seen, ["fence", "fence", "apply", "fence"]);
});
test("broker rejects approval, evidence, phase changes, arbitrary paths and stale proposals", async () => {
  for (const op of [{ kind: "approve", gate: "G1_review" }, { kind: "evidence", result: "pass" }, { kind: "transition", phase: "build" }, { kind: "artifact", name: "../../state", content: "x" }, { kind: "item", id: "x", label: "x", dependsOn: [], ownedPaths: ["../outside"] }]) assert.throws(() => parseLeadProposal(proposal(op)));
  const stale = task(); stale.phase = "build";
  let applied = false;
  const adapter = { withTaskLock: async (_id: string, f: (tx: object) => Promise<unknown>) => f({ assertOwned: async () => {}, readTask: async () => stale, nextAction: async () => ({ classification: "run_phase", phase: "build" }), applyOne: async () => { applied = true; } }) };
  await assert.rejects(applyLeadProposal(proposal(artifact), adapter), /Stale/);
  assert.equal(applied, false);
});

test("lead Docker invocation exposes snapshot read-only and only its provider credential", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { leadDockerInvocation } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-sandbox.mjs"));
  const snapshot = mkdtempSync(join(tmpdir(), "lead-snapshot-"));
  try {
    const call = leadDockerInvocation({ snapshot, image: "local/lead:1", agent: "codex", args: ["exec"], credentialEnv: ["OPENAI_API_KEY"], hostEnv: { PATH: "/bin", OPENAI_API_KEY: "worker-token", REVIEWER_TOKEN: "secret" }, uid: 1000, gid: 1000 });
    assert.ok(call.args.includes(`type=bind,src=${snapshot},dst=/workspace,readonly`));
    assert.equal(call.env.REVIEWER_TOKEN, undefined);
    assert.ok(!JSON.stringify(call.args).includes("worker-token"));
    assert.throws(() => leadDockerInvocation({ snapshot, image: "local/lead:1", agent: "codex", args: [], credentialEnv: ["REVIEWER_TOKEN"], hostEnv: { REVIEWER_TOKEN: "secret" }, uid: 1000, gid: 1000 }), /Unsupported/);
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
});

test("local broker holds supervisor fence and rejects stale artifact overwrite", async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { applyPlan, planInit } = await import("../../src/installer.js");
  const store = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/store.mjs"));
  const { createLocalSupervisorAdapter } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-supervisor-local.mjs"));
  const { createLocalLeadBrokerAdapter } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-local-broker.mjs"));
  const root = mkdtempSync(join(tmpdir(), "aidlc-lead-broker-"));
  try {
    applyPlan(root, planInit({ root, agents: ["codex"], all: false, dryRun: false, yes: true, force: false }));
    const date = new Date().toISOString(), id = "task-a";
    const current = { id, title: "A", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "vi", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: `.agents/data/tasks/${id}/intent.md`, design: `.agents/data/tasks/${id}/design.md`, workplan: `.agents/data/tasks/${id}/workplan.md` }, decisions: [], tasks: [], evidence: [], createdAt: date, updatedAt: date };
    const state = store.emptyState(); state.tasks[id] = current; store.saveState(root, state);
    mkdirSync(join(root, ".agents/data/tasks", id), { recursive: true });
    const owner = await createLocalSupervisorAdapter({ root, taskId: id }).acquireSupervisor({ taskId: id, authority: "local" });
    const broker = createLocalLeadBrokerAdapter({ root, taskId: id, assertOwned: owner.assertOwned });
    const raw = JSON.stringify({ version: 1, taskId: id, phase: "clarify", taskDigest: leadTaskDigest(store.loadState(root).tasks[id]), operation: { kind: "artifact", name: "intent", content: "Intent", expectedDigest: null } });
    await applyLeadProposal(raw, broker);
    assert.equal(readFileSync(join(root, current.artifacts.intent), "utf8"), "Intent");
    await assert.rejects(applyLeadProposal(raw, broker), /Stale lead artifact digest/);
    await owner.release();
    await assert.rejects(applyLeadProposal(raw, broker), /ownership lost/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lead snapshot copies tracked source, excludes lifecycle state and is removed after use", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { withLeadSnapshot } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-sandbox.mjs"));
  const base = mkdtempSync(join(tmpdir(), "aidlc-lead-snapshot-")), root = join(base, "project"), snapshotsRoot = join(base, "snapshots");
  try {
    mkdirSync(join(root, ".agents/data"), { recursive: true });
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, "source.txt"), "source"); writeFileSync(join(root, ".agents/data/secret"), "secret");
    execFileSync("git", ["-C", root, "add", "-f", "source.txt", ".agents/data/secret"]);
    let path = "";
    await withLeadSnapshot({ root, snapshotsRoot }, async (snapshot: string) => { path = snapshot; assert.equal(readFileSync(join(snapshot, "source.txt"), "utf8"), "source"); assert.equal(existsSync(join(snapshot, ".agents/data/secret")), false); });
    assert.equal(existsSync(path), false);
    await assert.rejects(withLeadSnapshot({ root, snapshotsRoot: join(root, "nested") }, async () => {}), /outside/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("artifact journal recovers both pre-rename and post-rename crashes without overwriting unrelated changes", async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const { writeLeadArtifact, recoverLeadArtifact } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-artifacts.mjs"));
  const root = mkdtempSync(join(tmpdir(), "lead-journal-")), id = "a", dir = join(root, ".agents/data/tasks", id), target = join(dir, "intent.md"), journal = join(dir, ".lead-artifact-journal.json");
  const hash = (x: string) => createHash("sha256").update(x).digest("hex");
  const task = { artifacts: { intent: `.agents/data/tasks/${id}/intent.md` } };
  const assertOwned = async () => {};
  try {
    mkdirSync(dir, { recursive: true }); writeFileSync(target, "before");
    const op = { name: "intent", content: "after", expectedDigest: hash("before") };
    let calls = 0;
    await assert.rejects(writeLeadArtifact({ root, taskId: id, task, operation: op, assertOwned: async () => { if (++calls === 2) throw new Error("crash before rename"); } }), /crash/);
    assert.equal(readFileSync(target, "utf8"), "before"); assert.equal(existsSync(journal), true);
    await recoverLeadArtifact({ root, taskId: id, task, assertOwned }); assert.equal(existsSync(journal), false);
    calls = 0;
    await assert.rejects(writeLeadArtifact({ root, taskId: id, task, operation: op, assertOwned: async () => { if (++calls === 3) throw new Error("crash after rename"); } }), /crash/);
    assert.equal(readFileSync(target, "utf8"), "after");
    writeFileSync(target, "unrelated");
    await assert.rejects(recoverLeadArtifact({ root, taskId: id, task, assertOwned }), /conflicts/);
    writeFileSync(target, "after"); await recoverLeadArtifact({ root, taskId: id, task, assertOwned }); assert.equal(existsSync(journal), false);
    await assert.rejects(writeLeadArtifact({ root, taskId: id, task, operation: op, assertOwned }), /Stale/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real Docker lead cannot write source or see host state, socket, home, or reviewer credential", { skip: process.env.AIDLC_TEST_DOCKER !== "1" }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { runIsolatedLeadTurn } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-lead-sandbox.mjs"));
  const base = mkdtempSync(join(tmpdir(), "lead-docker-test-")), root = join(base, "project"), context = join(base, "context"), snapshotsRoot = join(base, "snapshots");
  const oldKey = process.env.OPENAI_API_KEY, oldReviewer = process.env.REVIEWER_TOKEN;
  const image = "aidlc-lead-boundary-test:local";
  try {
    mkdirSync(join(root, ".agents/data"), { recursive: true }); mkdirSync(context);
    writeFileSync(join(root, "source.txt"), "original"); writeFileSync(join(root, ".agents/data/secret"), "secret");
    execFileSync("git", ["init", "-q", root]); execFileSync("git", ["-C", root, "add", "source.txt"]);
    writeFileSync(join(context, "Dockerfile"), "FROM node:24-alpine\nCOPY codex /usr/local/bin/codex\nRUN chmod 755 /usr/local/bin/codex\n");
    writeFileSync(join(context, "codex"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo fake-1; exit 0; fi
[ ! -e /workspace/.agents/data ] || exit 20
[ ! -e /workspace/.git ] || exit 21
[ ! -e /var/run/docker.sock ] || exit 22
[ -z "$REVIEWER_TOKEN" ] || exit 23
[ ! -e "$HOME/.host-secret" ] || exit 24
if echo bad > /workspace/source.txt 2>/dev/null; then exit 25; fi
cat >/dev/null
printf '%s\\n' '{"type":"thread.started","thread_id":"test-1"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"version\\":1,\\"taskId\\":\\"a\\",\\"phase\\":\\"plan\\",\\"taskDigest\\":\\"${"0".repeat(64)}\\",\\"operation\\":{\\"kind\\":\\"artifact\\",\\"name\\":\\"design\\",\\"content\\":\\"x\\",\\"expectedDigest\\":null}}"}}' '{"type":"turn.completed"}'
`);
    execFileSync("docker", ["build", "--network", "none", "-q", "-t", image, context], { stdio: "ignore", timeout: 120000 });
    process.env.OPENAI_API_KEY = "fake-test-key"; process.env.REVIEWER_TOKEN = "do-not-expose";
    const proposal = await runIsolatedLeadTurn({ root, snapshotsRoot, image, agent: "codex", prompt: "propose", assertOwned: async () => {}, timeoutMs: 30000 });
    assert.equal(proposal.taskId, "a"); assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "original");
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldReviewer === undefined) delete process.env.REVIEWER_TOKEN; else process.env.REVIEWER_TOKEN = oldReviewer;
    rmSync(base, { recursive: true, force: true });
  }
});

test("trusted gate command refuses piped approval outside a host terminal", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = resolve("dist/assets/.agents/aidlc/scripts/loop-gate.mjs");
  const result = spawnSync(process.execPath, [script, "task-a"], { input: "approve\n", encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires the trusted host terminal/);
});

test("local approval receipt binds checkpoint, gate, exact approved state and host review identity", async () => {
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeLocalGateReceipt, verifyLocalGateReceipt } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-local-gate-receipt.mjs"));
  const root = mkdtempSync(join(tmpdir(), "gate-receipt-")), reviewHash = "c".repeat(64);
  try {
    mkdirSync(join(root, ".agents/data/loop"), { recursive: true });
    const checkpoint = { taskId: "a", gate: "G0_confirm", evidenceCount: 0, taskHash: "old" };
    const task = { id: "a", phase: "plan", evidence: [{ kind: "approval", gate: "G0_confirm", result: "pass", source: `Trusted host terminal: approve (${reviewHash})` }] };
    const input = { root, checkpoint, snapshot: { task } };
    assert.equal(await verifyLocalGateReceipt(input), false);
    writeLocalGateReceipt(root, checkpoint, task, reviewHash);
    assert.equal(await verifyLocalGateReceipt(input), true);
    assert.equal(await verifyLocalGateReceipt({ ...input, checkpoint: { ...checkpoint, taskHash: "different" } }), false);
    assert.equal(await verifyLocalGateReceipt({ ...input, snapshot: { task: { ...task, phase: "build" } } }), false);
    assert.equal(await verifyLocalGateReceipt({ ...input, snapshot: { task: { ...task, evidence: [{ ...task.evidence[0], source: "forged" }] } } }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
