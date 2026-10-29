import { lstatSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { isLoopProvider } from './loop-drivers.mjs';

/** Container workers receive credentials as environment keys only. OpenCode
 * authenticates from a file-based data store, so it fails closed here. */
export const OPENCODE_CONTAINER_ERROR = 'OpenCode workers require file-based credentials and are not available in isolated containers yet';

/** Build a Docker invocation. This function never accepts a shell command or credentials in arguments. */
export function workerDockerInvocation({ workspace, image, command, args, credentialEnv, hostEnv, uid, gid, containerName, sessionHome }) {
  const root = realpathSync(workspace);
  if (/[\x00-\x1f,]/.test(root)) throw new Error('Invalid Docker workspace path');
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw new Error('Explicit Docker image is required');
  if (command === 'opencode') throw new Error(OPENCODE_CONTAINER_ERROR);
  if (!isLoopProvider(command) || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid worker provider command');
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new Error('Non-root worker uid and gid are required');
  if (!hostEnv || typeof hostEnv !== 'object' || !Array.isArray(credentialEnv) || !credentialEnv.length || credentialEnv.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof hostEnv[key] !== 'string' || !hostEnv[key])) throw new Error('Explicit worker provider credentials are required');
  const allowed = command === 'codex' ? ['OPENAI_API_KEY'] : ['ANTHROPIC_API_KEY'];
  if (credentialEnv.some((key) => !allowed.includes(key)) || new Set(credentialEnv).size !== credentialEnv.length) throw new Error('Unsupported worker credential environment');
  if (containerName !== undefined && (typeof containerName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName))) throw new Error('Invalid container name');
  let homeMount;
  if (sessionHome !== undefined) {
    const info = lstatSync(sessionHome);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) throw new Error('Private worker session HOME is required');
    const home = realpathSync(sessionHome);
    if (/[\x00-\x1f,]/.test(home) || home === root || home.startsWith(`${root}${sep}`) || root.startsWith(`${home}${sep}`)) throw new Error('Worker session HOME must be separate from workspace');
    homeMount = `type=bind,src=${home},dst=/home/worker`;
  }
  const env = { PATH: hostEnv.PATH ?? '/usr/bin:/bin' };
  for (const key of credentialEnv) env[key] = hostEnv[key];
  return { command: 'docker', args: ['run', '--rm', '--interactive', ...(containerName ? ['--name', containerName] : []), '--read-only', '--user', `${uid}:${gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', ...(homeMount ? ['--mount', homeMount] : ['--tmpfs', `/home/worker:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid}`]), '--env', 'HOME=/home/worker', '--workdir', '/workspace', '--mount', `type=bind,src=${root},dst=/workspace`, ...credentialEnv.flatMap((key) => ['--env', key]), '--entrypoint', command, image, ...args], env };
}
