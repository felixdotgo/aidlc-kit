import { opendirSync, lstatSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { WorkError, validUuid, validateRef } from './contracts.mjs';
import { STORE_PATH, JOURNAL_BYTES, SEARCH_BYTES, projectRoot, safePath, ensureDirectory, readText, atomicWrite, exists, withWorkLock } from './filesystem.mjs';
import { makeEvent, parseJournal } from './records.mjs';

export class WorkStore {
  constructor(root) { this.root=projectRoot(root); }
  locked(operation,options) { return withWorkLock(this.root,operation,options); }
  metadata() {
    const path=`${STORE_PATH}/store.json`;
    if(!exists(safePath(this.root,path)))throw new WorkError('WORK_NOT_INITIALIZED','Local work is not initialized; run work.mjs init first');
    try{
      const data=JSON.parse(readText(this.root,path,4096));
      if(data.schemaVersion!==1 || !validUuid(data.id))throw Error();
      return data;
    }catch(e){if(e instanceof WorkError)throw e;throw new WorkError('WORK_CORRUPT','Local work store metadata is invalid; restore a verified backup');}
  }
  async initialize() {
    return this.locked(async()=>{
      const path=`${STORE_PATH}/store.json`;
      if(!exists(safePath(this.root,path))){
        const dir=opendirSync(safePath(this.root,STORE_PATH));
        try{let entry;while((entry=dir.readSync()))if(validUuid(entry.name))throw new WorkError('WORK_CORRUPT','Existing work journals have no store identity; restore metadata from backup');}finally{dir.closeSync();}
        atomicWrite(this.root,path,JSON.stringify({schemaVersion:1,id:randomUUID()})+'\n',4096);
      }
      const metadata=this.metadata();
      if(!exists(safePath(this.root,`${STORE_PATH}/.gitignore`)))atomicWrite(this.root,`${STORE_PATH}/.gitignore`,'# Private personal work; back up separately.\n*\n!.gitignore\n',4096);
      return {provider:'local',initialized:true,storeId:metadata.id,path:STORE_PATH};
    },{initialize:true});
  }
  reference(id) {
    if(!validUuid(id))throw new WorkError('WORK_TARGET','Invalid local work ID');
    return {provider:'local',id,url:`aidlc-work://${this.metadata().id}/${id}`};
  }
  checkReference(reference) {
    const ref=validateRef(reference);
    if(ref.provider!=='local' || ref.url!==this.reference(ref.id).url)throw new WorkError('WORK_TARGET','Work reference belongs to a different project store');
    return ref;
  }
  read(id) {
    if(!validUuid(id))throw new WorkError('WORK_TARGET','Invalid local work ID');
    this.metadata();
    const path=`${STORE_PATH}/${id}/events.jsonl`;
    if(!exists(safePath(this.root,path)))throw new WorkError('WORK_NOT_FOUND','Local work item was not found');
    const raw=readText(this.root,path,JOURNAL_BYTES);
    return {id,raw,...parseJournal(raw)};
  }
  scan(limit) {
    this.metadata();const ids=[];let complete=true;
    const dir=opendirSync(safePath(this.root,STORE_PATH));
    try{
      let entry;
      while((entry=dir.readSync())){
        if(!validUuid(entry.name))continue;
        const path=safePath(this.root,`${STORE_PATH}/${entry.name}`);
        if(!lstatSync(path).isDirectory())throw new WorkError('WORK_CORRUPT','Work ID is not a directory');
        if(ids.length===limit){complete=false;break;}
        ids.push(entry.name);
      }
    }finally{dir.closeSync();}
    const items=[];let bytes=0;
    for(const id of ids.sort()){
      const path=safePath(this.root,`${STORE_PATH}/${id}/events.jsonl`);
      if(!exists(path))throw new WorkError('WORK_CORRUPT','Published work item has no journal');
      const size=lstatSync(path).size;
      if(bytes+size>SEARCH_BYTES){complete=false;break;}
      bytes+=size;items.push(this.read(id));
    }
    return {items,complete,cursor:complete?null:'limit-reached'};
  }
  project(state) {
    const base=`${STORE_PATH}/${state.id}`;
    atomicWrite(this.root,`${base}/item.json`,JSON.stringify({schemaVersion:1,revision:state.events.at(-1).seq,item:state.item},null,2)+'\n');
    const lines=records=>records.map(r=>JSON.stringify(r)+'\n').join('');
    const initial=state.events[0].data.sources.map((source,index)=>({id:`initial-${index}`,kind:'INITIAL_SOURCE',data:{source}}));
    atomicWrite(this.root,`${base}/sources.jsonl`,lines([...initial,...state.records.filter(r=>r.kind==='SOURCE')]));
    atomicWrite(this.root,`${base}/checkpoints.jsonl`,lines(state.records.filter(r=>r.kind==='CHECKPOINT')));
  }
  projectSafely(state) {
    try{this.project(state);return [];}
    catch{return ['Journal committed; one or more readable projections could not be refreshed. Run work.mjs repair after fixing projection paths/permissions.'];}
  }
  create(data,mutation) {
    this.metadata();const id=randomUUID();const staging=`${STORE_PATH}/.pending-${id}`;const destination=`${STORE_PATH}/${id}`;
    ensureDirectory(this.root,staging);
    const event=makeEvent('CREATE',data,mutation);
    parseJournal(JSON.stringify(event)+'\n');
    atomicWrite(this.root,`${staging}/events.jsonl`,JSON.stringify(event)+'\n');
    if(exists(safePath(this.root,destination)))throw new WorkError('WORK_CONFLICT','Local work identity collision');
    renameSync(safePath(this.root,staging),safePath(this.root,destination));
    const fd=openSync(safePath(this.root,STORE_PATH),'r');
    try{fsyncSync(fd);}catch{throw new WorkError('WORK_UNCERTAIN','Work directory was published but durability is uncertain; reconcile the source identity');}finally{closeSync(fd);}
    const state=this.read(id);
    return {state,warnings:this.projectSafely(state)};
  }
  append(state,kind,data,mutation) {
    const event=makeEvent(kind,data,mutation,state.events.at(-1));
    const raw=state.raw+JSON.stringify(event)+'\n';
    // Validate the complete resulting history before changing authority.
    parseJournal(raw);
    atomicWrite(this.root,`${STORE_PATH}/${state.id}/events.jsonl`,raw);
    const next=this.read(state.id);
    return {state:next,warnings:this.projectSafely(next)};
  }
  async repair(reference,limit) {
    return this.locked(async()=>{
      const found=reference?null:this.scan(limit);
      if(found && !found.complete)throw new WorkError('WORK_INCOMPLETE','Repair exceeds the configured work-item scan limit');
      const states=reference?[this.read(this.checkReference(reference).id)]:found.items;
      for(const state of states)this.project(state);
      return {provider:'local',repaired:states.length};
    });
  }
}
