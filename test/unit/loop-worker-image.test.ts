import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const loadImage = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-worker-image.mjs"));

test("worker image default tag, validation, and Dockerfile path follow the provider convention", async () => {
  const { defaultWorkerImageTag, validWorkerImageTag, workerDockerfilePath } = await loadImage();
  assert.equal(defaultWorkerImageTag("opencode"), "aidlc-worker-opencode:local");
  assert.equal(defaultWorkerImageTag("codex"), "aidlc-worker-codex:local");
  assert.equal(defaultWorkerImageTag("claude"), "aidlc-worker-claude:local");
  assert.equal(validWorkerImageTag("aidlc-worker-opencode:local"), true);
  assert.equal(validWorkerImageTag("bad tag!"), false);
  assert.equal(validWorkerImageTag(undefined), false);
  assert.equal(workerDockerfilePath("/repo", "opencode"), join("/repo", ".agents", "aidlc", "docker", "Dockerfile.opencode"));
});

test("recordWorkerImage persists the tag and preserves the rest of the config", async (t) => {
  const { recordWorkerImage } = await loadImage();
  const dir = mkdtempSync(join(tmpdir(), "aidlc-wimg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agents"), { recursive: true });
  const configPath = join(dir, ".agents", "config.json");
  writeFileSync(configPath, `${JSON.stringify({ loop: { mode: "local", agents: { lead: "opencode", workers: { w1: "codex" } } }, other: 1 }, null, 2)}\n`);
  recordWorkerImage({ root: dir, provider: "codex", image: "aidlc-worker-codex:local" });
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(parsed.loop.workerImage.codex, "aidlc-worker-codex:local");
  assert.equal(parsed.loop.mode, "local");
  assert.equal(parsed.loop.agents.lead, "opencode");
  assert.equal(parsed.other, 1);
});

test("recordWorkerImage is a no-op without a project config", async (t) => {
  const { recordWorkerImage } = await loadImage();
  const dir = mkdtempSync(join(tmpdir(), "aidlc-wimg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordWorkerImage({ root: dir, provider: "opencode", image: "aidlc-worker-opencode:local" });
});

test("buildWorkerImage rejects invalid provider/tag and a missing Dockerfile before invoking docker", async (t) => {
  const { buildWorkerImage } = await loadImage();
  const dir = mkdtempSync(join(tmpdir(), "aidlc-wimg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => buildWorkerImage({ root: dir, provider: "bad", image: "x:local" }), /provider must be/);
  assert.throws(() => buildWorkerImage({ root: dir, provider: "opencode", image: "bad tag!" }), /Explicit Docker image is required/);
  assert.throws(() => buildWorkerImage({ root: dir, provider: "opencode", image: "aidlc-worker-opencode:local" }), /Dockerfile is missing/);
});

test("dockerImageExists returns false for an unknown image without throwing", async () => {
  const { dockerImageExists } = await loadImage();
  assert.equal(dockerImageExists("aidlc-worker-unknown-zzz:local"), false);
});

test("buildWorkerImage builds a shipped Dockerfile and ensureWorkerImage reuses it", { skip: !process.env.AIDLC_TEST_DOCKER }, async (t) => {
  const { buildWorkerImage, ensureWorkerImage, dockerImageExists } = await loadImage();
  const dir = mkdtempSync(join(tmpdir(), "aidlc-wimg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dockerDir = join(dir, ".agents", "aidlc", "docker");
  mkdirSync(dockerDir, { recursive: true });
  writeFileSync(join(dockerDir, "Dockerfile.opencode"), "FROM scratch\n");
  const image = `aidlc-worker-scratch-test:${Date.now()}`;
  assert.equal(dockerImageExists(image), false);
  assert.equal(buildWorkerImage({ root: dir, provider: "opencode", image }), image);
  assert.equal(dockerImageExists(image), true);
  assert.equal(ensureWorkerImage({ root: dir, provider: "opencode", image }), image);
});

test("worker Dockerfiles are shipped in the installed workflow assets", async () => {
  const { coreWorkflowFiles } = await import(resolve("dist/src/workflow.js"));
  const paths = coreWorkflowFiles().map((file: { path: string }) => file.path);
  for (const provider of ["opencode", "codex", "claude"]) {
    assert.ok(paths.includes(`.agents/aidlc/docker/Dockerfile.${provider}`), `expected Dockerfile.${provider} to be shipped`);
  }
});

test("validateLoopConfig accepts a persisted workerImage map and rejects bad entries", async () => {
  const { validateLoopConfig } = await import(resolve("dist/src/profiles.js"));
  const parsed = validateLoopConfig({ mode: "local", agents: { lead: "opencode", workers: { w1: "codex" } }, workerImage: { codex: "aidlc-worker-codex:local" } });
  assert.equal(parsed.workerImage.codex, "aidlc-worker-codex:local");
  assert.throws(() => validateLoopConfig({ mode: "local", workerImage: { nope: "x" } }), /workerImage/);
  assert.throws(() => validateLoopConfig({ mode: "local", workerImage: { codex: "bad tag!" } }), /workerImage/);
});
