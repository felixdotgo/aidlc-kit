import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const c = await import(resolve('assets/aidlc/work/lib/contracts.mjs'));
export const item = () => ({ schemaVersion: 1, title: 'Investigate retry', summary: 'Timeout retry fails', expectedOutcome: 'Find cause', nextAction: 'Reproduce timeout', status: 'INBOX', priority: null, due: null, project: null, aidlcTaskId: null, sources: [], dedupe: { externalIds: [], threadIds: [], references: [], keywords: ['retry'] } });
test('normalized contracts reject malformed messages, items and checkpoints', () => {
  assert.equal(c.validateItem(item()).status, 'INBOX');
  assert.throws(() => c.validateItem({ ...item(), status: 'build' }));
  assert.throws(() => c.validateSource({ source: 'manual', body: '' }));
  assert.throws(() => c.validateSource({ source: 'Manual', body: 'hello' }));
  assert.throws(() => c.validateCheckpoint({ schemaVersion: 1, goal: 'retry' }));
  const id = '11111111-1111-4111-8111-111111111111';
  const ref = {provider:'local',id,url:`aidlc-work://22222222-2222-4222-8222-222222222222/${id}`};
  assert.deepEqual(c.validateRef(ref),ref);
  assert.throws(()=>c.validateRef({...ref,url:ref.url+'/../other'}));
  assert.throws(()=>c.validateRef({...ref,id:'../escape'}));
});
test('schema enumerations agree with runtime contracts', () => {
  const schema = JSON.parse(readFileSync('assets/aidlc/schemas/work-item.schema.json', 'utf8'));
  assert.deepEqual(schema.properties.status.enum, c.STATUSES);
  assert.deepEqual(schema.required.sort(), Object.keys(item()).sort());
});
