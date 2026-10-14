import { createHash } from 'node:crypto';
import { WorkError, validateItem, validateSource, validateCheckpoint, STATUSES, CLASSIFICATIONS, object, text, timestamp } from './contracts.mjs';
import { redact } from './redact.mjs';

export const EVENT_CHARS = 16000;
export const UPDATE_FIELDS = ['title','summary','expectedOutcome','nextAction','priority','due','project','aidlcTaskId','dedupe'];
const canonical = value => {
  if (Array.isArray(value)) return value.map(v => canonical(v ?? null));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new WorkError('INVALID_INPUT','Work records must contain JSON values');
};
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const sourceIdentity = source => `source:${source.source}:${hash(source.externalId == null ? source : source.externalId)}`;
export const threadIdentity = source => source.threadId == null ? null : `thread:${source.source}:${hash(source.threadId)}`;
export const enrichIdentities = (item, sources) => ({ ...item, dedupe: { ...item.dedupe,
  externalIds: [...new Set([...item.dedupe.externalIds,...sources.map(sourceIdentity)])],
  threadIds: [...new Set([...item.dedupe.threadIds,...sources.map(threadIdentity).filter(Boolean)])] } });
export const validatePatch = value => {
  const v = object(value,'item patch');
  if (!Object.keys(v).length || Object.keys(v).some(k=>!UPDATE_FIELDS.includes(k))) throw new WorkError('INVALID_INPUT','Unsupported item patch; status uses move');
  return v;
};
export const validateContext = (kind,data) => {
  if (kind === 'CHECKPOINT') return validateCheckpoint(data);
  if (kind === 'SOURCE') {
    const v=object(data,'source context');
    if(!CLASSIFICATIONS.includes(v.classification))throw new WorkError('INVALID_INPUT','Invalid source classification');
    return {source:validateSource(v.source),classification:v.classification};
  }
  if(kind !== 'CONTEXT')throw new WorkError('INVALID_INPUT','Unknown context kind');
  return canonical(object(data,'context'));
};
export const makeEvent = (kind, data, mutation, previous) => {
  const event = { schemaVersion:1, seq:(previous?.seq??0)+1, at:new Date().toISOString(), kind,
    key:mutation.key,digest:mutation.digest,data:redact(data),prevHash:previous?.checksum??null };
  const complete = {...event,checksum:hash(event)};
  if(JSON.stringify(complete).length>EVENT_CHARS)throw new WorkError('WORK_LIMIT','Work event exceeds the 16000-character budget');
  return complete;
};
export const reduceEvents = events => {
  let item; const mutations=[]; const records=[];
  for(const e of events){
    if(e.kind==='CREATE'){
      if(item || e.seq!==1)throw new WorkError('WORK_CORRUPT','Work journal has an invalid create event');
      item=validateItem(e.data);
    }else{
      if(!item)throw new WorkError('WORK_CORRUPT','Work journal has no create event');
      if(e.kind==='UPDATE')item=validateItem({...item,...validatePatch(e.data)});
      else if(e.kind==='MOVE'){
        const v=object(e.data,'status event');
        if(!STATUSES.includes(v.status))throw new WorkError('WORK_CORRUPT','Unknown stored work status');
        item=validateItem({...item,status:v.status,...(v.nextAction?{nextAction:text(v.nextAction,'next action')}: {})});
      }else{
        const data=validateContext(e.kind,e.data);
        records.push({id:String(e.seq).padStart(20,'0'),at:e.at,kind:e.kind,key:e.key,digest:e.digest,data,valid:true});
      }
    }
    mutations.push({kind:e.kind,key:e.key,digest:e.digest});
  }
  if(!item)throw new WorkError('WORK_CORRUPT','Work journal is empty');
  return {item,mutations,records};
};
export const parseJournal = raw => {
  try{
    if(!raw || !raw.endsWith('\n'))throw Error();
    const lines=raw.slice(0,-1).split('\n');const events=[];const keys=new Set();let previous=null;
    for(const line of lines){
      if(!line || line.length>EVENT_CHARS)throw Error();
      const e=JSON.parse(line);const {checksum,...body}=e;
      if(e.schemaVersion!==1 || e.seq!==events.length+1 || !Number.isSafeInteger(e.seq) || !['CREATE','UPDATE','MOVE','SOURCE','CHECKPOINT','CONTEXT'].includes(e.kind) || !/^[0-9a-f]{64}$/.test(e.key??'') || !/^[0-9a-f]{64}$/.test(e.digest??'') || e.prevHash!==previous || checksum!==hash(body) || keys.has(e.key))throw Error();
      timestamp(e.at,'event timestamp'); keys.add(e.key);events.push(e);previous=checksum;
    }
    return {events,...reduceEvents(events)};
  }catch{throw new WorkError('WORK_CORRUPT','Work journal is malformed or its checksum/sequence is invalid; restore a verified backup before writing');}
};
