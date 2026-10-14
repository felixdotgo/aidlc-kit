import { WorkError, validateItem, text, STATUSES } from './contracts.mjs';
import { validatePersonalWork } from './config.mjs';
import { WorkStore } from './work-store.mjs';
import { hash, enrichIdentities, validatePatch, validateContext } from './records.mjs';
import { redact } from './redact.mjs';
import { requireComplete } from './provider.mjs';

export class FileProvider {
  #store; #readLifecycleTask;
  constructor(root,configuration,{readLifecycleTask}={}) {
    const config=validatePersonalWork(configuration);
    if(!config.enabled)throw new WorkError('WORK_DISABLED','Personal work is disabled');
    this.#store=new WorkStore(root);this.#readLifecycleTask=readLifecycleTask;
    this.provider='local';this.target=this.#store.root;
    this.settings={capture:config.capture,limits:config.limits};
  }
  safe(value){return redact(value);}
  initialize(){return this.#store.initialize();}
  repair(ref){return this.#store.repair(ref,this.settings.limits.searchItems);}
  async preflight(){
    return this.#store.locked(async()=>({provider:'local',ready:true,storeId:this.#store.metadata().id,path:'.agents/data/work'}));
  }
  mutation(key,kind,value){return {key:hash(text(key,'idempotency key',256)),digest:hash([kind,value])};}
  replay(state,mutation){
    const old=state.mutations.find(m=>m.key===mutation.key);
    if(old && old.digest!==mutation.digest)throw new WorkError('WORK_IDEMPOTENCY','Mutation key was reused with different input');
    return Boolean(old);
  }
  summary(state){
    return {ref:this.#store.reference(state.id),item:state.item,title:state.item.title,summary:state.item.summary,status:state.item.status,archived:state.item.status==='DONE',mutations:state.mutations};
  }
  async search_work_items({query='',authoritative=true}={}){
    if(typeof query!=='string' || query.length>2048 || typeof authoritative!=='boolean')throw new WorkError('INVALID_INPUT','Invalid local search input');
    return this.#store.locked(async()=>{
      const found=this.#store.scan(this.settings.limits.searchItems);
      const items=found.items.map(state=>this.summary(state));
      return {...found,items:query?items.filter(x=>`${x.title} ${x.summary}`.toLowerCase().includes(query.toLowerCase())):items};
    });
  }
  async get_work_item(reference){
    return this.#store.locked(async()=>{
      const ref=this.#store.checkReference(reference);const state=this.#store.read(ref.id);
      const limit=this.settings.limits.contextRecords;
      let records=state.records.slice(-limit);
      const checkpoint=state.records.filter(r=>r.kind==='CHECKPOINT').at(-1);
      // Pin the newest checkpoint even when a long newer context stream fills the window.
      if(checkpoint && !records.some(r=>r.id===checkpoint.id))records=[checkpoint,...records.slice(-(limit-1 || 0))].slice(0,limit);
      const newer=checkpoint?state.records.filter(r=>r.id>checkpoint.id):[];
      const checkpointConflict=newer.some(r=>r.data?.invalidatesCheckpoint===true || r.data?.invalidatesCheckpointId===checkpoint?.id);
      return {...this.summary(state),context:{records,complete:state.records.length<=limit,cursor:state.records.length>limit?'history-limit':null,checkpointComplete:true,checkpointConflict}};
    });
  }
  async create_work_item(value,{idempotencyKey}={}){
    const normalized=validateItem(value);const item=validateItem(this.safe(enrichIdentities(normalized,normalized.sources)));
    if(!['INBOX','READY'].includes(item.status))throw new WorkError('WORK_INTENT','New work may start only in INBOX or READY');
    const mutation=this.mutation(idempotencyKey,'CREATE',value);
    return this.#store.locked(async()=>{
      const all=requireComplete(this.#store.scan(this.settings.limits.searchItems));
      const matches=all.items.filter(s=>s.mutations.some(m=>m.key===mutation.key) || s.item.dedupe.externalIds.some(id=>item.dedupe.externalIds.includes(id)));
      if(matches.length>1)throw new WorkError('WORK_AMBIGUOUS','Multiple local items match the source or creation key');
      if(matches.length){
        const state=matches[0];
        if(this.replay(state,mutation))return {...this.summary(state),replayed:true};
        // Persist a new creation-key alias as a small audit context, without a second source/work item.
        const alias=this.#store.append(state,'CONTEXT',{system:'Creation replay by an existing stable source identity'},mutation);
        return {...this.summary(alias.state),replayed:true,warnings:alias.warnings};
      }
      const created=this.#store.create(item,mutation);
      return {...this.summary(created.state),replayed:false,warnings:created.warnings};
    });
  }
  async update_work_item(reference,value,{idempotencyKey}={}){
    const patch=validatePatch(value);const mutation=this.mutation(idempotencyKey,'UPDATE',value);
    return this.#store.locked(async()=>{
      const ref=this.#store.checkReference(reference);const state=this.#store.read(ref.id);
      if(this.replay(state,mutation))return {...this.summary(state),replayed:true};
      const item=validateItem({...state.item,...this.safe(patch)});
      for(const field of ['externalIds','threadIds','references'])if(state.item.dedupe[field].some(id=>!item.dedupe[field].includes(id)))throw new WorkError('WORK_CONFLICT','Stored source identities/references cannot be removed by a projection update');
      const saved=this.#store.append(state,'UPDATE',Object.fromEntries(Object.keys(patch).map(k=>[k,item[k]])),mutation);
      return {...this.summary(saved.state),replayed:false,warnings:saved.warnings};
    });
  }
  async append_context(reference,{kind,data},{idempotencyKey}={}){
    const normalized=this.safe(validateContext(kind,data));const mutation=this.mutation(idempotencyKey,kind,data);
    return this.#store.locked(async()=>{
      const ref=this.#store.checkReference(reference);const state=this.#store.read(ref.id);
      if(this.replay(state,mutation)){
        const previous=state.records.find(r=>r.key===mutation.key);
        return {ref,replayed:true,recordId:previous?.id};
      }
      const saved=this.#store.append(state,kind,normalized,mutation);
      return {ref,replayed:false,recordId:String(saved.state.events.at(-1).seq).padStart(20,'0'),warnings:saved.warnings};
    });
  }
  async move_work_item(reference,status,{idempotencyKey,intent,waitingReason,automatic=false}={}){
    if(!STATUSES.includes(status) || typeof automatic!=='boolean')throw new WorkError('INVALID_INPUT','Invalid work status or completion mode');
    if(status==='DOING' && !['start','select'].includes(intent))throw new WorkError('WORK_INTENT','DOING requires explicit start or selection');
    if(status==='WAITING')text(waitingReason,'waiting reason');
    const data={status,...(status==='WAITING'?{nextAction:`Waiting: ${waitingReason}`}:{})};
    const mutation=this.mutation(idempotencyKey,'MOVE',{status,intent:intent??null,waitingReason:waitingReason??null,automatic});
    return this.#store.locked(async()=>{
      const ref=this.#store.checkReference(reference);const state=this.#store.read(ref.id);
      if(this.replay(state,mutation))return {...this.summary(state),replayed:true,warnings:[]};
      if(status==='DONE' && automatic && state.item.aidlcTaskId){
        const linked=await this.#readLifecycleTask?.(state.item.aidlcTaskId);
        if(!linked || linked.id!==state.item.aidlcTaskId || linked.phase!=='done' || linked.status!=='done')throw new WorkError('WORK_LIFECYCLE','Automatic completion requires a fresh successful linked AI-DLC task');
      }
      const warnings=[];
      if(status==='DOING'){
        const all=requireComplete(this.#store.scan(this.settings.limits.searchItems));
        if(all.items.filter(s=>s.id!==state.id && s.item.status==='DOING').length>=this.settings.limits.doing)warnings.push('Configured advisory DOING limit will be exceeded');
      }
      const saved=this.#store.append(state,'MOVE',this.safe(data),mutation);
      return {...this.summary(saved.state),replayed:false,warnings:[...warnings,...saved.warnings]};
    });
  }
}
