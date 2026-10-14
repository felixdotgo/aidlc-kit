import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import {workItem} from './work-fixture.js';
const r=await import(resolve('assets/aidlc/work/lib/redact.mjs'));
const records=await import(resolve('assets/aidlc/work/lib/records.mjs'));
test('obvious secrets are redacted in persisted local events; history and mutation hashes validate',()=>{
 const raw='password=hunter2 Authorization: Bearer abc123 postgres://user:pwd@host/db https://host?token=tok sk-1234567890 -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----';
 const safe=r.redactText(raw);
 for(const secret of ['hunter2','abc123','user:pwd','token=tok','sk-1234567890','BEGIN PRIVATE'])assert.equal(safe.includes(secret),false);
 const item=records.enrichIdentities(workItem(),[]);
 const event=records.makeEvent('CREATE',{...item,summary:raw},{key:records.hash('key'),digest:records.hash(item)});
 const rawJournal=JSON.stringify(event)+'\n';assert.equal(rawJournal.includes('hunter2'),false);
 assert.equal(records.parseJournal(rawJournal).item.status,'INBOX');
 assert.throws(()=>records.parseJournal(rawJournal.replace('INBOX','DOING')),{code:'WORK_CORRUPT'});
 assert.throws(()=>records.parseJournal(rawJournal.trimEnd()),{code:'WORK_CORRUPT'});
 assert.equal(records.hash({b:2,a:1}),records.hash({a:1,b:2}));
});
test('stable source and thread identities are namespaced and conceal external IDs',()=>{
 const source={source:'slack',externalId:'m1',threadId:'t1',body:'a'};
 assert.equal(records.sourceIdentity(source),records.sourceIdentity({...source,body:'changed'}));
 assert.notEqual(records.sourceIdentity(source),records.sourceIdentity({...source,source:'manual'}));
 assert.notEqual(records.threadIdentity(source),records.threadIdentity({...source,source:'manual'}));
});
