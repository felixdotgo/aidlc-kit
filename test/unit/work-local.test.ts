import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {workItem} from './work-fixture.js';
const {executeWork}=await import(resolve('assets/aidlc/work/lib/local.mjs'));
test('init preserves configuration and store identity; utility/link operations preserve lifecycle authority',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aidlc-local-cli-'));
 try{
 mkdirSync(join(root,'.agents'));const config=join(root,'.agents/config.json');
 writeFileSync(config,JSON.stringify({schemaVersion:3,commands:{test:{command:'npm',args:['test']}}}));
 const init=await executeWork(root,'init');const again=await executeWork(root,'init');assert.equal(init.storeId,again.storeId);
 assert.equal(JSON.parse(readFileSync(config,'utf8')).commands.test.command,'npm');
 assert.equal((await executeWork(root,'preflight')).ready,true);
 const script=resolve('assets/aidlc/scripts/state.mjs');
 const created=spawnSync(process.execPath,[script,'task','create','fix-retry','--title','Fix retry','--language','en','--root',root],{encoding:'utf8'});
 assert.equal(created.status,0,created.stderr);
 const intent=join(root,'.agents/data/tasks/fix-retry/intent.md');mkdirSync(join(root,'.agents/data/tasks/fix-retry'),{recursive:true});writeFileSync(intent,'# Fix retry\n');
 const state=join(root,'.agents/data/state/aidlc-state.json');const before=readFileSync(state,'utf8');
 const work=await executeWork(root,'create',{item:workItem(),idempotencyKey:'create'});
 await executeWork(root,'move',{ref:work.ref,status:'DOING',intent:'start',idempotencyKey:'doing'});
 await executeWork(root,'link',{ref:work.ref,taskId:'fix-retry',intent:'implement',idempotencyKey:'link'});
 assert.equal(readFileSync(state,'utf8'),before);assert.match(readFileSync(intent,'utf8'),/Provider: local/);
 assert.equal((await executeWork(root,'get',{ref:work.ref})).item.aidlcTaskId,'fix-retry');
 const journal=join(root,'.agents/data/work',work.ref.id,'events.jsonl');const raw=readFileSync(journal,'utf8');
 await executeWork(root,'repair',{ref:work.ref});assert.equal(readFileSync(journal,'utf8'),raw);
 const cli=spawnSync(process.execPath,[resolve('assets/aidlc/scripts/work.mjs'),'preflight','--root',root],{encoding:'utf8',input:'{}'});
 assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).result.ready,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('disabled operations and unsupported provider configuration fail before network or mutation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aidlc-local-disabled-'));try{
 mkdirSync(join(root,'.agents'));const file=join(root,'.agents/config.json');writeFileSync(file,'{"personalWork":{"enabled":false}}');const before=readFileSync(file,'utf8');
 await assert.rejects(executeWork(root,'search'),{code:'WORK_DISABLED'});assert.equal(readFileSync(file,'utf8'),before);
 await assert.rejects(executeWork(root,'init',{token:'secret'}),{code:'INVALID_INPUT'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
