import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-identity-model.mjs"));

test("deriveLoopIdentity returns null without a model or requirement", async () => {
  const { deriveLoopIdentity } = await load();
  assert.equal(await deriveLoopIdentity("Fix login", {}), null);
  assert.equal(await deriveLoopIdentity("Fix login", { model: "" }), null);
  assert.equal(await deriveLoopIdentity("  ", { model: "test/model" }), null);
});

test("deriveLoopIdentity accepts valid strict JSON and rejects invalid output", async () => {
  const { deriveLoopIdentity } = await load();
  const model = "test/model";
  const run = (output: string) => async () => output;
  assert.deepEqual(
    await deriveLoopIdentity("Fix login", { model, run: run('```json\n{"title":"Fix login","slug":"fix-login"}\n```') }),
    { title: "Fix login", slug: "fix-login" },
    "fenced JSON is accepted");
  assert.deepEqual(
    await deriveLoopIdentity("x", { model, run: run('{"title":"Add login retry","slug":"add-login-retry"}') }),
    { title: "Add login retry", slug: "add-login-retry" });
  assert.equal(await deriveLoopIdentity("x", { model, run: run('{"title":"ok","slug":"BAD SLUG"}') }), null, "invalid slug");
  assert.equal(await deriveLoopIdentity("x", { model, run: run('{"slug":"ok"}') }), null, "missing title");
  assert.equal(await deriveLoopIdentity("x", { model, run: run('{"title":"","slug":"ok"}') }), null, "empty title");
  assert.equal(await deriveLoopIdentity("x", { model, run: run("no json here") }), null);
  assert.equal(await deriveLoopIdentity("x", { model, run: run(JSON.stringify({ title: "t".repeat(101), slug: "ok" })) }), null, "title over 100 characters");
});

test("deriveLoopIdentity returns null when the runner fails or times out", async () => {
  const { deriveLoopIdentity } = await load();
  assert.equal(await deriveLoopIdentity("x", { model: "test/model", run: async () => { throw new Error("boom"); } }), null);
  assert.equal(await deriveLoopIdentity("x", { model: "test/model", timeoutMs: 5, run: async () => { await new Promise((wait) => setTimeout(wait, 30)); return '{"title":"late","slug":"late"}'; } }), null);
});

test("deriveLoopIdentity passes the model and a strict-JSON prompt to the runner", async () => {
  const { deriveLoopIdentity } = await load();
  const seen: { options?: { model: string; prompt: string; timeoutMs: number; env: Record<string, string> } } = {};
  const result = await deriveLoopIdentity("Fix login", { model: "test/model", run: async (options: { model: string; prompt: string; timeoutMs: number; env: Record<string, string> }) => { seen.options = options; return '{"title":"Fix login","slug":"fix-login"}'; } });
  assert.deepEqual(result, { title: "Fix login", slug: "fix-login" });
  assert.equal(seen.options?.model, "test/model");
  assert.match(seen.options?.prompt ?? "", /STRICT JSON/);
  assert.match(seen.options?.prompt ?? "", /Fix login/);
  assert.equal(typeof seen.options?.timeoutMs, "number");
});
