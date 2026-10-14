export const STATUSES = Object.freeze(['INBOX', 'READY', 'DOING', 'WAITING', 'DONE']);
export const CLASSIFICATIONS = Object.freeze(['ACTIONABLE', 'CONTEXT', 'DECISION', 'QUESTION', 'REFERENCE', 'NOISE']);
export const OUTCOMES = Object.freeze(['CREATE', 'UPDATE', 'APPEND_CONTEXT', 'IGNORE', 'AMBIGUOUS']);
export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const validUuid = value => typeof value === 'string' && new RegExp(`^${UUID_PATTERN}$`).test(value);
export class WorkError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkError'; this.code = code; }
}
export const invalid = (label) => { throw new WorkError('INVALID_INPUT', `Invalid ${label}`); };
export const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value;
};
export const text = (value, label, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(label);
  return value;
};
export const nullableText = (value, label) => value == null ? null : text(value, label);
export const stringArray = (value, label) => {
  if (!Array.isArray(value) || value.length > 500 || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 12000)) invalid(label);
  return [...new Set(value)];
};
export const timestamp = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) invalid(label);
  return value;
};
export const validateSource = value => {
  const v = object(value, 'source envelope');
  const source = text(v.source, 'source namespace', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(source)) invalid('source namespace');
  return { source, externalId: nullableText(v.externalId, 'externalId'), threadId: nullableText(v.threadId, 'threadId'), author: nullableText(v.author, 'author'), timestamp: v.timestamp == null ? null : timestamp(v.timestamp, 'source timestamp'), url: nullableText(v.url, 'source URL'), body: text(v.body, 'source body') };
};
export const validateRef = value => {
  const v = object(value, 'work reference');
  const provider = text(v.provider, 'reference provider', 64);
  const id = text(v.id, 'reference id', 256);
  const url = text(v.url, 'reference URL', 2048);
  if (provider === 'local') {
    const match = new RegExp(`^aidlc-work://(${UUID_PATTERN})/(${UUID_PATTERN})$`).exec(url);
    if (!validUuid(id) || !match || match[2] !== id) invalid('local work reference');
  } else if (!/^https:\/\//.test(url)) invalid('reference URL');
  return { provider, id, url };
};
export const validateItem = value => {
  const v = object(value, 'work item');
  if (v.schemaVersion !== 1 || !STATUSES.includes(v.status)) invalid('work schema/status');
  if (!Array.isArray(v.sources) || v.sources.length > 500) invalid('sources');
  const d = object(v.dedupe, 'dedupe');
  return { schemaVersion: 1, title: text(v.title, 'title', 256), summary: text(v.summary, 'summary'), expectedOutcome: text(v.expectedOutcome, 'expectedOutcome'), nextAction: text(v.nextAction, 'nextAction'), status: v.status,
    priority: nullableText(v.priority, 'priority'), due: v.due == null ? null : timestamp(v.due, 'due'), project: nullableText(v.project, 'project'), aidlcTaskId: nullableText(v.aidlcTaskId, 'aidlcTaskId'),
    sources: v.sources.map(validateSource), dedupe: Object.fromEntries(['externalIds', 'threadIds', 'references', 'keywords'].map(k => [k, stringArray(d[k], `dedupe.${k}`)])) };
};
export const validateCheckpoint = value => {
  const v = object(value, 'checkpoint');
  if (v.schemaVersion !== 1) invalid('checkpoint schema');
  return { schemaVersion: 1, goal: text(v.goal, 'checkpoint goal'), state: nullableText(v.state, 'checkpoint state'), hypothesis: nullableText(v.hypothesis, 'hypothesis'), nextAction: text(v.nextAction, 'checkpoint nextAction'), capturedAt: timestamp(v.capturedAt, 'checkpoint capturedAt'),
    ...Object.fromEntries(['completed', 'observations', 'blockers', 'files', 'links'].map(k => [k, stringArray(v[k], `checkpoint.${k}`)])) };
};
