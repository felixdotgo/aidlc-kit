import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-git.mjs"));
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t: any) {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-git-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const remote = join(parent, "remote.git");
  mkdirSync(remote);
  git(parent, "init", "--bare", "remote.git");
  const seed = join(parent, "seed");
  git(parent, "clone", remote, seed);
  git(seed, "checkout", "-b", "feature");
  writeFileSync(join(seed, "a.txt"), "base\n");
  writeFileSync(join(seed, "b.txt"), "base\n");
  git(seed, "add", "-A");
  git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  git(seed, "push", "-u", "origin", "feature");
  const lead = join(parent, "lead"), worker = join(parent, "worker");
  git(parent, "clone", "-b", "feature", remote, lead);
  git(parent, "clone", "-b", "feature", remote, worker);
  return { parent, remote, lead, worker };
}

test("worker pushes scoped commit, lead verifies and integrates once", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const leadHandoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const workerHandoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const artifact = await leadHandoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"], agent: "codex" } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const workspace = await workerHandoff.prepare(job);
  writeFileSync(join(workspace.root, "a.txt"), "worker\n");
  assert.equal((await workerHandoff.observe({ job, workspace, result: { resultText: "Ready\nAI-DLC-ITEM-COMPLETE\n" } })).done, true);
  const report = await workerHandoff.finish({ job, workspace });
  assert.deepEqual(report.changedPaths, ["a.txt"]);
  const recovered = await leadHandoff.recover({ job });
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.report, report);
  const verified = await leadHandoff.verify({ job: { ...job, report } });
  assert.equal(verified.valid, true);
  const integrated = await leadHandoff.integrate({ job: { ...job, report }, artifact: verified });
  assert.equal(integrated.integrated, true);
  assert.equal(readFileSync(join(lead, "a.txt"), "utf8"), "worker\n");
  assert.equal(git(lead, "merge-base", "--is-ancestor", report.commitSha, "HEAD"), "");
  const duplicate = await leadHandoff.integrate({ job: { ...job, report } });
  assert.equal(duplicate.alreadyIntegrated, true);
  assert.equal(git(lead, "rev-parse", "HEAD"), integrated.integrationCommit);
});

test("missing assigned remote branch is a verified negative recovery signal", async (t) => {
  const { lead } = fixture(t);
  const { createLeadGitHandoff } = await load();
  const handoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await handoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const result = await handoff.recover({ job: { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" } });
  assert.equal(result.recovered, false); assert.equal(result.retryable, true);
  assert.match(result.reason, /no pushed commit/);
});

test("scope violation is rejected before commit or push", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const artifact = await createLeadGitHandoff({ root: lead, integrationBranch: "feature" }).prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const handoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await handoff.prepare(job);
  writeFileSync(join(workspace.root, "b.txt"), "outside\n");
  await assert.rejects(() => handoff.finish({ job, workspace }), /outside assignment/);
  assert.equal(git(workspace.root, "rev-parse", "HEAD"), artifact.baseCommit);
});

test("worker observation fingerprints content, index, file type, mode and deletion", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const artifact = await createLeadGitHandoff({ root: lead, integrationBranch: "feature" }).prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt", "extra"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const handoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await handoff.prepare(job);
  const observe = async () => (await handoff.observe({ job, workspace, result: {} })).fingerprint as string;
  const file = join(workspace.root, "a.txt"), extra = join(workspace.root, "extra");
  const initial = await observe();
  writeFileSync(file, "secret-one\n");
  const first = await observe();
  assert.notEqual(first, initial);
  assert.equal(first, await observe());
  assert.doesNotMatch(first, /secret-one/);
  writeFileSync(file, "secret-two\n");
  const second = await observe();
  assert.notEqual(second, first);
  git(workspace.root, "add", "a.txt");
  const staged = await observe();
  assert.notEqual(staged, second);
  writeFileSync(file, "base\n");
  const restoredWorktree = await observe();
  assert.notEqual(restoredWorktree, initial);
  writeFileSync(file, "secret-three\n");
  git(workspace.root, "add", "a.txt");
  writeFileSync(file, "base\n");
  assert.notEqual(await observe(), restoredWorktree, "staged content remains observable when worktree is restored");
  writeFileSync(extra, "untracked\n");
  const untracked = await observe();
  writeFileSync(extra, "changed untracked\n");
  assert.notEqual(await observe(), untracked);
  const beforeMode = await observe();
  chmodSync(extra, 0o755);
  assert.notEqual(await observe(), beforeMode);
  rmSync(extra);
  symlinkSync("a.txt", extra);
  const link = await observe();
  rmSync(extra);
  symlinkSync("b.txt", extra);
  assert.notEqual(await observe(), link);
  rmSync(file);
  const deleted = await observe();
  assert.notEqual(deleted, restoredWorktree);
  assert.equal(deleted, await observe());
  writeFileSync(join(workspace.root, "b.txt"), "outside\n");
  await assert.rejects(() => observe(), /outside assignment/);
});

test("lead rejects a fabricated report and a stale remote branch", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const handoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await handoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const workerHandoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await workerHandoff.prepare(job);
  writeFileSync(join(workspace.root, "a.txt"), "worker\n");
  const report = await workerHandoff.finish({ job, workspace });
  assert.match((await handoff.verify({ job: { ...job, report: { ...report, changedPaths: ["b.txt"] } } })).reason, /do not match/);
  assert.match((await handoff.verify({ job: { ...job, report: { ...report, commitSha: artifact.baseCommit } } })).reason, /does not match/);
  // A pushed branch can be recovered from Git after a worker report is lost.
  assert.equal((await handoff.verify({ job: { ...job, report } })).valid, true);
});

test("integration conflict leaves lead checkout clean and commit unintegrated", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const handoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await handoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const workerHandoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await workerHandoff.prepare(job);
  writeFileSync(join(workspace.root, "a.txt"), "worker\n");
  const report = await workerHandoff.finish({ job, workspace });
  writeFileSync(join(lead, "a.txt"), "lead\n");
  git(lead, "add", "a.txt");
  git(lead, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "lead edit");
  const before = git(lead, "rev-parse", "HEAD");
  await assert.rejects(() => handoff.integrate({ job: { ...job, report } }), /integration conflict/);
  assert.equal(git(lead, "rev-parse", "HEAD"), before);
  assert.equal(git(lead, "status", "--porcelain"), "");
});

test("retry after a rejected push publishes an already-integrated local commit", async (t) => {
  const { parent, remote, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const handoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await handoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const workerHandoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await workerHandoff.prepare(job);
  writeFileSync(join(workspace.root, "a.txt"), "worker\n");
  const report = await workerHandoff.finish({ job, workspace });
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  await assert.rejects(() => handoff.integrate({ job: { ...job, report } }), /remote push failed/);
  assert.equal(git(lead, "merge-base", "--is-ancestor", report.commitSha, "HEAD"), "");
  rmSync(hook);
  const retry = await handoff.integrate({ job: { ...job, report } });
  assert.equal(retry.alreadyIntegrated, true);
  assert.equal(git(remote, "rev-parse", "refs/heads/feature"), git(lead, "rev-parse", "HEAD"));
});

test("replacement lead fast-forwards a stale clean integration checkout", async (t) => {
  const { parent, remote, lead, worker } = fixture(t);
  const replacement = join(parent, "replacement");
  git(parent, "clone", "-b", "feature", remote, replacement);
  const { createLeadGitHandoff, createWorkerGitHandoff } = await load();
  const first = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await first.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-a" };
  const workerHandoff = createWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await workerHandoff.prepare(job);
  writeFileSync(join(workspace.root, "a.txt"), "worker\n");
  const report = await workerHandoff.finish({ job, workspace });
  await first.integrate({ job: { ...job, report } });
  const second = createLeadGitHandoff({ root: replacement, integrationBranch: "feature" });
  const next = await second.prepare({ taskId: "task-a", item: { id: "T2", ownedPaths: ["b.txt"] } });
  assert.equal(next.baseCommit, git(remote, "rev-parse", "refs/heads/feature"));
  assert.equal(git(replacement, "rev-parse", "HEAD"), next.baseCommit);
});


test("isolated worker hands off only validated snapshot changes", async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff, createIsolatedWorkerGitHandoff } = await load();
  const leadHandoff = createLeadGitHandoff({ root: lead, integrationBranch: "feature" });
  const artifact = await leadHandoff.prepare({ taskId: "task-a", item: { id: "T1", ownedPaths: ["a.txt"] } });
  const job = { ...artifact, taskId: "task-a", itemId: "T1", assignmentId: "job-isolated" };
  const handoff = createIsolatedWorkerGitHandoff({ root: worker, worktreesRoot: join(parent, "worktrees") });
  const workspace = await handoff.prepare(job);
  assert.equal(readFileSync(join(workspace.root, "a.txt"), "utf8"), "base\n");
  assert.throws(() => readFileSync(join(workspace.root, ".git")), /ENOENT/);
  writeFileSync(join(workspace.root, "b.txt"), "outside\n");
  await assert.rejects(() => handoff.finish({job, workspace}), /outside its scope/);
  assert.equal(readFileSync(join(workspace.checkout.root, "b.txt"), "utf8"), "base\n");
  writeFileSync(join(workspace.root, "b.txt"), "base\n");
  writeFileSync(join(workspace.root, "a.txt"), "isolated\n");
  const report = await handoff.finish({job, workspace});
  assert.deepEqual(report.changedPaths, ["a.txt"]);
  assert.equal((await leadHandoff.verify({job:{...job,report}})).valid, true);
});

test("fleet worker executes isolated Docker image and pushes a scoped commit", { skip: !process.env.AIDLC_TEST_DOCKER_IMAGE }, async (t) => {
  const { parent, lead, worker } = fixture(t);
  const { createLeadGitHandoff } = await load();
  const { runFleetCli } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet-cli.mjs")) as any;
  const leadHandoff = createLeadGitHandoff({root:lead,integrationBranch:"feature"});
  const artifact=await leadHandoff.prepare({taskId:"task-a",item:{id:"T1",ownedPaths:["a.txt"],agent:"codex"}});
  const job: any={...artifact,id:"job-docker",taskId:"task-a",itemId:"T1",workerId:"worker",agent:"codex",state:"ready",attempt:1,epoch:0};
  let revision=0; let reported: any;
  const callTool=async ({name,args}:any) => {
    if(name==="fleet_get") return {revision,fleet:{jobs:{[job.id]:job}}};
    if(name==="job_claim") {job.state="leased";job.epoch=1;revision++;return {fleet:{jobs:{[job.id]:job}}};}
    if(name==="job_checkpoint" || name==="job_heartbeat") {revision++;return {};}
    if(name==="job_report") {reported=args;revision++;return {};}
    if(name==="task_get") return {revision:1,task:{id:"task-a",title:"Test",tasks:[{id:"T1",status:"todo"}]},nextAction:{classification:"run_phase",phase:"build"}};
    throw new Error(`Unexpected ${name}`);
  };
  const env={...process.env,AIDLC_WORKER_DOCKER_IMAGE:process.env.AIDLC_TEST_DOCKER_IMAGE,OPENAI_API_KEY:"dummy",AIDLC_FLEET_WORKER_AGENT:"codex",AIDLC_FLEET_PROJECT_ROOT:worker,AIDLC_FLEET_URL:"https://example.invalid",AIDLC_FLEET_TOKEN:"dummy",AIDLC_FLEET_WORKSPACE:"test",AIDLC_FLEET_WORKER_ID:"worker",AIDLC_FLEET_WORKTREES_ROOT:join(parent,"worktrees")};
  const result=await runFleetCli(["worker","--once"],{env,callTool,out:()=>{}});
  assert.equal(result.status,"reported"); assert.deepEqual(reported.changedPaths,["a.txt"]);
  assert.equal((await leadHandoff.verify({job:{...job,report:{commitSha:reported.commitSha,changedPaths:reported.changedPaths}}})).valid,true);
});
