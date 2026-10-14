import assert from 'node:assert/strict';
import test from 'node:test';
import {resolve} from 'node:path';
import {localFixture,workItem,source} from './work-fixture.js';
const {intake}=await import(resolve('assets/aidlc/work/lib/operations.mjs'));
test('local intake groups sources, replays, enriches identities and asks for ambiguous matches',async()=>{
 const f=await localFixture();try{
 const p=f.provider;const batch=[{classification:'CONTEXT',source:source('logs'),groupId:'retry'},{classification:'ACTIONABLE',source:source(),item:workItem(),groupId:'retry'}];
 const first=await intake(p,batch,{idempotencyKey:'batch'});assert.equal(first.results[1].outcome,'CREATE');
 const ref=first.results[1].ref;assert.equal((await p.get_work_item(ref)).context.records.length,2);
 await intake(p,batch,{idempotencyKey:'batch'});assert.equal((await p.search_work_items()).items.length,1);assert.equal((await p.get_work_item(ref)).context.records.length,2);
 await intake(p,[{classification:'CONTEXT',source:source('m3')}],{idempotencyKey:'enrich'});
 assert.equal((await p.get_work_item(ref)).context.records.length,3);
 const ignored=await intake(p,[{classification:'REFERENCE',source:{...source('unrelated'),threadId:null,body:'Lunch menu'}}],{idempotencyKey:'ignore'});
 assert.equal(ignored.results[0].outcome,'IGNORE');
 const ambiguous=await intake(p,[{classification:'ACTIONABLE',source:{...source('new'),threadId:null},item:workItem()}],{idempotencyKey:'weak'});
 assert.equal(ambiguous.results[0].outcome,'AMBIGUOUS');assert.equal((await p.search_work_items()).items.length,1);
 }finally{f.cleanup();}
});
test('invalid later batch message prevents earlier writes',async()=>{
 const f=await localFixture();try{
 await assert.rejects(intake(f.provider,[{classification:'ACTIONABLE',source:source(),item:workItem()},{classification:'INVALID',source:source('x')}],{idempotencyKey:'invalid'}));
 assert.equal((await f.provider.search_work_items()).items.length,0);
 }finally{f.cleanup();}
});

test('raw-source opt-out stores summaries while retaining replay identity',async()=>{
 const f=await localFixture();try{
 const {FileProvider}=await import(resolve('assets/aidlc/work/lib/file-provider.mjs'));
 const {readFileSync}=await import('node:fs');const {join}=await import('node:path');
 const p=new FileProvider(f.root,{enabled:true,provider:'local',capture:{preserveRawSource:false}});
 const batch=[{classification:'ACTIONABLE',source:{...source(),body:'Sensitive original investigation transcript'},item:workItem(),contextSummary:'Investigate retry'}];
 const result=await intake(p,batch,{idempotencyKey:'raw-disabled'});const ref=result.results[0].ref;
 await intake(p,batch,{idempotencyKey:'raw-disabled'});
 const journal=readFileSync(join(f.root,'.agents/data/work',ref.id,'events.jsonl'),'utf8');
 assert.equal(journal.includes('Sensitive original investigation transcript'),false);
 assert.equal((await p.search_work_items()).items.length,1);assert.equal((await p.get_work_item(ref)).context.records.length,1);
 }finally{f.cleanup();}
});
