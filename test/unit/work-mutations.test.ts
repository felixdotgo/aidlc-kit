import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {localFixture,workItem,source} from './work-fixture.js';
const {FileProvider}=await import(resolve('assets/aidlc/work/lib/file-provider.mjs'));
test('real local create/update/context replay persists across instances with no duplicate work or history',async()=>{
 const f=await localFixture();const p=f.provider;
 try{
  const value={...workItem(),sources:[source()]};const created=await p.create_work_item(value,{idempotencyKey:'create'});
  await p.create_work_item(value,{idempotencyKey:'create'});
  const restarted=new FileProvider(f.root,f.config);
  assert.equal((await restarted.search_work_items()).items.length,1);
  const event={kind:'SOURCE',data:{source:source(),classification:'ACTIONABLE'}};
  await restarted.append_context(created.ref,event,{idempotencyKey:'source'});
  await restarted.append_context(created.ref,event,{idempotencyKey:'source'});
  assert.equal((await restarted.get_work_item(created.ref)).context.records.length,1);
  await assert.rejects(restarted.append_context(created.ref,{kind:'SOURCE',data:{source:source('other'),classification:'CONTEXT'}},{idempotencyKey:'source'}),{code:'WORK_IDEMPOTENCY'});
  await restarted.update_work_item(created.ref,{nextAction:'Inspect customer logs'},{idempotencyKey:'update'});
  assert.equal((await p.get_work_item(created.ref)).item.nextAction,'Inspect customer logs');
  await assert.rejects(p.update_work_item(created.ref,{nextAction:'Other action'},{idempotencyKey:'update'}),{code:'WORK_IDEMPOTENCY'});
  const journal=readFileSync(join(f.root,'.agents/data/work',created.ref.id,'events.jsonl'),'utf8');
  assert.equal(journal.trim().split('\n').length,3);
  const other=await localFixture();try{await assert.rejects(other.provider.get_work_item(created.ref),{code:'WORK_TARGET'});}finally{other.cleanup();}
 }finally{f.cleanup();}
});
test('local operations work when all network access is forbidden and persisted secrets are redacted',async()=>{
 const f=await localFixture();const original=globalThis.fetch;
 globalThis.fetch=async()=>{throw Error('Network must not be used');};
 try{
  const created=await f.provider.create_work_item({...workItem(),summary:'password=private-password'},{idempotencyKey:'create'});
  assert.equal(created.item.summary.includes('private-password'),false);
  const raw=readFileSync(join(f.root,'.agents/data/work',created.ref.id,'events.jsonl'),'utf8');assert.equal(raw.includes('private-password'),false);
  assert.equal((await f.provider.get_work_item(created.ref)).ref.provider,'local');
  assert.equal((await f.provider.preflight()).ready,true);
 }finally{globalThis.fetch=original;f.cleanup();}
});
