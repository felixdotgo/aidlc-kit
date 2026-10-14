import { WorkError, CLASSIFICATIONS, validateSource, validateItem, validateRef, validateCheckpoint, text } from './contracts.mjs';
import { sourceIdentity, threadIdentity, enrichIdentities, validatePatch } from './records.mjs';
import { requireComplete } from './provider.mjs';
export const moveWork = (provider,ref,status,options) => provider.move_work_item(ref,status,options);
export const ready = item => Boolean(item.summary?.trim() && item.expectedOutcome?.trim() && item.nextAction?.trim());
const matches = (message, candidates) => {
  const identity=sourceIdentity(message.source);const thread=threadIdentity(message.source);
  const rules=[
    x=>x.item?.dedupe.externalIds.includes(identity),
    x=>thread && x.item?.dedupe.threadIds.includes(thread),
    x=>message.references.some(r=>x.item?.dedupe.references.includes(r)),
    x=>message.item?.aidlcTaskId && x.item?.aidlcTaskId===message.item.aidlcTaskId
  ];
  let result=[];
  for(const rule of rules){const found=candidates.filter(rule);if(found.length){if(!result.length)result=found;else if(found.some(x=>!result.some(y=>y.ref.id===x.ref.id)))return {ambiguous:[...new Map([...result,...found].map(x=>[x.ref.id,x])).values()]};}}
  if(result.length>1)return {ambiguous:result};
  if(result.length)return {match:result[0]};
  const words=message.item?.dedupe.keywords ?? [];
  const weak=candidates.filter(x=>words.some(w=>w.length>2 && `${x.title} ${x.item?.summary??''}`.toLowerCase().includes(w.toLowerCase())));
  return weak.length?{ambiguous:weak}:{};
};
export const intake = async (provider, input, { idempotencyKey } = {}) => {
  text(idempotencyKey,'intake idempotency key',256);
  if(!Array.isArray(input)||!input.length||input.length>provider.settings.limits.intakeMessages)throw new WorkError('WORK_LIMIT','Intake batch exceeds configured message limit');
  // Validate the whole batch before creating or appending anything.
  const messages=input.map((m,index)=>{
    if(!m || typeof m!=='object' || !CLASSIFICATIONS.includes(m.classification))throw new WorkError('INVALID_INPUT','Every source must be classified before intake');
    const references=m.references??[];
    if(!Array.isArray(references)||references.some(r=>typeof r!=='string'||!r.trim()||r.length>2048))throw new WorkError('INVALID_INPUT','Invalid source references');
    if(m.contextSummary!==undefined)text(m.contextSummary,'context summary');
    if(m.patch)validatePatch(m.patch);
    return {...m,index,references,source:validateSource(m.source),...(m.item?{item:validateItem(m.item)}:{}),...(m.selectedRef?{selectedRef:validateRef(m.selectedRef)}:{})};
  });
  const results=[];const groups=new Map();
  // Actionable sources establish groups; earlier related context then appends to them.
  for(const message of [...messages].sort((a,b)=>Number(b.classification==='ACTIONABLE')-Number(a.classification==='ACTIONABLE'))){
    if(message.classification==='NOISE'){results.push({index:message.index,outcome:'IGNORE'});continue;}
    const all=requireComplete(await provider.search_work_items());
    let resolution=matches(message,all.items);
    const selected=message.selectedRef ?? (message.groupId ? groups.get(message.groupId) : null);
    if(selected){
      const candidate=await provider.get_work_item(selected);
      if(resolution.match && resolution.match.ref.id!==candidate.ref.id)resolution={ambiguous:[resolution.match,candidate]};
      else if(resolution.ambiguous?.some(x=>x.item?.dedupe.externalIds.includes(sourceIdentity(message.source)) && x.ref.id!==candidate.ref.id))resolution={ambiguous:resolution.ambiguous};
      else resolution={match:candidate};
    }
    if(resolution.ambiguous){results.push({index:message.index,outcome:'AMBIGUOUS',candidates:resolution.ambiguous.slice(0,10).map(x=>({ref:x.ref,title:x.title}))});continue;}
    let current=resolution.match;let outcome='APPEND_CONTEXT';
    if(!current){
      if(message.classification!=='ACTIONABLE'){results.push({index:message.index,outcome:'IGNORE'});continue;}
      if(!message.item)throw new WorkError('INVALID_INPUT','An unmatched actionable message requires a normalized work item');
      const storedSource=provider.settings.capture.preserveRawSource?message.source:{...message.source,body:message.contextSummary??message.item.summary};
      const item={...message.item,sources:[storedSource],dedupe:{...message.item.dedupe,externalIds:[...new Set([...message.item.dedupe.externalIds,sourceIdentity(message.source)])],references:[...new Set([...message.item.dedupe.references,...message.references])]}};
      if(provider.settings.capture.autoReady && item.status==='INBOX' && ready(item))item.status='READY';
      current=await provider.create_work_item(item,{idempotencyKey:`create:${sourceIdentity(message.source)}`});outcome='CREATE';
    }
    if(!current.item)throw new WorkError('WORK_METADATA','Selected item lacks normalized metadata');
    const enriched=enrichIdentities(current.item,[message.source]);
    enriched.dedupe.references=[...new Set([...enriched.dedupe.references,...message.references])];
    if(JSON.stringify(enriched.dedupe)!==JSON.stringify(current.item.dedupe))current=await provider.update_work_item(current.ref,{dedupe:enriched.dedupe},{idempotencyKey:`identity:${sourceIdentity(message.source)}`});
    if(message.patch){current=await provider.update_work_item(current.ref,message.patch,{idempotencyKey:`projection:${sourceIdentity(message.source)}`});outcome='UPDATE';}
    const data={source:provider.settings.capture.preserveRawSource?message.source:{...message.source,body:message.contextSummary??message.item?.summary??'Related source context; raw body not retained'},classification:message.classification};
    const append=await provider.append_context(current.ref,{kind:'SOURCE',data},{idempotencyKey:sourceIdentity(message.source)});
    if(append.replayed && outcome!=='UPDATE')outcome='IGNORE';
    if(message.groupId)groups.set(message.groupId,current.ref);
    results.push({index:message.index,outcome,ref:current.ref,replayed:append.replayed});
  }
  return {results:results.sort((a,b)=>a.index-b.index)};
};
export const checkpoint = async (provider, reference, value, {idempotencyKey} = {}) => {
  const data=validateCheckpoint(value);
  return provider.append_context(validateRef(reference),{kind:'CHECKPOINT',data},{idempotencyKey});
};
export const restore = async (provider,reference) => {
  const work=await provider.get_work_item(validateRef(reference));
  const records=[...work.context.records].sort((a,b)=>b.id.localeCompare(a.id));
  const notices=[];let latest;
  for(const r of records.filter(r=>r.kind==='CHECKPOINT')){
    try{if(!r.valid)throw Error();const data=validateCheckpoint(r.data);if(!latest)latest={...r,data};}
    catch{notices.push('Malformed checkpoint found; its content is not used for resume.');}
  }
  if(!work.context.complete)notices.push(work.context.checkpointComplete ? 'Context history is incomplete; the newest checkpoint and explicit invalidation were checked against the full journal.' : 'History is incomplete; the newest valid checkpoint cannot be established beyond the read window.');
  const newer=latest?records.filter(r=>r.id>latest.id&&r.kind!=='CHECKPOINT'):records.filter(r=>r.kind!=='CHECKPOINT');
  const conflict=Boolean(latest && (work.context.checkpointConflict || newer.some(r=>r.data?.invalidatesCheckpoint===true || r.data?.invalidatesCheckpointId===latest.id)));
  if(conflict)notices.push('CONFLICT: newer context invalidates the checkpoint. Resolve this before following its next action.');
  else if(latest && newer.length)notices.push('Newer context requires review for possible checkpoint conflicts; no semantic consistency is assumed.');
  const data=latest?.data;
  const packet={ref:work.ref,aidlcTaskId:work.item?.aidlcTaskId??null,goal:data?.goal??work.item?.summary??work.title,state:data?.state??null,
    completed:data?.completed??[],observations:data?.observations??[],hypothesis:data?.hypothesis??null,blockers:data?.blockers??[],files:data?.files??[],links:data?.links??work.item?.dedupe.references??[],
    nextAction:conflict?'Resolve the conflict in newer context before continuing.':data?.nextAction??work.item?.nextAction??'Clarify the next action.',checkpointAt:latest?.at??null,historyComplete:work.context.complete,conflict,notices,
    newerContext:newer.map(r=>({id:r.id,at:r.at,kind:r.kind,data:r.data})).slice(0,20)};
  const budget=provider.settings.limits.resumeContextChars;
  const size=()=>JSON.stringify(packet).length;
  while(size()>budget && packet.newerContext.length)packet.newerContext.pop();
  for(const k of ['observations','completed','files','links'])while(size()>budget && packet[k].length)packet[k].pop();
  for(const k of ['state','hypothesis','goal'])if(size()>budget && typeof packet[k]==='string')packet[k]=packet[k].slice(0,256);
  if(size()>budget)throw new WorkError('WORK_LIMIT','Resume budget cannot preserve blockers, notices, references and an executable next action');
  return provider.safe ? provider.safe(packet) : packet;
};
