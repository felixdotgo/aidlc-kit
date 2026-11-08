import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import type { TaskState } from "../../src/model.js";

/* Containers panel and APIs (`/api/tasks/:id/containers`, `/api/tasks/:id/containers/:assignment/log`)
 * over a real local-mode server on port 0, a temporary project, and a fake `docker` on PATH. */

const UUID_A = "3f2a1b9c-1111-4222-8333-444455556666";
const UUID_B = "9e8d7c6b-1111-4222-8333-444455556666";
const NAME_A = `aidlc-worker-${UUID_A}`;
const NAME_B = `aidlc-worker-${UUID_B}`;

const makeTask = (overrides: Partial<TaskState> = {}): TaskState => {
  const now = new Date().toISOString();
  return {
    id: "task-a", title: "Task A", type: "infra", phase: "build", gate: "G2_codereview", status: "active",
    language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: {},
    decisions: [], tasks: [], evidence: [], createdAt: now, updatedAt: now, ...overrides,
  };
};

const writeFile = (root: string, path: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const workersDir = (taskId: string): string => `.agents/data/tasks/${taskId}/runtime/workers`;
const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: NAME_A, assignmentId: "a1", itemId: "item-a", workerId: "w1", agent: "opencode", mode: "local", host: hostname(), turn: 1,
  startedAt: new Date(Date.now() - 90_000).toISOString(), log: "a1.log", ...overrides,
});
const writeIndex = (root: string, taskId: string, entries: unknown): void =>
  writeFile(root, `${workersDir(taskId)}/index.json`, typeof entries === "string" ? entries : JSON.stringify(entries, null, 2));

interface Fixture { base: string; root: string; close: () => Promise<void> }
const startFixture = async (tasks: TaskState[] = [makeTask()]): Promise<Fixture> => {
  const { emptyState, saveState } = await import("../../src/state.js");
  const { startUiServer } = await import("../../src/task-ui.js");
  const root = mkdtempSync(join(tmpdir(), "aidlc-ui-containers-"));
  const state = emptyState();
  for (const task of tasks) state.tasks[task.id] = task;
  saveState(root, state);
  const { server, port } = await startUiServer({ root, host: "127.0.0.1", port: 0, mode: "local" });
  const close = (): Promise<void> => new Promise<void>((done) => { server.close(() => done()); rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${port}`, root, close };
};

/** Puts a fake `docker` first on PATH; `script` is its sh body. */
const fakeDocker = (dir: string, script: string): { restore: () => void } => {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const previous = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${previous ?? ""}`;
  return { restore: () => { process.env["PATH"] = previous; } };
};

interface ContainersJson { ok: boolean; error?: string; docker?: string; host?: string; containers?: Array<Record<string, unknown> & { assignmentId: string; running: boolean; local: boolean }> }
const getJson = async (url: string): Promise<{ status: number; body: ContainersJson }> => {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as ContainersJson };
};
const getLog = async (url: string): Promise<{ status: number; body: string; type: string | null; size: string | null; truncated: string | null }> => {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type"), size: res.headers.get("x-aidlc-log-size"), truncated: res.headers.get("x-aidlc-log-truncated") };
};

const posix = { skip: process.platform === "win32" };

test("malformed ids and unknown tasks or logs answer 400 / 404 before anything is read", async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, "exit 1");
  try {
    const { base } = fixture;
    assert.equal((await getJson(`${base}/api/tasks/bad%20id/containers`)).status, 400);
    assert.equal((await getJson(`${base}/api/tasks/..%2F..%2Fetc/containers`)).status, 400, "path separators never form a task id");
    assert.equal((await getJson(`${base}/api/tasks/nope/containers`)).status, 404);
    assert.equal((await getLog(`${base}/api/tasks/task-a/containers/bad%20id/log`)).status, 400);
    assert.equal((await getLog(`${base}/api/tasks/task-a/containers/a1/log?tail=abc`)).status, 400, "a non-numeric tail is rejected");
    assert.equal((await getLog(`${base}/api/tasks/task-a/containers/a1/log?tail=0`)).status, 400, "a zero tail is rejected");
    assert.equal((await getLog(`${base}/api/tasks/nope/containers/a1/log`)).status, 404);
    const missing = await getLog(`${base}/api/tasks/task-a/containers/a1/log`);
    assert.equal(missing.status, 404, "no log file yet");
    assert.match(missing.type ?? "", /^text\/plain/);
    const empty = await getJson(`${base}/api/tasks/task-a/containers`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.containers, [], "no runtime directory reads as an empty list");
    assert.equal(empty.body.host, hostname());
  } finally { docker.restore(); await fixture.close(); }
});

test("docker unavailable: the index still answers and running follows endedAt", posix, async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, "exit 1");
  try {
    const { base, root } = fixture;
    writeIndex(root, "task-a", [
      entry({ endedAt: new Date(Date.now() - 30_000).toISOString(), exitCode: 0 }),
      entry({ name: NAME_B, assignmentId: "a2", itemId: "item-b", turn: 2, host: "other-host" }),
      { broken: true },
    ]);
    const res = await getJson(`${base}/api/tasks/task-a/containers`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.docker, "unavailable");
    assert.deepEqual(res.body.containers?.map((c) => [c.assignmentId, c.running, c.local]), [["a1", false, true], ["a2", true, false]], "malformed entries are dropped; running = !endedAt when docker cannot answer");
    assert.equal(res.body.containers?.[0]?.["name"], NAME_A, "index fields pass through");
  } finally { docker.restore(); await fixture.close(); }
});

test("docker lists the task's containers: a listed name is running, an unlisted open entry is not", posix, async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, `[ "$1" = ps ] || exit 1\nprintf '%s\\n' '${NAME_A}'`);
  try {
    const { base, root } = fixture;
    writeIndex(root, "task-a", [entry(), entry({ name: NAME_B, assignmentId: "a2", turn: 2 })]);
    const res = await getJson(`${base}/api/tasks/task-a/containers`);
    assert.equal(res.body.docker, "ok");
    assert.deepEqual(res.body.containers?.map((c) => [c.assignmentId, c.running]), [["a1", true], ["a2", false]]);
    const page = await (await fetch(`${base}/tasks/task-a`)).text();
    assert.match(page, /data-key="panel:Containers"/);
    assert.match(page, /docker · ok/);
    assert.match(page, /data-container-log="a1" data-container-name="aidlc-worker-3f2a1b9c-[^"]+" data-container-running="1"/);
    assert.match(page, /data-container-running="0"/);
    assert.match(page, />running</, "the listed container shows the running pill");
    assert.match(page, />unknown</, "an open entry docker does not list shows unknown");
    assert.match(page, /<code title="aidlc-worker-3f2a1b9c-1111-4222-8333-444455556666">3f2a1b9c<\/code>/, "the name is shortened to the uuid's first 8 chars with the full name in title");
    assert.match(page, /id="container-log" data-live-ignore hidden/, "the viewer is hidden until a Log button is clicked");
  } finally { docker.restore(); await fixture.close(); }
});

test("log tail: default 64 KiB cut at a line boundary with a prefix, ?tail= clamp, and the rotated generation", posix, async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, "exit 1");
  try {
    const { base, root } = fixture;
    const { DEFAULT_TAIL_BYTES, MAX_TAIL_BYTES, TRUNCATED_PREFIX } = await import("../../src/ui/containers.js");
    const lines: string[] = [`--- turn 1 container ${NAME_A} 2026-01-01T00:00:00.000Z ---`];
    for (let i = 0; i < 4000; i += 1) lines.push(`line ${String(i).padStart(5, "0")} ${"x".repeat(40)}`);
    const content = `${lines.join("\n")}\n`;
    assert.ok(content.length > DEFAULT_TAIL_BYTES && content.length < MAX_TAIL_BYTES);
    writeFile(root, `${workersDir("task-a")}/a1.log`, content);

    const tail = await getLog(`${base}/api/tasks/task-a/containers/a1/log`);
    assert.equal(tail.status, 200);
    assert.match(tail.type ?? "", /^text\/plain; charset=utf-8/);
    assert.equal(tail.size, String(content.length));
    assert.equal(tail.truncated, "1");
    assert.ok(tail.body.startsWith(TRUNCATED_PREFIX), "a cut tail is prefixed");
    const rest = tail.body.slice(TRUNCATED_PREFIX.length);
    assert.match(rest, /^line \d{5} x{40}\n/, "the tail starts at a complete line");
    assert.ok(rest.endsWith("line 03999 " + "x".repeat(40) + "\n"), "the tail ends with the file");
    assert.ok(Buffer.byteLength(rest) <= DEFAULT_TAIL_BYTES);
    assert.ok(Buffer.byteLength(rest) > DEFAULT_TAIL_BYTES - 200, "only the partial first line is dropped");

    const whole = await getLog(`${base}/api/tasks/task-a/containers/a1/log?tail=999999999`);
    assert.equal(whole.status, 200);
    assert.equal(whole.truncated, "0", "a tail above the cap is clamped to 1 MiB, which covers the file");
    assert.equal(whole.body, content);

    const small = await getLog(`${base}/api/tasks/task-a/containers/a1/log?tail=100`);
    assert.equal(small.truncated, "1");
    assert.equal(small.body, TRUNCATED_PREFIX + "line 03999 " + "x".repeat(40) + "\n");

    writeFile(root, `${workersDir("task-a")}/a2.log.1`, "rotated output\n");
    const rotated = await getLog(`${base}/api/tasks/task-a/containers/a2/log`);
    assert.equal(rotated.status, 200, "a missing .log falls back to .log.1");
    assert.equal(rotated.body, "rotated output\n");
    assert.equal(rotated.truncated, "0");
  } finally { docker.restore(); await fixture.close(); }
});

test("a symlinked runtime directory is refused: no containers, no log", posix, async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, "exit 1");
  try {
    const { base, root } = fixture;
    const outside = mkdtempSync(join(tmpdir(), "aidlc-ui-containers-outside-"));
    try {
      mkdirSync(join(outside, "workers"), { recursive: true });
      writeFileSync(join(outside, "workers", "index.json"), JSON.stringify([entry()]));
      writeFileSync(join(outside, "workers", "a1.log"), "secret\n");
      mkdirSync(join(root, ".agents/data/tasks/task-a"), { recursive: true });
      symlinkSync(outside, join(root, ".agents/data/tasks/task-a/runtime"));
      const res = await getJson(`${base}/api/tasks/task-a/containers`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.containers, []);
      const log = await getLog(`${base}/api/tasks/task-a/containers/a1/log`);
      assert.equal(log.status, 404);
      assert.doesNotMatch(log.body, /secret/);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { docker.restore(); await fixture.close(); }
});

test("the detail page renders the Containers panel with its empty state; the side-panel fragment has none", posix, async () => {
  const fixture = await startFixture();
  const docker = fakeDocker(fixture.root, "exit 1");
  try {
    const { base, root } = fixture;
    const page = await (await fetch(`${base}/tasks/task-a`)).text();
    assert.match(page, /data-key="panel:Containers"/);
    assert.match(page, /No worker containers recorded for this task/);
    assert.match(page, /Containers appear here while the loop builds/);
    assert.match(page, /docker · unavailable/);
    assert.match(page, /id="container-log" data-live-ignore hidden/);
    assert.match(page, /data-container-follow/);
    assert.match(page, /data-container-close/);
    const panelIndex = page.indexOf('data-key="panel:Containers"');
    assert.ok(page.indexOf('data-key="panel:Work items"') < panelIndex && panelIndex < page.indexOf('data-key="panel:Evidence"'), "between Work items and Evidence");

    const fragment = await (await fetch(`${base}/partial/tasks/task-a`)).text();
    assert.doesNotMatch(fragment, /panel:Containers/);
    assert.doesNotMatch(fragment, /container-log/);

    writeIndex(root, "task-a", [
      entry({ endedAt: new Date(Date.now() - 10_000).toISOString(), exitCode: 3 }),
      entry({ name: NAME_B, assignmentId: "a2", turn: 2, host: "elsewhere", endedAt: new Date().toISOString(), exitCode: null }),
    ]);
    const withRows = await (await fetch(`${base}/tasks/task-a`)).text();
    assert.match(withRows, /<button type="button" class="button is-small" data-container-log="a1"/);
    assert.match(withRows, />exited 3</);
    assert.match(withRows, />signal</);
    assert.match(withRows, /disabled title="log is on another host"/, "a container recorded on another host has no usable Log button");
    assert.match(withRows, /title="recorded on another host">elsewhere</);
    assert.doesNotMatch(withRows, /No worker containers recorded/);

    writeIndex(root, "task-a", "{not json");
    assert.match(await (await fetch(`${base}/tasks/task-a`)).text(), /No worker containers recorded/, "a corrupt index reads as empty");
  } finally { docker.restore(); await fixture.close(); }
});

test("view helpers: short container names and durations", async () => {
  const { shortContainerName, durationText } = await import("../../src/ui/views/task.js");
  assert.equal(shortContainerName(NAME_A), "3f2a1b9c");
  assert.equal(shortContainerName("plain-name"), "plain-name");
  assert.equal(durationText("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:04.000Z"), "4s");
  assert.equal(durationText("2026-01-01T00:00:00.000Z", "2026-01-01T00:03:12.000Z"), "3m 12s");
  assert.equal(durationText("2026-01-01T00:00:00.000Z", "2026-01-01T01:05:00.000Z"), "1h 05m");
  assert.equal(durationText("2026-01-01T00:00:00.000Z", undefined), "");
});
