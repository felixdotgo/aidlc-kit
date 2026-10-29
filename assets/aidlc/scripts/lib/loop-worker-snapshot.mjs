import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';

const excluded = (path) => path.split('/').includes('.git') || path === '.agents/data' || path.startsWith('.agents/data/');
const scopePath = (path) => typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\\') && !path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git' || part === '.agents');
const within = (path, scopes) => scopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
const digest = (path) => createHash('sha256').update(readFile(path)).digest('hex');
import { readFileSync as readFile } from 'node:fs';

// Reject links and special files rather than allowing a worker to make a host
// copy operation follow an external path or alias a file outside its scope.
function inventory(root, skipExcluded) {
  const files = new Map();
  function visit(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (excluded(path)) {
        if (skipExcluded) continue;
        throw new Error(`Worker created a protected path: ${path}`);
      }
      const full = join(dir, name), info = lstatSync(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) throw new Error(`Unsafe worker file: ${path}`);
      if (info.isDirectory()) visit(full, path);
      else files.set(path, { digest: digest(full), executable: Boolean(info.mode & 0o111) });
    }
  }
  visit(root);
  return files;
}

/** Create a source-only snapshot. The caller supplies a new empty directory. */
export function createWorkerSnapshot(source, destination, trackedPaths) {
  const src = realpathSync(source), dst = realpathSync(destination);
  if (src === dst || dst.startsWith(`${src}${sep}`) || src.startsWith(`${dst}${sep}`)) throw new Error('Worker snapshot must be separate from source');
  if (readdirSync(dst).length) throw new Error('Worker snapshot destination must be empty');
  if (!Array.isArray(trackedPaths) || !trackedPaths.length || trackedPaths.some((path) => typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some((part) => !part || part === '.' || part === '..') || excluded(path))) throw new Error('An explicit safe tracked-file manifest is required');
  const sourceFiles = inventory(src, true), baseline = new Map();
  for (const path of new Set(trackedPaths)) {
    const entry = sourceFiles.get(path);
    if (!entry) throw new Error(`Tracked worker source is missing or unsafe: ${path}`);
    baseline.set(path, entry);
  }
  for (const [path] of baseline) {
    const target = join(dst, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(src, path), target);
  }
  return baseline;
}

/** Validate the complete stopped-worker snapshot before host integration. */
export function inspectWorkerSnapshot(destination, baseline, scopes) {
  if (!(baseline instanceof Map) || !Array.isArray(scopes) || !scopes.length || !scopes.every(scopePath)) throw new Error('Invalid snapshot baseline or scopes');
  const root = realpathSync(destination), current = inventory(root, false);
  const changed = [];
  for (const path of new Set([...baseline.keys(), ...current.keys()])) {
    const before = baseline.get(path), after = current.get(path);
    if (!before || !after || before.digest !== after.digest || before.executable !== after.executable) {
      if (!scopePath(path) || !within(path, scopes)) throw new Error(`Worker changed a path outside its scope: ${path}`);
      changed.push(path);
    }
  }
  return changed.sort();
}
