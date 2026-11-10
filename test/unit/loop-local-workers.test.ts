import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Fake `docker` on PATH standing in for the engine: `image inspect` yields an
// immutable id, `run … --version` passes preflight, and `run … exec` plays a
// one-turn codex session that edits a.txt in the bind-mounted snapshot and
// writes to both stdout (JSONL) and stderr. A marker file `fail-<itemId>` in
// the worktrees root (the snapshot's parent) makes that item's turn exit 1
// instead (simulated job failure). Every invocation is logged.
function fakeDocker(dir: string) {
  const bin = join(dir, "bin"), log = join(dir, "docker.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  image) printf 'sha256:%064d\\n' 0; exit 0 ;;
  run)
    cat >/dev/null
    for last; do :; done
    [ "$last" = "--version" ] && exit 0
    ws=""
    for arg; do case "$arg" in type=bind,src=*,dst=/workspace) ws=\${arg#type=bind,src=}; ws=\${ws%,dst=/workspace} ;; esac; done
    item=""
    for arg; do case "$arg" in aidlc.item=*) item=\${arg#aidlc.item=} ;; esac; done
    if [ -n "$item" ] && [ -e "$(dirname "$ws")/fail-$item" ]; then
      printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
      printf 'simulated worker failure for %s\\n' "$item" >&2
      exit 1
    fi
    printf 'isolated\\n' > "$ws/a.txt"
    printf '%s\\n' '{"type":"thread.started","thread_id":"thread-1"}'
    printf 'fake docker stderr\\n' >&2
    printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Done.\\nAI-DLC-COMMIT: feat(a): isolate a.txt\\nAI-DLC-ITEM-COMPLETE"}}'
    printf '%s\\n' '{"type":"turn.completed"}'
    exit 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  return { bin, lines: () => readFileSync(log, "utf8").trim().split("\n") };
}

test("local worker batch labels its container and records the container index and raw log", { skip: process.platform !== "linux" || !process.getuid?.() }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const docker = fakeDocker(join(root, "..", "fake"));
  const prior = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.PATH = `${docker.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`; process.env.OPENAI_API_KEY = "test-only";
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const events: any[] = [], recorded: string[][] = [];
  const recordIntegration = async (_root: string, taskId: string, assignmentId: string, commit: string) => { recorded.push([taskId, assignmentId, commit]); };
  const result = await runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks, recordIntegration, onEvent: (event: any) => { events.push(event); }, docker: { image: "worker:test", credentials: { codex: ["OPENAI_API_KEY"] } } });
  assert.equal(result.length, 1); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "isolated\n");
  assert.deepEqual(recorded, [["task", "assignment", result[0].integrationCommit]]);
  const run = docker.lines().find((line) => line.startsWith("run ") && line.includes(" exec "));
  assert.ok(run, "worker turn ran through docker");
  const name = run!.match(/--name (aidlc-worker-[0-9a-f-]+)/)![1]!;
  assert.ok(run!.includes(`--name ${name} --label aidlc.task=task --label aidlc.item=one --label aidlc.worker=worker --label aidlc.assignment=assignment --read-only`), run);
  assert.ok(!docker.lines().some((line) => line.includes("--version") && line.includes("--label")), "preflight carries no labels");
  const workers = join(root, ".agents/data/tasks/task/runtime/workers");
  const index = JSON.parse(readFileSync(join(workers, "index.json"), "utf8"));
  assert.equal(index.length, 1);
  const { startedAt, endedAt, host, ...entry } = index[0];
  assert.deepEqual(entry, { name, assignmentId: "assignment", itemId: "one", workerId: "worker", agent: "codex", mode: "local", turn: 1, exitCode: 0, log: "assignment.log" });
  assert.ok(typeof host === "string" && host && Date.parse(startedAt) <= Date.parse(endedAt));
  const text = readFileSync(join(workers, "assignment.log"), "utf8");
  assert.ok(text.startsWith(`--- turn 1 container ${name} `), text);
  assert.ok(text.includes('{"type":"thread.started","thread_id":"thread-1"}\n') && text.includes("fake docker stderr\n") && text.includes('{"type":"turn.completed"}\n'), "raw stdout and stderr are teed");
  assert.match(text, new RegExp(`\\n--- end turn 1 container ${name} exit 0 [^ ]+ ---\\n$`));
  // Raw output never leaks into the live log: agent text stays a one-line summary and no diagnostic was needed.
  assert.ok(!events.some((event) => event.type === "diagnostic"), JSON.stringify(events.filter((event) => event.type === "diagnostic")));
  for (const event of events.filter((candidate) => candidate.type === "agent_text")) assert.ok(!/\n/.test(event.text) && !event.text.includes("AI-DLC-ITEM-COMPLETE"));
  assert.ok(events.some((event) => event.type === "job_integrated" && event.actor === "worker"));
});

test("Docker worker isolates and integrates its scoped snapshot", { skip: !process.env.AIDLC_TEST_WORKER_IMAGE }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const prior = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; });
  const events: any[] = [], recorded: string[][] = [];
  const recordIntegration = async (_root: string, taskId: string, assignmentId: string, commit: string) => { recorded.push([taskId, assignmentId, commit]); };
  const result = await runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks, recordIntegration, onEvent: (event: any) => { events.push(event); }, docker: { image: process.env.AIDLC_TEST_WORKER_IMAGE, credentials: { codex: ["OPENAI_API_KEY"] } } });
  assert.equal(result.length, 1); assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "isolated\n");
  assert.deepEqual(recorded, [["task", "assignment", result[0].integrationCommit]]);
  const integrated = events.find((event) => event.type === "job_integrated");
  assert.equal(integrated.actor, "worker"); assert.equal(integrated.itemId, "one"); assert.equal(integrated.phase, "build");
  assert.ok(events.some((event) => event.type === "worker_turn_start" && event.actor === "worker" && event.itemId === "one"));
  for (const event of events.filter((candidate) => candidate.type === "agent_text")) { assert.equal(event.actor, "worker"); assert.ok(!/\n/.test(event.text) && event.text.length <= 240, "worker text is a one-line summary"); }
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

// Two non-overlapping single-file jobs driven by the fake docker above: `one`
// edits a.txt (succeeds), `two` owns b.txt and is marked failing per test.
const pairJobs = [
  { itemId: "one", workerId: "w1", agent: "codex", ownedPaths: ["a.txt"], prompt: "Implement A" },
  { itemId: "two", workerId: "w2", agent: "codex", ownedPaths: ["b.txt"], prompt: "Implement B" },
];
const commitB = (root: string) => {
  writeFileSync(join(root, "b.txt"), "base\n"); git(root, "add", "b.txt");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "b");
};
// Per-item assignment ids and recorded hook calls, so a test can tell which
// claim was released or reported.
const pairHooks = () => {
  const released: string[] = [], reported: string[] = [];
  return {
    released, reported,
    claim: async (_root: string, { itemId }: { itemId: string }) => ({ id: `asg-${itemId}` }),
    heartbeat: async () => {},
    report: async (_root: string, _taskId: string, assignmentId: string) => { reported.push(assignmentId); },
    release: async (_root: string, _taskId: string, assignmentId: string) => { released.push(assignmentId); },
  };
};
// Put fake bins on PATH (docker and/or git) for one batch run, like the existing
// docker tests do, and restore the environment afterwards.
function fakeEnv(t: any, ...bins: string[]) {
  const prior = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.PATH = `${bins.join(":")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  process.env.OPENAI_API_KEY = "test-only";
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A `git` that delegates everything to the real binary except cherry-picks,
// which it refuses like a conflicting pick (git prints the conflict detail and
// exits 1). Lets the batch integration loop hit a real cherry-pick failure.
function conflictGit(dir: string) {
  const bin = join(dir, "bin"), realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/bin/sh
is_pick=0; is_abort=0
for arg; do case "$arg" in cherry-pick) is_pick=1 ;; --abort) is_abort=1 ;; esac; done
if [ "$is_pick" = 1 ] && [ "$is_abort" = 0 ]; then
  printf 'error: could not apply simulated conflict\\n' >&2
  printf 'hint: after resolving the conflicts, mark the corrected paths\\n' >&2
  exit 1
fi
exec '${realGit}' "$@"
`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

test("batch integrates a fulfilled job when a sibling fails and releases the failed claim", { skip: process.platform !== "linux" || !process.getuid?.() }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  commitB(root);
  const docker = fakeDocker(join(root, "..", "fake"));
  mkdirSync(worktreesRoot, { recursive: true }); writeFileSync(join(worktreesRoot, "fail-two"), "fail\n");
  fakeEnv(t, docker.bin);
  const events: any[] = [], recorded: string[][] = [], hooks = pairHooks();
  const recordIntegration = async (_root: string, taskId: string, assignmentId: string, commit: string) => { recorded.push([taskId, assignmentId, commit]); };
  const result = await runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: pairJobs, ...hooks, recordIntegration, onEvent: (event: any) => { events.push(event); }, docker: { image: "worker:test", credentials: { codex: ["OPENAI_API_KEY"] } } });
  assert.equal(result.length, 1);
  assert.equal(result[0].itemId, "one");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "isolated\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base\n");
  assert.deepEqual(hooks.reported, ["asg-one"]);
  assert.deepEqual(hooks.released, ["asg-two"], "only the failed job's claim is released");
  assert.deepEqual(recorded, [["task", "asg-one", result[0].integrationCommit]]);
  assert.ok(events.some((event) => event.type === "job_integrated" && event.itemId === "one"), "the good commit is integrated");
  const partial = events.find((event) => event.type === "build_partial");
  assert.ok(partial, "partial integration is announced");
  assert.match(partial.message, /not integrated: two \(codex exited 1: simulated worker failure for two\)/);
});

test("batch throws and integrates nothing when every job fails", { skip: process.platform !== "linux" || !process.getuid?.() }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  commitB(root);
  const docker = fakeDocker(join(root, "..", "fake"));
  mkdirSync(worktreesRoot, { recursive: true });
  writeFileSync(join(worktreesRoot, "fail-one"), "fail\n");
  writeFileSync(join(worktreesRoot, "fail-two"), "fail\n");
  fakeEnv(t, docker.bin);
  const hooks = pairHooks();
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs: pairJobs, ...hooks, docker: { image: "worker:test", credentials: { codex: ["OPENAI_API_KEY"] } } }), /Local worker batch failed: codex exited 1: simulated worker failure for one; codex exited 1: simulated worker failure for two; released assignment\(s\) for retry: one, two/);
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base\n");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base\n");
  assert.deepEqual(hooks.released, ["asg-one", "asg-two"]);
});

test("batch emits integration_blocked for a dirty checkout, holds the reported claim, and throws", { skip: process.platform !== "linux" || !process.getuid?.() }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const docker = fakeDocker(join(root, "..", "fake"));
  fakeEnv(t, docker.bin);
  const events: any[] = [], hooks = pairHooks();
  // The dirty path appears only after the worker reported, so the batch starts
  // clean and the per-result integration guard trips on it.
  hooks.report = async (_root: string, _taskId: string, assignmentId: string) => { hooks.reported.push(assignmentId); writeFileSync(join(root, "dirty.txt"), "dirty\n"); };
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks, onEvent: (event: any) => { events.push(event); }, docker: { image: "worker:test", credentials: { codex: ["OPENAI_API_KEY"] } } }), /Local worker batch requires reconciliation: integration blocked for one: Local integration worktree must be clean outside workflow data: dirty\.txt; released: none; still held: one \(reported, not integrated\)/);
  const blockedEvent = events.find((event) => event.type === "integration_blocked");
  assert.ok(blockedEvent, "integration_blocked event is emitted");
  assert.equal(blockedEvent.taskId, "task"); assert.equal(blockedEvent.itemId, "one"); assert.equal(blockedEvent.assignmentId, "asg-one");
  assert.match(blockedEvent.message, /dirty\.txt/);
  assert.deepEqual(hooks.reported, ["asg-one"]);
  assert.deepEqual(hooks.released, [], "the reported claim is held, never auto-released");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base\n", "nothing integrated");
});

test("batch emits integration_blocked for a cherry-pick conflict and holds the claim", { skip: process.platform !== "linux" || !process.getuid?.() }, async (t) => {
  const { root, worktreesRoot } = fixture(t), { runLocalWorkerBatch } = await load();
  const docker = fakeDocker(join(root, "..", "fake"));
  fakeEnv(t, docker.bin, conflictGit(join(root, "..", "fake-git")));
  const events: any[] = [], hooks = pairHooks();
  await assert.rejects(() => runLocalWorkerBatch({ root, worktreesRoot, taskId: "task", jobs, ...hooks, onEvent: (event: any) => { events.push(event); }, docker: { image: "worker:test", credentials: { codex: ["OPENAI_API_KEY"] } } }), /Local worker batch requires reconciliation: integration blocked for one: .*could not apply simulated conflict hint: after resolving the conflicts, mark the corrected paths\s*; released: none; still held: one \(reported, not integrated\)/);
  const blockedEvent = events.find((event) => event.type === "integration_blocked");
  assert.ok(blockedEvent, "integration_blocked event is emitted");
  assert.match(blockedEvent.message, /could not apply simulated conflict/);
  assert.equal(blockedEvent.message.split("could not apply simulated conflict").length, 2, "the git conflict detail appears exactly once (no execFileSync duplication)");
  assert.deepEqual(hooks.reported, ["asg-one"]);
  assert.deepEqual(hooks.released, [], "the conflicted claim is held, never auto-released");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "base\n", "the aborted pick left the checkout unchanged");
});
