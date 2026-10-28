import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const load = async (): Promise<any> => import(resolve("dist/assets/.agents/aidlc/scripts/lib/loop-fleet-cli.mjs"));

for (const role of ["coordinator", "feature"]) for (const once of [false, true]) {
  test(`${role} returns a gate without polling or dispatching further tasks${once ? " (--once)" : ""}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aidlc-fleet-cli-"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    const reads: string[] = [];
    const fleet = { features: { feature: { integrationBranch: "main" } }, jobs: {}, leads: { first: { epoch: 1 } } };
    const callTool = async ({ name, args }: { name: string; args: Record<string, any> }) => {
      if (name === "fleet_get") return { revision: 1, fleet };
      if (name === "feature_ready") return { items: [{ taskId: "first", ready: true, blockers: [] }, { taskId: "second", ready: true, blockers: [] }] };
      if (name === "task_get") {
        reads.push(args.taskId);
        return { revision: 1, task: { id: args.taskId, title: "Review", gate: "G0_confirm", status: "blocked_on_user", risk: "normal", areas: ["root"], artifacts: {}, decisions: [], tasks: [], evidence: [] }, nextAction: { classification: "await_user", gate: "G0_confirm" } };
      }
      if (name === "run_claim" || name === "run_release") return { fleet };
      if (name === "gate_snapshot_put") return { id: "snapshot-1" };
      throw new Error(`Unexpected call ${name}`);
    };
    try {
      mkdirSync(join(root, ".agents/aidlc/scripts"), { recursive: true });
      writeFileSync(join(root, ".agents/aidlc/scripts/remote-state.mjs"), "");
      const env = { AIDLC_FLEET_PROJECT_ROOT: root, AIDLC_FLEET_URL: "https://example.invalid", AIDLC_FLEET_TOKEN: "token", AIDLC_FLEET_WORKSPACE: "workspace", AIDLC_FLEET_WORKER_IDS: "worker", AIDLC_FLEET_INTEGRATION_BRANCH: "main", AIDLC_FLEET_POLL_MS: "1000" };
      const { runFleetCli } = await load();
      const result = await runFleetCli([role, role === "feature" ? "feature" : "first", ...(once ? ["--once"] : [])], { callTool, env, out: () => {}, signal: controller.signal });
      assert.equal(result.status, "gate");
      const gate = role === "feature" ? result.results[0] : result;
      assert.equal(gate.snapshotId, "snapshot-1");
      assert.equal(gate.taskId, "first");
      assert.match(gate.gateView, /Confirm requirements/);
      assert.ok(reads.length > 0);
      assert.ok(reads.every((id) => id === "first"));
    } finally {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
