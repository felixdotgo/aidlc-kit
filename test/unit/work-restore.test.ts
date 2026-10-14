import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {localFixture,workItem} from './work-fixture.js';
const {FileProvider}=await import(resolve('assets/aidlc/work/lib/file-provider.mjs'));
const {checkpoint,restore}=await import(resolve('assets/aidlc/work/lib/operations.mjs'));
const cp=(action:string)=>({schemaVersion:1,goal:'Fix retry',state:'Rollback still running',hypothesis:'Race',nextAction:action,capturedAt:'2026-10-09T00:00:00Z',completed:['Reproduced'],observations:[],blockers:['Customer logs'],files:['retry.ts'],links:[]});
test('restore without checkpoint uses item action without invented conflict',async()=>{
 const f=await localFixture();try{
 const work=await f.provider.create_work_item(workItem(),{idempotencyKey:'create'});
 await f.provider.append_context(work.ref,{kind:'CONTEXT',data:{body:'Investigation notes'}},{idempotencyKey:'notes'});
 const packet=await restore(f.provider,work.ref);assert.equal(packet.conflict,false);assert.equal(packet.checkpointAt,null);assert.equal(packet.nextAction,workItem().nextAction);
 }finally{f.cleanup();}
});
test('newest local checkpoint and full-history invalidation survive a one-record read window',async()=>{
 const f=await localFixture();try{
 const p=f.provider;const work=await p.create_work_item(workItem(),{idempotencyKey:'create'});
 await checkpoint(p,work.ref,cp('Old action'),{idempotencyKey:'cp1'});await checkpoint(p,work.ref,cp('Add tracing'),{idempotencyKey:'cp2'});
 let packet=await restore(p,work.ref);assert.equal(packet.nextAction,'Add tracing');assert.deepEqual(packet.blockers,['Customer logs']);
 await p.append_context(work.ref,{kind:'CONTEXT',data:{body:'Race disproven',invalidatesCheckpoint:true}},{idempotencyKey:'invalidate'});
 await p.append_context(work.ref,{kind:'CONTEXT',data:{body:'Later unrelated notes'}},{idempotencyKey:'newer'});
 const limited=new FileProvider(f.root,{...f.config,limits:{contextRecords:1}});
 packet=await restore(limited,work.ref);assert.equal(packet.conflict,true);assert.match(packet.nextAction,/Resolve/);
 assert.equal(packet.historyComplete,false);assert.deepEqual(packet.blockers,['Customer logs']);assert.match(packet.notices.join(' '),/full journal/);assert.ok(JSON.stringify(packet).length<=12000);
 }finally{f.cleanup();}
});
