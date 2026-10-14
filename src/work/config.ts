import { fileURLToPath } from 'node:url';
import type { PersonalWorkConfig } from './model.js';
const runtime = await import(fileURLToPath(new URL('../../assets/.agents/aidlc/work/lib/config.mjs', import.meta.url)));
export const validatePersonalWork: (value: unknown) => PersonalWorkConfig = runtime.validatePersonalWork;
