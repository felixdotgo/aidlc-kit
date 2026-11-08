/** Server options, credential hygiene for child processes, and installed-workflow paths. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type UiAuthorityMode = "local" | "fleet";

export interface UiOptions {
  root: string;
  host: string;
  port: number;
  /** Loop authority the dashboard reads and acts on; defaults to `.agents/config.json` `loop.mode` (local unless fleet). */
  mode?: UiAuthorityMode;
  /** Fleet reviewer credential held server-side; passed only to the approve child process. */
  reviewerToken?: string;
  /** Random id of this dashboard process, served at `/api/instance` so `loop down` signals
   * only the dashboard it recorded (not whatever now answers on the same port). */
  instance?: string;
}

/** Credentials that never reach the daemon or read-only child processes. */
const SCRUBBED_ENV = ["AIDLC_FLEET_REVIEWER_TOKEN", "AIDLC_UI_REVIEWER_TOKEN_FILE"];
export const scrubbedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of SCRUBBED_ENV) delete env[name];
  return { ...env, ...extra };
};

/**
 * A credential from a file (`--reviewer-token-file`: the fleet reviewer credential the approve
 * child process receives). The file must live outside the project (agents work inside it), be a
 * regular non-symlink file, and be private to the owner (mode 600/400). With `create`, a missing
 * file is created with a random token. The credential is never passed to the daemon, lead, or
 * workers; it reaches only the single approve child process.
 */
export const readCredentialFile = (root: string, path: string, { create }: { create: boolean }): string => {
  const target = resolve(path); const project = resolve(root);
  if (target === project || target.startsWith(`${project}${sep}`)) throw new Error("Credential file must live outside the project directory");
  if (!existsSync(target)) {
    if (!create) throw new Error(`Credential file not found: ${target}`);
    const token = randomBytes(32).toString("base64url");
    writeFileSync(target, `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Credential file must be a regular file, not a symlink");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Credential file must be private to its owner (chmod 600 ${target})`);
  const token = readFileSync(target, "utf8").trim();
  if (token.length < 16 || token.length > 256 || /\s/.test(token)) throw new Error("Credential file must contain one token of 16–256 non-whitespace characters");
  return token;
};

/** Best-effort browser launch for `aidlc-kit ui --open`; failures are ignored (the URL is printed anyway). */
export const openBrowser = (url: string): void => {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" }); child.on("error", () => { /* no browser launcher */ }); child.unref(); }
  catch { /* no browser launcher */ }
};

/** The configured loop authority: `fleet` only when `loop.mode` says so; everything else reads local state. */
export const resolveUiMode = (root: string): UiAuthorityMode => {
  try { return (JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8")) as { loop?: { mode?: unknown } })?.loop?.mode === "fleet" ? "fleet" : "local"; }
  catch { return "local"; }
};
export const uiMode = (options: UiOptions): UiAuthorityMode => options.mode ?? "local";

export const loopEntryPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "loop-entry.mjs");
export const stateScriptPath = (root: string): string => join(root, ".agents", "aidlc", "scripts", "state.mjs");
export const loopDataDir = (root: string): string => join(root, ".agents", "data", "loop");
export const eventsLogPath = (root: string): string => join(loopDataDir(root), "ui-events.jsonl");
/** Canonical task id (orchestrator §Turn routing); also the only names the per-task event logs use. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Directory of the per-task event logs (`<taskId>.jsonl`, rotated to `<taskId>.jsonl.1`). */
export const taskEventsDir = (root: string): string => join(loopDataDir(root), "events");
/** Per-task event log of a canonical task id (validate with TASK_ID_PATTERN first). */
export const taskEventsLogPath = (root: string, taskId: string): string => join(taskEventsDir(root), `${taskId}.jsonl`);
export const daemonLockPath = (root: string): string => join(loopDataDir(root), "daemon.lock");
export const daemonLogPath = (root: string): string => join(loopDataDir(root), "daemon.log");
export const loopArgs = (root: string, action: string, taskId = ""): string[] => [loopEntryPath(root), action, taskId, root, "", "", "", ""];
