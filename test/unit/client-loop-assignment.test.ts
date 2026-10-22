import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { adapters } from "../../src/adapters.js";

const scripts = resolve("dist/assets/.agents/aidlc/scripts");
const store = await import(pathToFileURL(join(scripts, "lib/assignment-store.mjs")).href);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aidlc-client-loop-"));
  cpSync(resolve("dist/assets/.agents/aidlc"), join(root, ".agents/aidlc"), { recursive: true });
  mkdirSync(join(root, ".agents/data/state"), { recursive: true });
  const taskId = "client-task";
  const task = { id: taskId, title: "Feature", type: "infra", phase: "build", gate: "G2_codereview", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: `.agents/data/tasks/${taskId}/intent.md`, design: `.agents/data/tasks/${taskId}/design.md`, workplan: `.agents/data/tasks/${taskId}/workplan.md` }, decisions: [], tasks: [{ id: "api", label: "API", area: "root", status: "todo" }, { id: "ui", label: "UI", area: "root", status: "todo", dependsOn: ["api"] }, { id: "docs", label: "Docs", area: "root", status: "todo" }], evidence: [], createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z" };
  writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), JSON.stringify({ schemaVersion: 4, tasks: { [taskId]: task }, archive: {} }));
  return { root, taskId };
}

test("client instructions keep gates in the conversation and use native workers", () => {
  for (const adapter of adapters) {
    const text = adapter.files().map((file) => file.content).join("\n");
    assert.match(text, /current client conversation/);
    assert.match(text, /native collaboration\/delegation/);
    assert.match(text, /assignment\.mjs reconcile/);
    assert.doesNotMatch(text, /loop\.mjs run/);
  }
});

test("local claims reject dependencies, overlap and duplicate dispatch; canonical completion reconciles", () => {
  const { root, taskId } = fixture();
  try {
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "ui", workerId: "worker-ui", ownedPaths: ["src/ui"] }), /prerequisite/);
    const api = store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "worker-api", ownedPaths: ["src/api"] });
    assert.equal(api.state, "leased");
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "worker-api-2", ownedPaths: ["src/other"] }), /already leased/);
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "docs", workerId: "worker-docs", ownedPaths: ["src/api/index.ts"] }), /overlaps/);
    const docs = store.claimLocalAssignment(root, { taskId, itemId: "docs", workerId: "worker-docs", ownedPaths: ["docs"] });
    assert.notEqual(api.id, docs.id);
    store.heartbeatLocalAssignment(root, taskId, api.id, 5000, "native-session");
    assert.throws(() => store.reportLocalAssignment(root, taskId, api.id, { changedPaths: ["src/ui/index.ts"] }), /outside assignment scope/);
    const reported = store.reportLocalAssignment(root, taskId, api.id, { checkpoint: "API built", changedPaths: ["src/api/index.ts"] });
    assert.equal(reported.state, "reported");
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "retry", ownedPaths: ["src/api"] }), /unresolved/);
    const raw = JSON.parse(readFileSync(join(root, ".agents/data/state/aidlc-state.json"), "utf8"));
    raw.tasks[taskId].tasks[0].status = "done";
    writeFileSync(join(root, ".agents/data/state/aidlc-state.json"), JSON.stringify(raw));
    assert.equal(store.reconcileLocalAssignments(root, taskId).assignments.find((entry: { id: string }) => entry.id === api.id).state, "integrated");
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "retry", ownedPaths: ["src/api"] }), /not dispatchable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("expired claim becomes uncertain and needs explicit release before retry", () => {
  const { root, taskId } = fixture();
  try {
    const claim = store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "worker-api", ownedPaths: ["src/api"] });
    const path = store.assignmentPath(root, taskId);
    const record = JSON.parse(readFileSync(path, "utf8"));
    record.assignments[0].leaseExpiresAt = "2020-01-01T00:00:00.000Z";
    writeFileSync(path, JSON.stringify(record));
    assert.equal(store.reconcileLocalAssignments(root, taskId).assignments[0].state, "uncertain");
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "retry", ownedPaths: ["src/api"] }), /unresolved/);
    assert.throws(() => store.claimLocalAssignment(root, { taskId, itemId: "docs", workerId: "other", ownedPaths: ["src/api/index.ts"] }), /overlaps/);
    store.releaseLocalAssignment(root, taskId, claim.id);
    assert.equal(store.claimLocalAssignment(root, { taskId, itemId: "api", workerId: "retry", ownedPaths: ["src/api"] }).attempt, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assignment command works on installed assets and symlink paths fail closed", () => {
  const { root, taskId } = fixture();
  try {
    const path = join(root, ".agents/data/loop");
    mkdirSync(path, { recursive: true });
    symlinkSync(join(root, "missing"), join(path, "assignments"));
    assert.throws(() => store.showLocalAssignments(root, taskId), /symlink/);
    rmSync(join(path, "assignments"));
    const output = execFileSync(process.execPath, [join(scripts, "assignment.mjs"), "claim", taskId, "api", "--worker", "native-worker", "--paths", "src/api", "--root", root], { encoding: "utf8" });
    assert.equal(JSON.parse(output).result.itemId, "api");
    const result = spawnSync(process.execPath, [join(scripts, "assignment.mjs"), "claim", taskId, "api", "--worker", "other", "--paths", "src/api", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /already leased/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
