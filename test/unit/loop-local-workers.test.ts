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
// writes to both stdout (JSONL) and stderr. Every invocation is logged.
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
