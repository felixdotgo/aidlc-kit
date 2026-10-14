import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
const f=await import(resolve('assets/aidlc/work/lib/filesystem.mjs'));
test('local filesystem guards reject symlinks and traversal, and atomic writes retain complete content',async()=>{
 const root=mkdtempSync(join(tmpdir(),'work-fs-'));
 try{
  f.ensureDirectory(root,f.STORE_PATH);
  f.atomicWrite(root,f.STORE_PATH+'/sample.json','first');
  f.atomicWrite(root,f.STORE_PATH+'/sample.json','second');
  assert.equal(readFileSync(join(root,f.STORE_PATH,'sample.json'),'utf8'),'second');
  assert.throws(()=>f.safePath(root,'../escape'),{code:'WORK_PATH'});
  mkdirSync(join(root,'outside'));symlinkSync(join(root,'outside'),join(root,f.STORE_PATH,'linked'));
  assert.throws(()=>f.safePath(root,f.STORE_PATH+'/linked/item.json'),{code:'WORK_PATH'});
  assert.throws(()=>f.readText(root,f.STORE_PATH+'/sample.json',1),{code:'WORK_LIMIT'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('work locks serialize local writers and reclaim only a provably dead owner',async()=>{
 const root=mkdtempSync(join(tmpdir(),'work-lock-'));const order:string[]=[];
 try{
  f.ensureDirectory(root,f.STORE_PATH);
  await Promise.all([f.withWorkLock(root,async()=>{order.push('a');await new Promise(r=>setTimeout(r,40));order.push('b');}),f.withWorkLock(root,async()=>{order.push('c');})]);
  assert.deepEqual(order,['a','b','c']);
  writeFileSync(join(root,f.STORE_PATH,'.lock'),JSON.stringify({pid:2147483647,token:randomUUID(),at:'2000-01-01T00:00:00Z'}));
  assert.equal(await f.withWorkLock(root,async()=>42),42);
  writeFileSync(join(root,f.STORE_PATH,'.lock'),JSON.stringify({pid:process.pid,token:randomUUID(),at:'2000-01-01T00:00:00Z'}));
  await assert.rejects(f.withWorkLock(root,async()=>{}, {timeoutMs:30}),{code:'WORK_LOCKED'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
