/**
 * One-command local loop: `loop up | down | stop | env | status` (no task id).
 *
 * `up` checks the configuration and environment (`loop-entry.mjs env`), starts the
 * daemon detached, then serves the dashboard in the foreground. Ctrl-C closes only
 * the dashboard; the daemon keeps running until `loop down` / `loop stop`. The
 * shipped `.agents/aidlc/scripts/loop.sh|loop.cmd` wrappers forward to these commands.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../workflow.js";
import { daemonHealth, daemonStatus, ensureDaemon, pidAlive, stopDaemon } from "../ui/daemon.js";
import { daemonLogPath, loopDataDir, loopEntryPath, openBrowser, readUiTokenFile, scrubbedEnv } from "../ui/options.js";
import { startUiServer } from "../ui/server.js";

const SWITCHES = new Set(["--open", "--no-ui", "--now", "--json"]);
const VALUES = new Set(["--root", "--loop-env", "--port", "--host", "--token-file", "--reviewer-token-file"]);

export interface LauncherArgs { root: string; values: Map<string, string>; switches: Set<string> }

/** Parses `--flag value` / `--switch` options against the per-action allowlist. */
export const parseLauncherArgs = (args: string[], allowed: string[]): LauncherArgs => {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index] ?? "";
    if (!allowed.includes(key)) throw new Error(`Unknown loop option: ${key}`);
    if (SWITCHES.has(key)) { switches.add(key); continue; }
    const entry = args[index + 1];
    if (!VALUES.has(key) || entry === undefined || entry.startsWith("--") || values.has(key)) throw new Error(`${key} requires a value`);
    values.set(key, entry);
    index += 1;
  }
  return { root: resolve(values.get("--root") ?? "."), values, switches };
};

/** `AIDLC_ENV_FILE` for children when `--loop-env` is given (resolved against the caller's cwd). */
const envOverlay = (parsed: LauncherArgs): Record<string, string> => {
  const file = parsed.values.get("--loop-env");
  return file ? { AIDLC_ENV_FILE: resolve(file) } : {};
};

const readConfig = (root: string): { loop?: { mode?: string } } | undefined => {
  try { return JSON.parse(readFileSync(join(root, ".agents", "config.json"), "utf8")) as { loop?: { mode?: string } }; }
  catch { return undefined; }
};

/** Fails with actionable guidance unless the project is installed with local loop mode. */
const requireLocalLoop = (root: string): void => {
  if (!existsSync(loopEntryPath(root))) throw new Error(`AI-DLC is not installed in ${root}; run: npx @felixdotgo/aidlc-kit init --loop-mode local`);
  const mode = readConfig(root)?.loop?.mode ?? "off";
  if (mode === "fleet") throw new Error("loop up/down manage the local daemon; this project uses fleet mode (see docs/loop-runbook.md, Part B)");
  if (mode !== "local") throw new Error([
    "Loop mode is off. Enable it in .agents/config.json:",
    '  "loop": { "mode": "local", "agents": { "lead": "opencode", "workers": { "worker-a": "opencode" } } }',
    "(providers: codex, claude, or opencode), or run: npx @felixdotgo/aidlc-kit init --loop-mode local",
  ].join("\n"));
};

/** Runs `loop-entry.mjs env` for `root`; returns its exit status (output inherited or captured). */
const envReport = (root: string, overlay: Record<string, string>, options: { json?: boolean; capture?: boolean } = {}): { status: number; stdout: string } => {
  const result = spawnSync(process.execPath, [loopEntryPath(root), "env", root, ...(options.json ? ["--json"] : [])], {
    cwd: root, encoding: "utf8", env: scrubbedEnv(overlay), stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
};

/* ---- Installing CLI record (`.agents/data/loop/cli.json`) ----
 * `init`/`upgrade` record the CLI that wrote `.agents/`, so `loop.sh`/`loop.cmd` run that
 * exact build even when it came from the npx cache or a local `.tgz` (npx caches those by
 * spec, so `npx --no-install @felixdotgo/aidlc-kit` cannot find them). Machine-local data,
 * next to daemon.lock and daemon.log; never part of the managed manifest. */
export const installerCliPath = (root: string): string => join(loopDataDir(root), "cli.json");
export const recordInstallerCli = (root: string): void => {
  try {
    mkdirSync(loopDataDir(root), { recursive: true });
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    writeFileSync(installerCliPath(root), `${JSON.stringify({ cli, version: packageVersion(), recordedAt: new Date().toISOString() }, null, 2)}\n`);
  } catch (error) {
    console.warn(`warning: could not record the aidlc-kit CLI for the loop launcher (${error instanceof Error ? error.message : String(error)}); install the package in the project to use loop.sh`);
  }
};

/* ---- Dashboard process record (`.agents/data/loop/ui.json`) ---- */

export const uiStatePath = (root: string): string => join(loopDataDir(root), "ui.json");
interface UiRecord { pid: number; url: string; startedAt: string; instance?: string }
/** The recorded dashboard, if any. `running` only means the pid exists; use
 * `dashboardReachable` before trusting or signalling it (the pid may have been reused). */
export const readUiRecord = (root: string): (UiRecord & { running: boolean }) | undefined => {
  try {
    const record = JSON.parse(readFileSync(uiStatePath(root), "utf8")) as Partial<UiRecord>;
    if (typeof record.pid !== "number" || typeof record.url !== "string") return undefined;
    return { pid: record.pid, url: record.url, startedAt: String(record.startedAt ?? ""), ...(typeof record.instance === "string" ? { instance: record.instance } : {}), running: pidAlive(record.pid) };
  } catch { return undefined; }
};

/** True when the recorded dashboard itself still answers: the URL serves the same random
 * instance id the record holds (another project's dashboard on that port does not match). */
export const dashboardReachable = async (record: { url: string; instance?: string }): Promise<boolean> => {
  if (!record.instance) return false;
  try {
    const response = await fetch(`${record.url}/api/instance`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json() as { instance?: unknown };
    return response.ok && body.instance === record.instance;
  } catch { return false; }
};

/** A URL this machine can reach for a wildcard bind (0.0.0.0 / ::), else the bound host. */
const recordHost = (host: string): string => host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;

const validPort = (raw: string | undefined): number => {
  const port = Number(raw ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  return port;
};

export interface ServeOptions { root: string; host: string; port: number; open: boolean; tokenFile?: string; reviewerTokenFile?: string; record?: boolean }

/** Serves the dashboard until SIGINT/SIGTERM. `record` writes ui.json so `loop down`/`up` can find it. */
export const serveDashboard = async (options: ServeOptions): Promise<void> => {
  const { root, host } = options;
  const port = validPort(String(options.port));
  const token = options.tokenFile ? readUiTokenFile(root, options.tokenFile, { create: true }) : undefined;
  const reviewerToken = options.reviewerTokenFile ? readUiTokenFile(root, options.reviewerTokenFile, { create: false }) : undefined;
  const instance = randomUUID();
  const { server, port: boundPort, token: sessionToken } = await startUiServer({ root, host, port, instance, ...(token ? { token } : {}), ...(reviewerToken ? { reviewerToken } : {}) });
  const base = `http://${host.includes(":") ? `[${host}]` : host}:${boundPort}`;
  const loginUrl = `${base}/#token=${encodeURIComponent(sessionToken)}`;
  console.log(`Loop (AI-DLC UI) listening on ${base} (Ctrl-C to stop)`);
  console.log(`Open (signs this browser in for loop actions and gate approval): ${loginUrl}`);
  if (options.record) {
    mkdirSync(loopDataDir(root), { recursive: true });
    // The login token never goes to disk inside the project; only the base URL does.
    const local = recordHost(host);
    const url = `http://${local.includes(":") ? `[${local}]` : local}:${boundPort}`;
    writeFileSync(uiStatePath(root), `${JSON.stringify({ pid: process.pid, url, instance, startedAt: new Date().toISOString() })}\n`);
  }
  if (options.open) openBrowser(loginUrl);
  await new Promise<void>((resolveClose) => {
    const close = (): void => { server.close(() => resolveClose()); server.closeAllConnections?.(); };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  if (options.record && readUiRecord(root)?.pid === process.pid) rmSync(uiStatePath(root), { force: true });
};

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const logTail = (root: string, lines = 15): string => {
  try { return readFileSync(daemonLogPath(root), "utf8").trimEnd().split("\n").slice(-lines).join("\n"); }
  catch { return ""; }
};

/** Env file of this start: `--loop-env`, `AIDLC_ENV_FILE`, or the default. */
const envFilePath = (root: string, overlay: Record<string, string>): string =>
  resolve(root, overlay.AIDLC_ENV_FILE ?? process.env.AIDLC_ENV_FILE ?? join(".agents", "loop.env"));

/** Starts the daemon unless it runs; confirms it survived start-up. Returns false on failure. */
const startDaemon = async (root: string, overlay: Record<string, string>): Promise<boolean> => {
  const current = daemonStatus(root);
  if (current.running) {
    console.log(`Loop daemon already running (pid ${current.pid}${current.startedAt ? `, started ${current.startedAt}` : ""})`);
    try {
      if (current.startedAt && statSync(envFilePath(root, overlay)).mtimeMs > Date.parse(current.startedAt)) {
        console.log("  note: the env file changed after the daemon started; restart it to apply: loop down, then loop up");
      }
    } catch { /* no env file */ }
    return true;
  }
  const started = ensureDaemon(root, overlay);
  // The daemon writes its lock right after the environment check; an early exit means start-up failed.
  for (let waited = 0; waited < 5000; waited += 250) {
    await sleep(250);
    if (daemonStatus(root).running) { console.log(`Started the loop daemon (pid ${daemonStatus(root).pid}); log: ${daemonLogPath(root)}`); return true; }
    if (started.pid !== null && !pidAlive(started.pid)) break;
  }
  if (daemonStatus(root).running) return true;
  if (started.pid !== null && pidAlive(started.pid)) { console.log(`Loop daemon is starting (pid ${started.pid}); log: ${daemonLogPath(root)}`); return true; }
  console.error(`The loop daemon exited during start-up. Last lines of ${daemonLogPath(root)}:`);
  console.error(logTail(root) || "  (empty)");
  return false;
};

export const loopUp = async (args: string[]): Promise<void> => {
  const parsed = parseLauncherArgs(args, ["--root", "--loop-env", "--port", "--host", "--open", "--no-ui", "--token-file", "--reviewer-token-file"]);
  const { root } = parsed;
  requireLocalLoop(root);
  const port = validPort(parsed.values.get("--port"));
  const overlay = envOverlay(parsed);
  if (envReport(root, overlay).status !== 0) { console.error("\nFix the errors above, then run loop up again."); process.exitCode = 1; return; }
  console.log("");
  if (!await startDaemon(root, overlay)) { process.exitCode = 1; return; }
  if (parsed.switches.has("--no-ui")) { console.log("Dashboard not started (--no-ui). Start it with: aidlc-kit ui"); return; }
  const ui = readUiRecord(root);
  if (ui?.running && ui.pid !== process.pid && await dashboardReachable(ui)) {
    console.log(`Dashboard already running at ${ui.url} (pid ${ui.pid}); use the login link that process printed, or stop it with loop down.`);
    return;
  }
  // A daemon the dashboard starts later (New task after loop stop) loads the same env file.
  if (overlay.AIDLC_ENV_FILE) process.env.AIDLC_ENV_FILE = overlay.AIDLC_ENV_FILE;
  await serveDashboard({
    root, host: parsed.values.get("--host") ?? "127.0.0.1", port, open: parsed.switches.has("--open"), record: true,
    ...(parsed.values.has("--token-file") ? { tokenFile: parsed.values.get("--token-file") } : {}),
    ...(parsed.values.has("--reviewer-token-file") ? { reviewerTokenFile: parsed.values.get("--reviewer-token-file") } : {}),
  });
  console.log("Dashboard stopped. The loop daemon keeps running; stop it with: loop down");
};

const reportStop = (result: Awaited<ReturnType<typeof stopDaemon>>, now: boolean): void => {
  if (!result.wasRunning) { console.log("Loop daemon is not running"); return; }
  if (result.stopped) { console.log(`Stopped the loop daemon (pid ${result.pid})`); return; }
  console.log(now
    ? `Loop daemon (pid ${result.pid}) is still shutting down; check again with: loop status`
    : `Loop daemon (pid ${result.pid}) will stop after its current agent turn. To cancel that turn now: loop stop --now`);
};

export const loopStop = async (args: string[]): Promise<void> => {
  const parsed = parseLauncherArgs(args, ["--root", "--now"]);
  const now = parsed.switches.has("--now");
  reportStop(await stopDaemon(parsed.root, { now }), now);
};

export const loopDown = async (args: string[]): Promise<void> => {
  const parsed = parseLauncherArgs(args, ["--root", "--now"]);
  const { root } = parsed;
  const ui = readUiRecord(root);
  // Signal only a dashboard that still answers at its recorded URL: after a crash or reboot
  // the recorded pid may belong to an unrelated process.
  if (ui?.running && ui.pid !== process.pid && await dashboardReachable(ui)) {
    try { process.kill(ui.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let waited = 0; waited < 5000 && pidAlive(ui.pid); waited += 200) await sleep(200);
    console.log(pidAlive(ui.pid) ? `Dashboard (pid ${ui.pid}) did not stop yet` : `Stopped the dashboard (pid ${ui.pid})`);
    if (!pidAlive(ui.pid)) rmSync(uiStatePath(root), { force: true });
  } else if (ui?.running && ui.pid !== process.pid) {
    // Not provably ours (busy, or the pid was reused): never signal it; keep the record.
    console.log(`Dashboard record (pid ${ui.pid}, ${ui.url}) did not answer as this project's dashboard; not stopping it. Close it with Ctrl-C, or delete ${uiStatePath(root)} if it is gone.`);
  } else if (ui) rmSync(uiStatePath(root), { force: true });
  const now = parsed.switches.has("--now");
  reportStop(await stopDaemon(root, { now }), now);
};

export const loopEnv = (args: string[]): void => {
  const parsed = parseLauncherArgs(args, ["--root", "--loop-env", "--json"]);
  if (!existsSync(loopEntryPath(parsed.root))) throw new Error(`AI-DLC is not installed in ${parsed.root}`);
  const { status } = envReport(parsed.root, envOverlay(parsed), { json: parsed.switches.has("--json") });
  if (status !== 0) process.exitCode = status;
};

/** `loop status` without a task id: daemon, dashboard, and environment at a glance. */
export const loopOverview = async (args: string[]): Promise<void> => {
  const parsed = parseLauncherArgs(args, ["--root", "--loop-env", "--json"]);
  const { root } = parsed;
  if (!existsSync(loopEntryPath(root))) throw new Error(`AI-DLC is not installed in ${root}`);
  const daemon = daemonStatus(root);
  const errors = daemon.running ? daemonHealth(root) : [];
  const record = readUiRecord(root);
  const ui = record ? { ...record, running: record.running && await dashboardReachable(record) } : undefined;
  if (parsed.switches.has("--json")) {
    const env = envReport(root, envOverlay(parsed), { json: true, capture: true });
    let parsedEnv: unknown = null;
    try { parsedEnv = JSON.parse(env.stdout); } catch { parsedEnv = null; }
    console.log(JSON.stringify({ daemon: { ...daemon, errors }, ui: ui ?? null, env: parsedEnv }, null, 2));
    return;
  }
  console.log(daemon.running ? `Daemon    : running · pid ${daemon.pid}${daemon.startedAt ? ` · started ${daemon.startedAt}` : ""}` : "Daemon    : stopped (start it with: loop up)");
  for (const error of errors) console.log(`  error   : ${error.taskId ? `${error.taskId}: ` : "poll: "}${error.message}`);
  console.log(ui?.running ? `Dashboard : ${ui.url} · pid ${ui.pid}` : "Dashboard : not running (loop up starts it)");
  console.log(`Log       : ${daemonLogPath(root)}`);
  console.log("");
  envReport(root, envOverlay(parsed));
};
