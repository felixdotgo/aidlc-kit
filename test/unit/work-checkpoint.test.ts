import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {localFixture,workItem} from './work-fixture.js';
const {checkpoint}=await import(resolve('assets/aidlc/work/lib/operations.mjs'));
export const savedContext = () => ({schemaVersion:1,goal:'Fix retry',state:'Rollback races retry',completed:['Reproduced timeout'],observations:['Cleanup still running'],hypothesis:'Race condition',blockers:['Need logs'],files:['src/retry.ts'],links:[],nextAction:'Add transaction tracing',capturedAt:'2026-10-09T00:00:00Z'});
test('local checkpoints preserve fields, append once per key, and never change status',async()=>{
 const f=await localFixture();try{
 const p=f.provider;const item=await p.create_work_item(workItem(),{idempotencyKey:'create'});
 await checkpoint(p,item.ref,savedContext(),{idempotencyKey:'cp1'});await checkpoint(p,item.ref,savedContext(),{idempotencyKey:'cp1'});
 await checkpoint(p,item.ref,{...savedContext(),nextAction:'Reproduce with tracing'},{idempotencyKey:'cp2'});
 const got=await p.get_work_item(item.ref);assert.equal(got.context.records.length,2);assert.equal(got.item.status,'INBOX');
 assert.equal(got.context.records[0].data.nextAction,'Add transaction tracing');assert.deepEqual(got.context.records[0].data.blockers,['Need logs']);
 await assert.rejects(checkpoint(p,item.ref,{...savedContext(),nextAction:''},{idempotencyKey:'bad'}));
 assert.equal((await p.get_work_item(item.ref)).context.records.length,2);
 }finally{f.cleanup();}
});
