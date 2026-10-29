import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-worker-snapshot.mjs"));
function fixture(t: any) {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-snapshot-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, "source"), target = join(parent, "snapshot");
  mkdirSync(source); mkdirSync(target);
  mkdirSync(join(source, ".agents/data"), { recursive: true });
  writeFileSync(join(source, ".agents/data/state.json"), "secret state");
  writeFileSync(join(source, ".git"), "gitdir: /secret");
  writeFileSync(join(source, "a"), "before");
  writeFileSync(join(source, "b"), "other");
  return { source, target, parent };
}

test("snapshot excludes git and lifecycle data and detects scoped changes", async (t) => {
  const { source, target } = fixture(t), { createWorkerSnapshot, inspectWorkerSnapshot } = await load();
  const baseline = createWorkerSnapshot(source, target, ["a", "b"]);
  assert.equal(existsSync(join(target, ".git")), false);
  assert.equal(existsSync(join(target, ".agents/data")), false);
  writeFileSync(join(target, "a"), "after");
  assert.deepEqual(inspectWorkerSnapshot(target, baseline, ["a"]), ["a"]);
  assert.equal(readFileSync(join(source, "a"), "utf8"), "before");
  writeFileSync(join(target, "b"), "outside");
  assert.throws(() => inspectWorkerSnapshot(target, baseline, ["a"]), /outside its scope/);
});

test("snapshot fails closed on links and protected paths", async (t) => {
  const { source, target, parent } = fixture(t), { createWorkerSnapshot, inspectWorkerSnapshot } = await load();
  const baseline = createWorkerSnapshot(source, target, ["a", "b"]);
  symlinkSync(join(parent, "outside"), join(target, "link"));
  assert.throws(() => inspectWorkerSnapshot(target, baseline, ["link"]), /Unsafe worker file/);
  rmSync(join(target, "link"));
  linkSync(join(target, "a"), join(target, "linked"));
  assert.throws(() => inspectWorkerSnapshot(target, baseline, ["a", "linked"]), /Unsafe worker file/);
  rmSync(join(target, "linked"));
  mkdirSync(join(target, ".agents/data"), { recursive: true });
  assert.throws(() => inspectWorkerSnapshot(target, baseline, ["a"]), /protected path/);
});

test("Docker invocation passes only explicit provider credential without exposing it in arguments", async (t) => {
  const { target } = fixture(t);
  const { workerDockerInvocation } = await import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-worker-docker.mjs"));
  const opts = { workspace: target, image: "trusted:tag", command: "codex", args: ["exec"], credentialEnv: ["OPENAI_API_KEY"], hostEnv: { PATH: "/bin", OPENAI_API_KEY: "secret", LEAD_TOKEN: "lead-secret" }, uid: 1000, gid: 1000 };
  const call = workerDockerInvocation(opts);
  assert.deepEqual(call.env, { PATH: "/bin", OPENAI_API_KEY: "secret" });
  assert.equal(call.args.includes("secret"), false);
  for (const flag of ["--read-only", "--cap-drop", "--security-opt", "--user"]) assert.ok(call.args.includes(flag));
  assert.throws(() => workerDockerInvocation({ ...opts, credentialEnv: ["LEAD_TOKEN"] }), /Unsupported/);
  assert.throws(() => workerDockerInvocation({ ...opts, uid: 0 }), /Non-root/);
});
