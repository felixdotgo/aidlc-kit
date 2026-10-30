import assert from "node:assert/strict";
import test from "node:test";
import type { Phase, TaskState, WorkflowState } from "../../src/model.js";
import { hasAreaVerification, nextAction, transitionDiagnostics, transitionTask, validateState } from "../../src/state.js";

// @ts-ignore -- runtime conformance against the dependency-free ESM core.
import * as mjs from "../../services/aidlc-coordination/src/lifecycle-core.mjs";

const FIXED_TS = "2026-01-01T00:00:01.000Z";
const NORMALIZED_UPDATED_AT = "2026-01-01T00:00:00.000Z";
const TASK_ID = "core-fixture";
const PHASES: Phase[] = ["clarify", "plan", "build", "wrap", "done"];

const nextPhase = (phase: Phase): Phase | undefined => {
  const index = PHASES.indexOf(phase);
  return index >= 0 && index < PHASES.length - 1 ? PHASES[index + 1] : undefined;
};

const baseTask = (): TaskState => ({
  id: TASK_ID, title: "Shared-core fixture", type: "infra", phase: "clarify", gate: "G0_confirm", status: "active", language: "en", risk: "normal", areas: ["root"], branch: "—",
  artifacts: { intent: ".agents/data/tasks/core-fixture/intent.md", design: ".agents/data/tasks/core-fixture/design.md", workplan: ".agents/data/tasks/core-fixture/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
});

const baseState = (): WorkflowState => ({ schemaVersion: 4, tasks: { [TASK_ID]: baseTask() }, archive: {} });

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const messageOf = (error: unknown): string | null => (error instanceof Error ? error.message : error === null ? null : String(error));

test("TS and mjs lifecycle cores agree across seeded random transition sequences", () => {
  const rng = mulberry32(0xA1B2C3D4);
  const ITEM_STATUSES = ["todo", "in_progress", "done", "deferred"] as const;

  for (let seq = 0; seq < 200; seq += 1) {
    const stateTS = structuredClone(baseState());
    const stateMS = structuredClone(baseState());
    const opCount = 5 + Math.floor(rng() * 16);

    for (let step = 0; step < opCount; step += 1) {
      const taskTS = stateTS.tasks[TASK_ID]!;
      const taskMS = stateMS.tasks[TASK_ID]!;

      const applicable: number[] = [];
      if (taskTS.gate !== "none") applicable.push(0, 1);
      applicable.push(2, 3);
      if (taskTS.tasks.length < 5) applicable.push(4);
      if (taskTS.tasks.length > 0) applicable.push(5);
      applicable.push(6);
      if (taskTS.phase !== "done") applicable.push(7);
      applicable.push(8);

      const op = applicable[Math.floor(rng() * applicable.length)]!;

      let errTS: unknown = null;
      let errMS: unknown = null;

      if (op === 0) {
        try {
          const t = stateTS.tasks[TASK_ID]!;
          t.evidence.push({ kind: "approval", gate: t.gate, source: "fuzz", result: "pass", recordedAt: FIXED_TS });
        } catch (error) { errTS = error; }
        try {
          const t = stateMS.tasks[TASK_ID]!;
          t.evidence.push({ kind: "approval", gate: t.gate, source: "fuzz", result: "pass", recordedAt: FIXED_TS });
        } catch (error) { errMS = error; }
      } else if (op === 1) {
        const target = nextPhase(taskTS.phase)!;
        try {
          const t = stateTS.tasks[TASK_ID]!;
          t.evidence.push({ kind: "approval", gate: t.gate, source: "fuzz", result: "pass", recordedAt: FIXED_TS });
          transitionTask(stateTS, TASK_ID, target);
        } catch (error) { errTS = error; }
        try {
          const t = stateMS.tasks[TASK_ID]!;
          t.evidence.push({ kind: "approval", gate: t.gate, source: "fuzz", result: "pass", recordedAt: FIXED_TS });
          mjs.transitionTask(stateMS, TASK_ID, target);
        } catch (error) { errMS = error; }
      } else if (op === 2) {
        const result = rng() < 0.5 ? "pass" : "fail";
        try {
          stateTS.tasks[TASK_ID]!.evidence.push({ kind: "test", area: "root", source: "fuzz", result, recordedAt: FIXED_TS });
        } catch (error) { errTS = error; }
        try {
          stateMS.tasks[TASK_ID]!.evidence.push({ kind: "test", area: "root", source: "fuzz", result, recordedAt: FIXED_TS });
        } catch (error) { errMS = error; }
      } else if (op === 3) {
        const result = rng() < 0.5 ? "pass" : "fail";
        try {
          stateTS.tasks[TASK_ID]!.evidence.push({ kind: "lint", area: "root", source: "fuzz", result, recordedAt: FIXED_TS });
        } catch (error) { errTS = error; }
        try {
          stateMS.tasks[TASK_ID]!.evidence.push({ kind: "lint", area: "root", source: "fuzz", result, recordedAt: FIXED_TS });
        } catch (error) { errMS = error; }
      } else if (op === 4) {
        const n = stateTS.tasks[TASK_ID]!.tasks.length;
        try {
          stateTS.tasks[TASK_ID]!.tasks.push({ id: `I${n}`, label: "x", status: "todo" });
        } catch (error) { errTS = error; }
        try {
          stateMS.tasks[TASK_ID]!.tasks.push({ id: `I${n}`, label: "x", status: "todo" });
        } catch (error) { errMS = error; }
      } else if (op === 5) {
        const items = stateTS.tasks[TASK_ID]!.tasks;
        const idx = Math.floor(rng() * items.length);
        const st = ITEM_STATUSES[Math.floor(rng() * ITEM_STATUSES.length)]!;
        try {
          stateTS.tasks[TASK_ID]!.tasks[idx]!.status = st;
        } catch (error) { errTS = error; }
        try {
          stateMS.tasks[TASK_ID]!.tasks[idx]!.status = st;
        } catch (error) { errMS = error; }
      } else if (op === 6) {
        let naTS: unknown = null;
        let naMS: unknown = null;
        try { naTS = nextAction(stateTS.tasks[TASK_ID]!); } catch (error) { errTS = error; }
        try { naMS = mjs.nextAction(stateMS.tasks[TASK_ID]!); } catch (error) { errMS = error; }
        if (errTS === null && errMS === null) {
          assert.deepEqual(naMS, naTS, `Sequence ${seq} op ${op}: nextAction mismatch`);
        }
      } else if (op === 7) {
        const target = nextPhase(taskTS.phase);
        if (target) {
          let tdTS: unknown = null;
          let tdMS: unknown = null;
          try { tdTS = transitionDiagnostics(stateTS.tasks[TASK_ID]!, target); } catch (error) { errTS = error; }
          try { tdMS = mjs.transitionDiagnostics(stateMS.tasks[TASK_ID]!, target); } catch (error) { errMS = error; }
          if (errTS === null && errMS === null) {
            assert.deepEqual(tdMS, tdTS, `Sequence ${seq} op ${op}: transitionDiagnostics mismatch`);
          }
        }
      } else if (op === 8) {
        let hTS: unknown = null;
        let hMS: unknown = null;
        try { hTS = hasAreaVerification(stateTS.tasks[TASK_ID]!, "root"); } catch (error) { errTS = error; }
        try { hMS = mjs.hasAreaVerification(stateMS.tasks[TASK_ID]!, "root"); } catch (error) { errMS = error; }
        if (errTS === null && errMS === null) {
          assert.equal(hMS, hTS, `Sequence ${seq} op ${op}: hasAreaVerification mismatch`);
        }
      }

      const tsThrew = errTS !== null;
      const msThrew = errMS !== null;
      assert.equal(tsThrew, msThrew, `Sequence ${seq} op ${op}: throw mismatch`);
      if (tsThrew && msThrew) {
        assert.equal(messageOf(errTS), messageOf(errMS), `Sequence ${seq} op ${op}: error message mismatch`);
      }

      if (!tsThrew && !msThrew) {
        const tTS = stateTS.tasks[TASK_ID]!;
        const tMS = stateMS.tasks[TASK_ID]!;
        tTS.updatedAt = NORMALIZED_UPDATED_AT;
        tMS.updatedAt = NORMALIZED_UPDATED_AT;
        assert.deepEqual(tMS, tTS, `Sequence ${seq} op ${op}: task mismatch`);

        assert.deepEqual(mjs.nextAction(tMS), nextAction(tTS), `Sequence ${seq} op ${op}: nextAction mismatch`);

        if (tTS.gate !== "none") {
          const tgt = nextPhase(tTS.phase);
          if (tgt) {
            assert.deepEqual(mjs.transitionDiagnostics(tMS, tgt), transitionDiagnostics(tTS, tgt), `Sequence ${seq} op ${op}: transitionDiagnostics mismatch`);
          }
        }
      }
    }

    let vErrTS: unknown = null;
    let vErrMS: unknown = null;
    try { validateState(stateTS); } catch (error) { vErrTS = error; }
    try { mjs.validateState(stateMS); } catch (error) { vErrMS = error; }
    const vTsThrew = vErrTS !== null;
    const vMsThrew = vErrMS !== null;
    assert.equal(vTsThrew, vMsThrew, `Sequence ${seq}: validateState throw mismatch`);
    if (vTsThrew && vMsThrew) {
      assert.equal(messageOf(vErrTS), messageOf(vErrMS), `Sequence ${seq}: validateState message mismatch`);
    }
  }
});
