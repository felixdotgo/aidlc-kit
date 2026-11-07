import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-local-workers.mjs"));
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
function fixture(t: any) {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-local-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "repo"); mkdirSync(root); git(root, "init", "-b", "main");
  writeFileSync(join(root, "a.txt"), "base\n"); git(root, "add", "a.txt");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  return { root, worktreesRoot: join(parent, "worktrees") };
}
const jobs = [{ itemId: "one", workerId: "worker", agent: "codex", ownedPaths: ["a.txt"], prompt: "Implement A" }];
const hooks = { claim: async () => ({ id: "assignment" }), heartbeat: async () => {}, report: async () => {}, release: async () => {} };

test("local workers fail closed without Docker isolation configuration", async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks }), /Docker worker isolation/);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base\n");
});

test("local workers reject overlapping scopes before Docker dispatch", async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const second = { ...jobs[0], itemId: "two", workerId: "second" };
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: [...jobs, second], ...hooks }), /Overlapping/);
});

test("local workers keep last-resort guards for path-segment overlap and duplicate workers", async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const nested = [{ ...jobs[0], ownedPaths: ["src/"] }, { ...jobs[0], itemId: "two", workerId: "second", ownedPaths: ["src/a.ts"] }];
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: nested, ...hooks }), /Overlapping assignment scope: src\/a\.ts/);
  const sibling = [{ ...jobs[0], ownedPaths: ["src"] }, { ...jobs[0], itemId: "two", workerId: "second", ownedPaths: ["srcx"] }];
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: sibling, ...hooks }), /Docker worker isolation/);
  const sameWorker = [jobs[0], { ...jobs[0], itemId: "two", ownedPaths: ["b.txt"] }];
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: sameWorker, ...hooks }), /distinct within a batch/);
});

test("local workers accept OpenCode and still require Docker isolation", async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const opencodeJobs = [{ ...jobs[0], agent: "opencode" }];
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: opencodeJobs, ...hooks }), /Docker worker isolation/);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base\n");
});

test("Docker worker isolates and integrates its scoped snapshot", { skip: !process.env.AIDLC_TEST_WORKER_IMAGE }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; });
  const result = await runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks, docker: { image: process.env.AIDLC_TEST_WORKER_IMAGE, credentials: { codex: ["OPENAI_API_KEY"] } } });
  assert.equal(result.length, 1); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "isolated\n");
});

test("local worker stops without integrating when its turn limit is reached", { skip: !process.env.AIDLC_TEST_MULTITURN_IMAGE }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const prior=process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY="test-only";
  t.after(() => { if(prior===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=prior; });
  await assert.rejects(() => runLocalWorkerBatch({root,worktreesRoot,taskId:"task",jobs,...hooks,maxTurns:1,docker:{image:process.env.AIDLC_TEST_MULTITURN_IMAGE,credentials:{codex:["OPENAI_API_KEY"]}}}),/turn limit/);
  assert.equal(readFileSync(join(root,"a.txt"),"utf8"),"base\n");
});

const rejected = (reason: unknown) => ({ status: "rejected", reason });
const recorder = (fail = new Set<string>()) => {
  const calls: string[] = [];
  return { calls, release: async (root: string, taskId: string, id: string) => { assert.equal(root, "/root"); assert.equal(taskId, "task"); calls.push(id); if (fail.has(id)) throw new Error("Assignment cannot be released"); } };
};

test("failed batch jobs the loop stopped release their claims for retry", async () => {
  const { releaseFailedAssignments } = await load(), hook = recorder();
  const outcomes = [{ assignmentId: "a1", itemId: "one", reported: false, settled: rejected(new Error("opencode turn timed out after 600000 ms")) }, { assignmentId: "a2", itemId: "two", reported: false, settled: rejected(new Error("Worker batch cancelled by daemon shutdown")) }];
  assert.deepEqual(await releaseFailedAssignments({ root: "/root", taskId: "task", outcomes, release: hook.release }), { released: ["one", "two"], held: [] });
  assert.deepEqual(hook.calls, ["a1", "a2"]);
});

test("failed batch keeps claims whose container cleanup is uncertain", async () => {
  const { releaseFailedAssignments } = await load(), hook = recorder();
  const uncertain = Object.assign(new Error("Docker cleanup uncertain: container remains"), { cleanupUncertain: true });
  const outcomes = [{ assignmentId: "a1", itemId: "one", reported: false, settled: rejected(uncertain) }, { assignmentId: "a2", itemId: "two", reported: false, settled: rejected(new Error("Worker worker stalled")) }];
  assert.deepEqual(await releaseFailedAssignments({ root: "/root", taskId: "task", outcomes, release: hook.release }), { released: ["two"], held: [{ itemId: "one", reason: "container cleanup uncertain" }] });
  assert.deepEqual(hook.calls, ["a2"]);
});

test("failed batch keeps reported siblings for reconciliation", async () => {
  const { releaseFailedAssignments } = await load(), hook = recorder();
  const outcomes = [{ assignmentId: "a1", itemId: "one", reported: true, settled: { status: "fulfilled", value: {} } }, { assignmentId: "a2", itemId: "two", reported: true, settled: rejected(new Error("late failure")) }];
  assert.deepEqual(await releaseFailedAssignments({ root: "/root", taskId: "task", outcomes, release: hook.release }), { released: [], held: [{ itemId: "one", reason: "reported, not integrated" }, { itemId: "two", reason: "reported, not integrated" }] });
  assert.deepEqual(hook.calls, []);
});

test("failed batch release errors are held without masking the batch failure", async () => {
  const { releaseFailedAssignments } = await load(), hook = recorder(new Set(["a1"]));
  const outcomes = [{ assignmentId: "a1", itemId: "one", reported: false, settled: rejected("plain string failure") }, { assignmentId: "a2", itemId: "two", reported: false, settled: rejected(new Error("Worker worker changed no files")) }];
  assert.deepEqual(await releaseFailedAssignments({ root: "/root", taskId: "task", outcomes, release: hook.release }), { released: ["two"], held: [{ itemId: "one", reason: "release failed: Assignment cannot be released" }] });
  assert.deepEqual(hook.calls, ["a1", "a2"]);
});
