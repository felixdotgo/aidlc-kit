import { fileURLToPath } from 'node:url';
export type * from './model.js';
export { validatePersonalWork } from './config.js';
const runtime = await import(fileURLToPath(new URL('../../assets/.agents/aidlc/work/lib/provider.mjs', import.meta.url)));
export const createProvider = runtime.createProvider;
export const requireCapabilities = runtime.requireCapabilities;
