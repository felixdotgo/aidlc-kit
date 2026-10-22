import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
