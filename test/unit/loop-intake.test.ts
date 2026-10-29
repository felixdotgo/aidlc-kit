import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-intake.mjs"));

test("intake retries match the original requirement and authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-intake-"));
  const { prepareLoopIntake } = await load();
  const tasks = new Map<string, { id: string; title: string }>();
  let creates = 0;
  const options = { root, taskId: "login", requirement: "Add login\nUsing email", authority: "local",
    readTask: async (id: string) => tasks.get(id),
    createTask: async ({ taskId, title }: { taskId: string; title: string }) => { creates++; tasks.set(taskId, { id: taskId, title }); } };
  try {
    await prepareLoopIntake(options);
    await prepareLoopIntake(options);
    assert.equal(creates, 1);
    await assert.rejects(() => prepareLoopIntake({ ...options, authority: "fleet" }), /different authority/);
    await assert.rejects(() => prepareLoopIntake({ ...options, requirement: "Other" }), /different authority or requirement/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("intake refuses to take over an unrelated task", async () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-intake-"));
  const { prepareLoopIntake } = await load();
  try {
    await assert.rejects(() => prepareLoopIntake({ root, taskId: "login", requirement: "Add login", authority: "local", readTask: async () => ({ id: "login", title: "Add login" }), createTask: async () => {} }), /no matching loop intake/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
