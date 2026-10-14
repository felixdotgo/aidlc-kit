import { constants, openSync, closeSync, readFileSync, writeFileSync, writeSync, fsyncSync, renameSync, unlinkSync, lstatSync, mkdirSync, fstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkError, validUuid } from './contracts.mjs';

export const STORE_PATH = '.agents/data/work';
export const JOURNAL_BYTES = 16 * 1024 * 1024;
export const SEARCH_BYTES = 64 * 1024 * 1024;
const stat = path => { try { return lstatSync(path); } catch(e) { if(e.code==='ENOENT')return null; throw e; } };
export const projectRoot = root => {
  if(typeof root!=='string' || !root.trim())throw new WorkError('WORK_PATH','A project root is required for local work');
  const path=resolve(root);const info=stat(path);
  if(!info?.isDirectory() || info.isSymbolicLink())throw new WorkError('WORK_PATH','Project root must be an existing non-symlink directory');
  return path;
};
export const safePath = (root, path) => {
  const base=projectRoot(root);const target=resolve(base,path);const inside=relative(base,target);
  if(isAbsolute(path) || inside==='..' || inside.startsWith(`..${sep}`))throw new WorkError('WORK_PATH','Work path escapes the project');
  let current=base;
  for(const part of inside.split(sep).filter(Boolean)){
    current=join(current,part);const info=stat(current);
    if(info?.isSymbolicLink())throw new WorkError('WORK_PATH','Work path crosses a symlink');
  }
  return target;
};
export const ensureDirectory = (root,path) => {
  const target=safePath(root,path);const inside=relative(root,target);let current=root;
  for(const part of inside.split(sep).filter(Boolean)){
    current=join(current,part);
    let info=stat(current);
    if(!info){try{mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}info=stat(current);}
    if(!info?.isDirectory() || info.isSymbolicLink())throw new WorkError('WORK_PATH','Expected a contained work directory');
  }
  return target;
};
export const readText = (root,path,maximum) => {
  const file=safePath(root,path);
  const before=lstatSync(file);
  if(!before.isFile() || before.nlink!==1)throw new WorkError('WORK_PATH','Work authority must be a regular non-linked file');
  const fd=openSync(file,constants.O_RDONLY | (constants.O_NOFOLLOW??0));
  try{
    const info=fstatSync(fd);
    if(!info.isFile() || info.nlink!==1)throw new WorkError('WORK_PATH','Work authority must be a regular non-linked file');
    if(info.size>maximum)throw new WorkError('WORK_LIMIT','Work file exceeds its read budget');
    const content=readFileSync(fd,'utf8');
    if(Buffer.byteLength(content)>maximum)throw new WorkError('WORK_LIMIT','Work file exceeds its read budget');
    return content;
  }finally{closeSync(fd);}
};
export const atomicWrite = (root,path,content,maximum=JOURNAL_BYTES) => {
  if(Buffer.byteLength(content)>maximum)throw new WorkError('WORK_LIMIT','Work file exceeds its write budget');
  const target=safePath(root,path);const info=stat(target);
  if(info && (!info.isFile() || info.nlink!==1))throw new WorkError('WORK_PATH','Work target must be a regular non-linked file');
  const parent=relative(root,dirname(target));ensureDirectory(root,parent);
  const temporary=safePath(root,`${path}.tmp-${randomUUID()}`);
  let fd;let published=false;
  try{
    fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
    writeFileSync(fd,content,'utf8');fsyncSync(fd);closeSync(fd);fd=undefined;
    safePath(root,path);safePath(root,relative(root,temporary));
    renameSync(temporary,target);published=true;
    const directory=openSync(dirname(target),constants.O_RDONLY);
    try{fsyncSync(directory);}finally{closeSync(directory);}
  }catch(error){
    if(published)throw new WorkError('WORK_UNCERTAIN','Work file was published but durability could not be confirmed; reconcile by reading before retrying');
    throw error;
  }finally{
    if(fd!==undefined)closeSync(fd);
    if(stat(temporary)){try{unlinkSync(temporary);}catch{}}
  }
};
const owner = (root,path) => {
  try {const v=JSON.parse(readText(root,path,4096));return Number.isSafeInteger(v.pid)&&v.pid>0&&validUuid(v.token)&&Number.isFinite(Date.parse(v.at))?v:null;}
  catch{return null;}
};
const dead = pid => {try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}};
const removeOwned = (root,path,token) => {
  const current=owner(root,path);if(current?.token===token)unlinkSync(safePath(root,path));
};
const claim = (root,path) => {
  const token=randomUUID();const fd=openSync(safePath(root,path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{writeSync(fd,JSON.stringify({pid:process.pid,token,at:new Date().toISOString()}));fsyncSync(fd);}finally{closeSync(fd);}
  return token;
};
export const withWorkLock = async (root,operation,{initialize=false,timeoutMs=5000}={}) => {
  root=projectRoot(root);const base=safePath(root,STORE_PATH);
  if(initialize)ensureDirectory(root,STORE_PATH);
  else if(!stat(base)?.isDirectory())throw new WorkError('WORK_NOT_INITIALIZED','Local work is not initialized; run work.mjs init first');
  const lock=`${STORE_PATH}/.lock`;const recovery=`${STORE_PATH}/.lock-recovery`;
  const deadline=Date.now()+timeoutMs;let token;
  while(!token){
    // Reclaimers are mutually exclusive. Normal acquisition waits for recovery.
    if(!stat(safePath(root,recovery))){
      try{token=claim(root,lock);break;}catch(e){if(e.code!=='EEXIST')throw e;}
      const previous=owner(root,lock);
      if(previous && Date.now()-Date.parse(previous.at)>1000 && dead(previous.pid)){
        let guard;
        try{
          guard=claim(root,recovery);
          const current=owner(root,lock);
          if(current?.token===previous.token && dead(current.pid))removeOwned(root,lock,current.token);
        }catch(e){if(e.code!=='EEXIST')throw e;}
        finally{if(guard)removeOwned(root,recovery,guard);}
      }
    }
    if(Date.now()>=deadline)throw new WorkError('WORK_LOCKED','Local work is busy or its lock owner cannot be safely reclaimed; inspect the owning process before retrying');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  let result;
  try{result=await operation();}
  finally{
    try{removeOwned(root,lock,token);}catch{if(result && typeof result==='object')result.warnings=[...(result.warnings??[]),'Work lock release failed; inspect the lock before the next operation'];}
  }
  return result;
};
export const exists = path => Boolean(stat(path));
