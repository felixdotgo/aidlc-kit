import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {localFixture,workItem} from './work-fixture.js';
const {FileProvider}=await import(resolve('assets/aidlc/work/lib/file-provider.mjs'));
test('local status writes require conscious intent and waiting reason; linked automatic completion uses fresh lifecycle state',async()=>{
 const f=await localFixture();
 try{
  const created=await f.provider.create_work_item({...workItem(),aidlcTaskId:'fix-retry'},{idempotencyKey:'create'});
  const path=join(f.root,'.agents/data/work',created.ref.id,'events.jsonl');
  const before=readFileSync(path,'utf8');
  await assert.rejects(f.provider.move_work_item(created.ref,'DOING',{idempotencyKey:'doing'}),{code:'WORK_INTENT'});
  await assert.rejects(f.provider.move_work_item(created.ref,'WAITING',{idempotencyKey:'wait'}),{code:'INVALID_INPUT'});
  assert.equal(readFileSync(path,'utf8'),before);
  await f.provider.move_work_item(created.ref,'DOING',{idempotencyKey:'doing',intent:'start'});
  await f.provider.move_work_item(created.ref,'WAITING',{idempotencyKey:'wait',waitingReason:'Customer logs'});
  assert.equal((await f.provider.get_work_item(created.ref)).item.nextAction,'Waiting: Customer logs');
  await assert.rejects(f.provider.move_work_item(created.ref,'DONE',{idempotencyKey:'done',automatic:true}),{code:'WORK_LIFECYCLE'});
  const verified=new FileProvider(f.root,f.config,{readLifecycleTask:async(id:string)=>({id,phase:'done',status:'done'})});
  await verified.move_work_item(created.ref,'DONE',{idempotencyKey:'done',automatic:true});
  assert.equal((await verified.get_work_item(created.ref)).status,'DONE');
  assert.equal(JSON.parse(readFileSync(path,'utf8').trim().split('\n').at(-1)!).kind,'MOVE');
  const committed=readFileSync(path,'utf8');await verified.move_work_item(created.ref,'DONE',{idempotencyKey:'done',automatic:true});assert.equal(readFileSync(path,'utf8'),committed);
 }finally{f.cleanup();}
});
test('WIP is advisory and completed items remain searchable for stable replay',async()=>{
 const f=await localFixture();
 try{
  const p=new FileProvider(f.root,{enabled:true,provider:'local',limits:{doing:1}});
  const one=await p.create_work_item(workItem(),{idempotencyKey:'one'});const two=await p.create_work_item({...workItem(),title:'Other work'},{idempotencyKey:'two'});
  await p.move_work_item(one.ref,'DOING',{intent:'start',idempotencyKey:'start-one'});
  const result=await p.move_work_item(two.ref,'DOING',{intent:'select',idempotencyKey:'start-two'});assert.equal(result.warnings.length,1);
  await p.move_work_item(one.ref,'DONE',{idempotencyKey:'done'});assert.equal((await p.search_work_items()).items.length,2);
 }finally{f.cleanup();}
});
