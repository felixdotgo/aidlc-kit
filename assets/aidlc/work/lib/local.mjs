import { readFileSync } from 'node:fs';
import { loadState, loadTask } from '../../scripts/lib/store.mjs';
import { createProvider } from './provider.mjs';
import { intake, checkpoint, restore } from './operations.mjs';
import { WorkError, validateRef, text } from './contracts.mjs';
import { validatePersonalWork } from './config.mjs';
import { projectRoot, safePath, atomicWrite, exists, readText } from './filesystem.mjs';
export const executeWork = async (root, operation, input = {}, options = {}) => {
  root=projectRoot(root);
  if(!input || typeof input!=='object' || Array.isArray(input))throw new WorkError('INVALID_INPUT','Work input must be an object');
  const configPath=safePath(root,'.agents/config.json');
  const original=exists(configPath)?readText(root,'.agents/config.json',1024*1024):null;
  const config=original===null?{}:JSON.parse(original);
  if(!config || typeof config!=='object' || Array.isArray(config))throw new WorkError('WORK_CONFIG','Project configuration must be an object');
  if(operation==='init'){
    if(Object.keys(input).length)throw new WorkError('INVALID_INPUT','Local initialization takes no credentials or target options');
    const personalWork=validatePersonalWork({enabled:true,provider:'local'});
    const provider=await createProvider(personalWork,{...options,root});
    const result=await provider.initialize();
    safePath(root,'.agents/config.json');
    const current=exists(configPath)?readText(root,'.agents/config.json',1024*1024):null;
    if(current!==original)throw new WorkError('WORK_CONFLICT','Project configuration changed during initialization; retry deliberately');
    atomicWrite(root,'.agents/config.json',JSON.stringify({...config,personalWork},null,2)+'\n',1024*1024);
    return {...result,configured:true,nextAction:'Run work.mjs preflight, then intake messages or create work'};
  }
  const provider=options.provider ?? await createProvider(config.personalWork,{...options,root,readLifecycleTask:async(id)=>loadTask(root,id,loadState(root))});
  const key={idempotencyKey:input.idempotencyKey};
  switch(operation){
    case 'preflight':return provider.preflight();
    case 'repair':return provider.repair(input.ref);
    case 'search':return provider.search_work_items(input);
    case 'get':return provider.get_work_item(input.ref);
    case 'create':return provider.create_work_item(input.item,key);
    case 'update':return provider.update_work_item(input.ref,input.patch,key);
    case 'comment':return provider.append_context(input.ref,input.context,key);
    case 'move':return provider.move_work_item(input.ref,input.status,{...key,intent:input.intent,waitingReason:input.waitingReason,automatic:input.automatic});
    case 'intake':return intake(provider,input.messages,key);
    case 'checkpoint':return checkpoint(provider,input.ref,input.checkpoint,key);
    case 'restore':return restore(provider,input.ref);
    case 'link':return linkWork(root,provider,input);
    default:throw new WorkError('INVALID_INPUT','Unknown personal-work operation');
  }
};
export const linkWork = async(root,provider,{ref,taskId,idempotencyKey,intent})=>{
  if(intent!=='implement')throw new WorkError('WORK_INTENT','Linking requires explicit implementation selection');
  text(taskId,'task ID',128);
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId))throw new WorkError('INVALID_INPUT','Invalid task ID');
  const task=loadTask(root,taskId,loadState(root));
  if(!task || ['done','closed','superseded'].includes(task.status))throw new WorkError('WORK_LIFECYCLE','Select or create an active AI-DLC task through normal lifecycle routing before linking');
  const path=task.artifacts.intent;
  if(!path || !path.startsWith(`.agents/data/tasks/${taskId}/`))throw new WorkError('WORK_LIFECYCLE','Task requires an intent artifact before linking');
  const file=safePath(root,path);
  if(!exists(file))throw new WorkError('WORK_LIFECYCLE','Write task intent through normal clarify routing before linking');
  const work=await provider.get_work_item(validateRef(ref));
  if(work.item?.aidlcTaskId && work.item.aidlcTaskId!==taskId)throw new WorkError('WORK_CONFLICT','Work item already links to another task');
  const block=`\n\n## Personal work reference\n\nProvider: ${work.ref.provider}\nID: ${work.ref.id}\nURL: ${work.ref.url}\n`;
  const original=readFileSync(file,'utf8');
  if(original.includes('## Personal work reference') && !original.includes(block.trim()))throw new WorkError('WORK_CONFLICT','Task intent already contains a different work reference');
  await provider.update_work_item(work.ref,{aidlcTaskId:taskId},{idempotencyKey});
  if(!original.includes(block.trim())){
    if(readFileSync(safePath(root,path),'utf8')!==original)throw new WorkError('WORK_CONFLICT','Task intent changed during linking; reconcile the work reference before retrying');
    atomicWrite(root,path,original+block,1024*1024);
  }
  return {ref:work.ref,taskId,artifact:path,lifecycleAction:'Run state.mjs task next for the linked task; all human gates remain required'};
};
