import { join, resolve } from "node:path";
import type { TaskState } from "../model.js";

export type NextActionActions = Array<{ id: "reopen_g1" | "create_successor" | "supersede" | "close" | "record_handoff" | "resume"; command: string }>;

export interface CommandKit {
  continueItem: (taskId: string, itemId: string) => string;
  continueVerification: (taskId: string) => string;
  continuePhase: (taskId: string, phase: string) => string;
  recoverG1Wait: (taskId: string) => string;
  recoverGatelessWrap: (taskId: string) => string;
  approveGate: (taskId: string, gate: string) => string;
  handoffActions: (task: TaskState) => NextActionActions;
  pausedActions: (taskId: string) => NextActionActions;
  repairHandoffAction: (taskId: string, kind: "review_exhausted" | "repair_exhausted") => NextActionActions;
}

/** Command-string synthesis for `nextAction`: script paths, `--root` suffixes, and CLI placeholders exist only here. */
export const commandKit = (root?: string): CommandKit => {
  const suffix = root === undefined ? "" : ` --root ${JSON.stringify(resolve(root))}`;
  const script = (name: string): string => root === undefined ? `node .agents/aidlc/scripts/${name}` : `node ${JSON.stringify(join(resolve(root), ".agents/aidlc/scripts", name))}`;
  const stateScript = script("state.mjs");
  const contextScript = script("context.mjs");
  return {
    continueItem: (taskId, itemId) => `${contextScript} ${taskId} --phase build --item ${itemId}${suffix}`,
    continueVerification: (taskId) => `${contextScript} ${taskId} --phase build${suffix}`,
    continuePhase: (taskId, phase) => `${contextScript} ${taskId} --phase ${phase}${suffix}`,
    recoverG1Wait: (taskId) => `${contextScript} ${taskId} --phase plan${suffix}`,
    recoverGatelessWrap: (taskId) => `${stateScript} task status ${taskId} --status active${suffix}`,
    approveGate: (taskId, gate) => `${stateScript} gate approve ${taskId} --gate ${gate} --source <explicit-user-approval>${suffix}`,
    handoffActions: (task) => [
      ...(task.phase === "build" ? [{ id: "reopen_g1" as const, command: `${stateScript} task reopen ${task.id} --to plan --reason <reason> --source <explicit-user-request>${suffix}` }] : []),
      { id: "create_successor", command: `${stateScript} task create <new-task-id> --title <title>${suffix}` },
      { id: "supersede", command: `${stateScript} task supersede ${task.id} --successor <new-task-id> --reason <reason> --source <explicit-user-request>${suffix}` },
      { id: "close", command: `${stateScript} task close ${task.id} --reason <reason> --source <explicit-user-request>${suffix}` }
    ],
    pausedActions: (taskId) => [
      { id: "resume", command: `${stateScript} task status ${taskId} --status active${suffix}` },
      { id: "record_handoff", command: `${stateScript} task handoff ${taskId} --kind <kind> --reason <reason> --source <source>${suffix}` }
    ],
    repairHandoffAction: (taskId, kind) => [{ id: "record_handoff", command: `${stateScript} task handoff ${taskId} --kind ${kind} --reason <summary-of-exhausted-repairs> --source <agent>${suffix}` }]
  };
};
