import { lstatSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { isLoopProvider } from './loop-drivers.mjs';

/** Container workers receive credentials as environment keys only. OpenCode can
 * authenticate from environment variables too, so the worker path redirects its
 * XDG data/config roots into the worker's ephemeral HOME instead of failing.
 * The isolated LEAD container still rejects OpenCode (it needs a file-based
 * session store that host-brokered proposals do not use); that check lives in
 * the lead sandbox, not here. */
export const OPENCODE_CONTAINER_ERROR = 'OpenCode workers require file-based credentials and are not available in isolated containers yet';

const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** OpenCode's data/config roots, redirected into the worker's tmpfs HOME so the
 * container never reads the host ~/.local/share/opencode or ~/.config/opencode. */
const OPENCODE_XDG_ENV = [
  'XDG_DATA_HOME=/home/worker/.local/share',
  'XDG_CONFIG_HOME=/home/worker/.config',
  'XDG_CACHE_HOME=/home/worker/.cache',
  'XDG_STATE_HOME=/home/worker/.local/state',
  'OPENCODE_DB=/home/worker/.local/share/opencode/opencode.db'
];

/** Environment credential keys a containerized worker of `agent` receives.
 * OpenCode authenticates from the environment like codex/claude; its key
 * follows the configured model's provider (opencode-go → OPENCODE_API_KEY). */
export function workerCredentialKeys(agent, env = process.env) {
  if (agent === 'codex') return ['OPENAI_API_KEY'];
  if (agent === 'claude') return ['ANTHROPIC_API_KEY'];
  const model = env?.AIDLC_OPENCODE_MODEL ?? '';
  if (model.startsWith('openai/')) return ['OPENAI_API_KEY'];
  if (model.startsWith('anthropic/')) return ['ANTHROPIC_API_KEY'];
  return ['OPENCODE_API_KEY'];
}

/** Build a Docker invocation. This function never accepts a shell command or credentials in arguments. */
export function workerDockerInvocation({ workspace, image, command, args, credentialEnv, hostEnv, uid, gid, containerName, sessionHome, labels }) {
  const root = realpathSync(workspace);
  if (/[\x00-\x1f,]/.test(root)) throw new Error('Invalid Docker workspace path');
  if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw new Error('Explicit Docker image is required');
  if (!isLoopProvider(command) || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid worker provider command');
  if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1) throw new Error('Non-root worker uid and gid are required');
  if (!hostEnv || typeof hostEnv !== 'object' || !Array.isArray(credentialEnv) || !credentialEnv.length || credentialEnv.some((key) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof hostEnv[key] !== 'string' || !hostEnv[key])) throw new Error('Explicit worker provider credentials are required');
  const allowed = command === 'codex' ? ['OPENAI_API_KEY'] : command === 'claude' ? ['ANTHROPIC_API_KEY'] : ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'];
  if (credentialEnv.some((key) => !allowed.includes(key)) || new Set(credentialEnv).size !== credentialEnv.length) throw new Error('Unsupported worker credential environment');
  if (containerName !== undefined && (typeof containerName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName))) throw new Error('Invalid container name');
  // Optional `--label key=value` pairs (aidlc.task/item/worker/assignment) so the
  // dashboard can `docker ps --filter label=`; keys and values are plain identifiers.
  const labelArgs = [];
  if (labels !== undefined) {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Invalid container labels');
    for (const [key, value] of Object.entries(labels)) {
      if (!LABEL_PATTERN.test(key) || typeof value !== 'string' || !LABEL_PATTERN.test(value)) throw new Error(`Invalid container label: ${key}`);
      labelArgs.push('--label', `${key}=${value}`);
    }
  }
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
  const opencodeEnv = command === 'opencode' ? [...OPENCODE_XDG_ENV, 'OPENCODE_CONFIG_CONTENT={}'].flatMap((entry) => ['--env', entry]) : [];
  return { command: 'docker', args: ['run', '--rm', '--interactive', ...(containerName ? ['--name', containerName] : []), ...labelArgs, '--read-only', '--user', `${uid}:${gid}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', ...(homeMount ? ['--mount', homeMount] : ['--tmpfs', `/home/worker:rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid}`]), '--env', 'HOME=/home/worker', '--workdir', '/workspace', '--mount', `type=bind,src=${root},dst=/workspace`, ...credentialEnv.flatMap((key) => ['--env', key]), ...opencodeEnv, '--entrypoint', command, image, ...args], env };
}
