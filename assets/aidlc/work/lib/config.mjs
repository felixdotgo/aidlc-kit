import { WorkError, object } from './contracts.mjs';
const fail = field => { throw new WorkError('WORK_CONFIG', `Invalid personalWork.${field}`); };
const only = (value, fields, label) => { if (Object.keys(value).some(k => !fields.includes(k))) fail(label); };
export const validatePersonalWork = value => {
  if (value === undefined) return { enabled: false };
  const v = object(value, 'personalWork');
  if (v.enabled === false) return { enabled: false };
  if (v.enabled !== true || v.provider !== 'local') fail('provider: enabled personal work supports local only');
  only(v, ['enabled', 'provider', 'capture', 'limits'], 'fields: local work needs no credentials, target IDs or storage path');
  const capture = object(v.capture ?? {}, 'capture');
  only(capture, ['preserveRawSource', 'autoReady'], 'capture');
  if (Object.values(capture).some(x => typeof x !== 'boolean')) fail('capture');
  const limits = object(v.limits ?? {}, 'limits');
  const defaults = { doing: 2, resumeContextChars: 12000, searchItems: 500, contextRecords: 200, intakeMessages: 50 };
  only(limits, Object.keys(defaults), 'limits');
  const resolvedLimits = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const n = limits[key] ?? fallback;
    if (!Number.isSafeInteger(n) || n < (key === 'resumeContextChars' ? 512 : 1) || n > (key === 'resumeContextChars' ? 128000 : 10000)) fail(`limits.${key}`);
    return [key, n];
  }));
  return { enabled: true, provider: 'local', capture: { preserveRawSource: true, autoReady: true, ...capture }, limits: resolvedLimits };
};
