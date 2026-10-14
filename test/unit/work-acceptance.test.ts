import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {localFixture,workItem,source} from './work-fixture.js';
const script=resolve('assets/aidlc/scripts/work.mjs');
const cli=(root:string,operation:string,input:unknown)=>new Promise<any>((done,reject)=>{
 const guard='globalThis.fetch=()=>{throw Error("network forbidden")};';
 const child=spawn(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(guard),script,operation,'--root',root],{stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
 child.on('close',code=>{if(code!==0)return reject(Error(err));try{done(JSON.parse(out).result);}catch(e){reject(e);}});
 child.stdin.end(JSON.stringify(input));
});
test('independent processes race creation and context replay without duplicate authority',async()=>{
 const f=await localFixture();try{
 const input={item:{...workItem(),sources:[source()]},idempotencyKey:'same-create'};
 const created=await Promise.all(Array.from({length:6},()=>cli(f.root,'create',input)));
 assert.equal(new Set(created.map(x=>x.ref.id)).size,1);const ref=created[0].ref;
 const context={ref,idempotencyKey:'same-comment',context:{kind:'CONTEXT',data:{body:'Concurrent finding'}}};
 await Promise.all(Array.from({length:6},()=>cli(f.root,'comment',context)));
 const work=await cli(f.root,'get',{ref});assert.equal(work.context.records.length,1);
 const raw=readFileSync(join(f.root,'.agents/data/work',ref.id,'events.jsonl'),'utf8');
 assert.equal(raw.trim().split('\n').length,2);
 await assert.rejects(cli(f.root,'comment',{...context,context:{kind:'CONTEXT',data:{body:'Changed retry'}}}),/WORK_IDEMPOTENCY/);
 assert.equal(readFileSync(join(f.root,'.agents/data/work',ref.id,'events.jsonl'),'utf8'),raw);
 assert.equal((await cli(f.root,'search',{})).items.length,1);
 }finally{f.cleanup();}
});
test('crashed process lock is safely reclaimed and unpublished staging is ignored',async()=>{
 const f=await localFixture();let child:any;try{
 const uri=JSON.stringify('file://'+resolve('assets/aidlc/work/lib/filesystem.mjs'));
 const code=`import {withWorkLock} from ${uri};import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';await withWorkLock(process.argv[1],async()=>{const path=join(process.argv[1],'.agents/data/work/.pending-crashed');mkdirSync(path);writeFileSync(join(path,'events.jsonl'),'torn unpublished event');writeFileSync(join(process.argv[1],'.agents/data/work/orphan.tmp-crashed'),'incomplete');process.stdout.write('locked');await new Promise(()=>{});});`;
 child=spawn(process.execPath,['--input-type=module','-e',code,f.root],{stdio:['ignore','pipe','pipe']});
 await once(child.stdout,'data');const stopped=once(child,'exit');child.kill('SIGKILL');await stopped;
 await new Promise(done=>setTimeout(done,1100));
 const got=await cli(f.root,'create',{item:workItem(),idempotencyKey:'after-crash'});
 assert.ok(got.ref.id);assert.equal((await cli(f.root,'search',{})).items.length,1);
 assert.equal(existsSync(join(f.root,'.agents/data/work/.pending-crashed/events.jsonl')),true);
 }finally{if(child?.exitCode===null)child.kill('SIGKILL');f.cleanup();}
});
test('incomplete scans block absence-based creation and corrupt authority blocks reads and repair',async()=>{
 const f=await localFixture();try{
 const first=await f.provider.create_work_item(workItem(),{idempotencyKey:'a'});
 await f.provider.create_work_item({...workItem(),title:'Other'}, {idempotencyKey:'b'});
 const config=join(f.root,'.agents/config.json');writeFileSync(config,JSON.stringify({personalWork:{enabled:true,provider:'local',limits:{searchItems:1}}}));
 assert.equal((await cli(f.root,'search',{})).complete,false);
 await assert.rejects(cli(f.root,'create',{item:workItem(),idempotencyKey:'c'}),/WORK_INCOMPLETE/);
 const journal=join(f.root,'.agents/data/work',first.ref.id,'events.jsonl');const raw=readFileSync(journal,'utf8');
 writeFileSync(journal,raw+'{"torn":');
 await assert.rejects(cli(f.root,'get',{ref:first.ref}),/WORK_CORRUPT/);
 await assert.rejects(cli(f.root,'repair',{ref:first.ref}),/WORK_CORRUPT/);
 assert.equal(readFileSync(journal,'utf8'),raw+'{"torn":');
 }finally{f.cleanup();}
});

test('initialized private work is ignored in a normal Git project and new files have private modes',async()=>{
 const f=await localFixture();try{
 const {statSync}=await import('node:fs');
 const init=spawnSync('git',['init','--quiet',f.root],{encoding:'utf8'});assert.equal(init.status,0,init.stderr);
 const work=await f.provider.create_work_item({...workItem(),sources:[source()]},{idempotencyKey:'private'});
 const path='.agents/data/work/'+work.ref.id+'/events.jsonl';
 const ignored=spawnSync('git',['-C',f.root,'check-ignore',path,'.agents/data/work/store.json'],{encoding:'utf8'});
 assert.equal(ignored.status,0,ignored.stderr);assert.match(ignored.stdout,/events.jsonl/);
 assert.equal((await f.provider.get_work_item(work.ref)).item.sources[0].externalId,'m1');
 const projection=readFileSync(join(f.root,'.agents/data/work',work.ref.id,'sources.jsonl'),'utf8');assert.match(projection,/INITIAL_SOURCE/);
 if(process.platform!=='win32'){
 assert.equal(statSync(join(f.root,path)).mode & 0o077,0);
 assert.equal(statSync(join(f.root,'.agents/data/work',work.ref.id)).mode & 0o077,0);
 }
 }finally{f.cleanup();}
});
