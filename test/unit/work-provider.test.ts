import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
const p = await import(resolve('assets/aidlc/work/lib/provider.mjs'));
test('disabled and unsupported integrations stop before loading providers; incomplete reads never establish absence', async () => {
  await assert.rejects(p.createProvider({ enabled: false }), { code: 'WORK_DISABLED' });
  await assert.rejects(p.createProvider({ enabled: true, provider: 'unsupported' }), { code: 'WORK_CONFIG' });
  assert.throws(() => p.requireCapabilities({}), { code: 'WORK_CAPABILITY' });
  assert.throws(() => p.requireComplete({ items: [], complete: false }), { code: 'WORK_INCOMPLETE' });
});
test('same-target writes serialize and failed operations release their locks', async () => {
  const order: string[] = [];
  await Promise.all([p.withTargetLock('a', async () => { order.push('first'); await Promise.resolve(); order.push('end'); }), p.withTargetLock('a', async () => { order.push('second'); })]);
  assert.deepEqual(order, ['first','end','second']);
  await assert.rejects(p.withTargetLock('a', () => { throw Error('failed'); }));
  assert.equal(await p.withTargetLock('a', () => 3), 3);
});
