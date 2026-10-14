import { WorkError } from './contracts.mjs';
import { validatePersonalWork } from './config.mjs';
export const CAPABILITIES = Object.freeze(['search_work_items','get_work_item','create_work_item','update_work_item','append_context','move_work_item']);
export const requireCapabilities = adapter => {
  if (CAPABILITIES.some(k => typeof adapter[k] !== 'function')) throw new WorkError('WORK_CAPABILITY', 'Provider lacks required personal-work capabilities');
  return adapter;
};
export const createProvider = async (configuration, options = {}) => {
  const config = validatePersonalWork(configuration);
  if (!config.enabled) throw new WorkError('WORK_DISABLED', 'Personal work is disabled');
  const { FileProvider } = await import('./file-provider.mjs');
  return requireCapabilities(new FileProvider(options.root, config, options));
};
export const requireComplete = result => {
  if (result.complete !== true) throw new WorkError('WORK_INCOMPLETE', 'Configured read limit reached; narrow the request or deliberately increase the limit before retrying');
  return result;
};
const queues = new Map();
/** Serialize operations for the same target within this process (single-writer MVP). */
export const withTargetLock = async (target, operation) => {
  const previous = queues.get(target) ?? Promise.resolve();
  let release;
  const tail = new Promise(resolve => { release = resolve; });
  queues.set(target, tail);
  await previous;
  try { return await operation(); } finally { release(); if (queues.get(target) === tail) queues.delete(target); }
};
