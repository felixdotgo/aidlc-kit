export const workConfig = () => ({enabled:true,provider:'local'});
export const workItem = () => ({schemaVersion:1,title:'Investigate payment retry',summary:'Retry fails after timeout',expectedOutcome:'Find cause',nextAction:'Reproduce timeout',status:'INBOX',priority:null,due:null,project:null,aidlcTaskId:null,sources:[],dedupe:{externalIds:[],threadIds:[],references:[],keywords:['retry']}});
export const source = (id='m1') => ({source:'slack',externalId:id,threadId:'t1',author:'PM',timestamp:null,url:null,body:'Investigate retry timeout'});
export const localFixture = async () => {
 const {mkdtempSync,rmSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const {FileProvider}=await import(resolve('assets/aidlc/work/lib/file-provider.mjs'));
 const root=mkdtempSync(join(tmpdir(),'aidlc-work-local-'));const config=workConfig();
 const provider=new FileProvider(root,config);await provider.initialize();
 writeFileSync(join(root,'.agents/config.json'),JSON.stringify({personalWork:config}));
 return {root,provider,config,cleanup:()=>rmSync(root,{recursive:true,force:true})};
};
