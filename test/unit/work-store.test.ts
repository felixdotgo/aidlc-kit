import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {workItem} from './work-fixture.js';
const {WorkStore}=await import(resolve('assets/aidlc/work/lib/work-store.mjs'));
const {hash,enrichIdentities}=await import(resolve('assets/aidlc/work/lib/records.mjs'));
test('real local journals are authoritative; corrupt history fails closed and failed projections remain repairable',async()=>{
 const root=mkdtempSync(join(tmpdir(),'work-store-'));
 try{
  const store=new WorkStore(root);await store.initialize();
  const created=await store.locked(async()=>store.create(enrichIdentities(workItem(),[]),{key:hash('create'),digest:hash('create-data')}));
  const id=created.state.id;const ref=store.reference(id);const base=join(root,'.agents/data/work',id);
  const before=readFileSync(join(base,'events.jsonl'),'utf8');
  writeFileSync(join(base,'item.json'),'manual projection edit');
  assert.equal(store.read(id).item.status,'INBOX');
  unlinkSync(join(base,'sources.jsonl'));mkdirSync(join(base,'sources.jsonl'));
  const result=await store.locked(async()=>store.append(store.read(id),'UPDATE',{nextAction:'Inspect logs'},{key:hash('update'),digest:hash('patch')}));
  assert.equal(result.state.item.nextAction,'Inspect logs');assert.equal(result.warnings.length,1);
  assert.ok(readFileSync(join(base,'events.jsonl'),'utf8').startsWith(before));
  rmSync(join(base,'sources.jsonl'),{recursive:true});await store.repair(ref,500);
  assert.equal(JSON.parse(readFileSync(join(base,'item.json'),'utf8')).item.nextAction,'Inspect logs');
  assert.throws(()=>store.checkReference({...ref,url:ref.url.replace(/\/[^/]+$/,'/11111111-1111-4111-8111-111111111111')}),{code:'INVALID_INPUT'});
  writeFileSync(join(base,'events.jsonl'),'incomplete');
  assert.throws(()=>store.read(id),{code:'WORK_CORRUPT'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
