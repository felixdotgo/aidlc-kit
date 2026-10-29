import { realpathSync, statSync } from "node:fs";
import { workerDockerInvocation } from "./loop-worker-docker.mjs";

/** Invocation only: callers must supply a sanitized, host-owned source snapshot,
 * never the checkout. No host output directory, state, or broker channel is mounted.
 * The bounded provider response carries the proposal back to the trusted host. */
export function leadDockerInvocation({ snapshot, image, agent, args, credentialEnv, hostEnv, uid, gid, containerName }) {
  const source = realpathSync(snapshot);
  if (!statSync(source).isDirectory()) throw new Error("Lead snapshot must be a directory");
  const invocation = workerDockerInvocation({ workspace: source, image, command: agent, args, credentialEnv, hostEnv, uid, gid, containerName });
  const mount = `type=bind,src=${source},dst=/workspace`;
  const index = invocation.args.indexOf(mount);
  if (index < 0) throw new Error("Missing lead snapshot mount");
  invocation.args[index] = `${mount},readonly`;
  return invocation;
}

/** Create and clean an isolated source-only snapshot for exactly one turn. */
export async function withLeadSnapshot({ root: inputRoot, snapshotsRoot: inputSnapshotsRoot }, use) {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
  const { resolve, sep, join } = await import("node:path");
  const { createWorkerSnapshot } = await import("./loop-worker-snapshot.mjs");
  if (typeof use !== "function" || typeof inputRoot !== "string" || typeof inputSnapshotsRoot !== "string") throw new Error("Lead snapshot requires paths and a callback");
  const root = realpathSync(inputRoot);
  const requested = resolve(inputSnapshotsRoot);
  if (requested === root || requested.startsWith(`${root}${sep}`) || root.startsWith(`${requested}${sep}`)) throw new Error("Lead snapshots root must be outside the project");
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const parent = realpathSync(requested);
  if (parent === root || parent.startsWith(`${root}${sep}`) || root.startsWith(`${parent}${sep}`)) throw new Error("Lead snapshots root resolves inside or above the project");
  const snapshot = mkdtempSync(join(parent, "aidlc-lead-"));
  try {
    const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
    const paths = output.split("\0").filter((path) => path && path !== ".agents/data" && !path.startsWith(".agents/data/"));
    createWorkerSnapshot(root, snapshot, paths);
    return await use(snapshot);
  } finally { rmSync(snapshot, { recursive: true, force: true }); }
}

/** Execute one lead proposal in a separate read-only container. No broker or
 * lifecycle capability is passed to the container. Caller applies the returned
 * proposal separately under its fence and canonical lock. */
export async function runIsolatedLeadTurn({ root, snapshotsRoot, image, agent, prompt, assertOwned, timeoutMs = 600000, signal }) {
  const { execFileSync, spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { runAgentTurn } = await import("./loop-drivers.mjs");
  const { parseLeadProposal } = await import("./loop-lead-broker.mjs");
  if (process.platform !== "linux" || !["codex", "claude"].includes(agent) || typeof prompt !== "string" || !prompt || Buffer.byteLength(prompt) > 262144 || typeof assertOwned !== "function") throw new Error("Invalid isolated lead configuration");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || (signal !== undefined && !(signal instanceof AbortSignal))) throw new Error("Invalid isolated lead timeout or signal");
  const uid = process.getuid?.(), gid = process.getgid?.();
  if (!uid || !gid) throw new Error("Isolated lead requires a non-root Linux host user");
  const credentialEnv = agent === "codex" ? ["OPENAI_API_KEY"] : ["ANTHROPIC_API_KEY"];
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const check = (...args) => execFileSync("docker", args, { env, stdio: "ignore", timeout: 30000 });
  await assertOwned();
  return withLeadSnapshot({ root, snapshotsRoot }, async (snapshot) => {
    // Validation builds an invocation before any agent or task mutation starts.
    leadDockerInvocation({ snapshot, image, agent, args: [], credentialEnv, hostEnv: process.env, uid, gid });
    try { check("info"); check("image", "inspect", image); check("run", "--rm", "--network", "none", "--read-only", "--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", agent, image, "--version"); }
    catch { throw new Error("Docker engine, lead image, or provider CLI preflight failed"); }
    const name = `aidlc-lead-${randomUUID()}`, controller = new AbortController();
    let lost;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setInterval(() => { Promise.resolve().then(assertOwned).catch((error) => { lost = error; controller.abort(); }); }, 1000);
    try {
      await assertOwned();
      const result = await runAgentTurn({ agent, root: "/workspace", prompt, timeoutMs, signal: controller.signal, spawnProcess: (command, args, options) => {
        const invocation = leadDockerInvocation({ snapshot, image, agent: command, args, credentialEnv, hostEnv: process.env, uid, gid, containerName: name });
        return spawn(invocation.command, invocation.args, { ...options, cwd: snapshot, env: invocation.env, shell: false });
      } });
      if (lost || controller.signal.aborted) throw lost ?? new Error("Lead turn aborted");
      await assertOwned();
      return parseLeadProposal(result.resultText);
    } finally {
      clearInterval(timer); signal?.removeEventListener("abort", abort);
      try { check("rm", "-f", name); }
      catch {
        try { check("info"); } catch { throw new Error("Lead container cleanup uncertain: Docker unavailable"); }
        try { check("inspect", name); throw new Error("Lead container cleanup uncertain: container remains"); }
        catch (error) { if (error.message === "Lead container cleanup uncertain: container remains") throw error; }
      }
    }
  });
}
