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
