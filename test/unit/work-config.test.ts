import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const { validatePersonalWork } = await import(resolve('assets/aidlc/work/lib/config.mjs'));
test('local configuration is opt-in and accepts no credentials, targets or arbitrary storage roots', () => {
 assert.deepEqual(validatePersonalWork(undefined),{enabled:false});
 assert.deepEqual(validatePersonalWork({enabled:false,provider:'unsupported'}),{enabled:false});
 const v=validatePersonalWork({enabled:true,provider:'local'});
 assert.equal(v.limits.searchItems,500);assert.equal(v.capture.autoReady,true);
 for(const extra of [{providerOptions:{}},{statusMapping:{}},{root:'/tmp/elsewhere'},{token:'secret'}])assert.throws(()=>validatePersonalWork({enabled:true,provider:'local',...extra}),{code:'WORK_CONFIG'});
 assert.throws(()=>validatePersonalWork({enabled:true,provider:'unsupported'}));
 assert.throws(()=>validatePersonalWork({enabled:true,provider:'local',limits:{contextRecords:0}}));
 const schema=JSON.parse(readFileSync('assets/aidlc/schemas/config.schema.json','utf8')).properties.personalWork;
 assert.equal(schema.properties.provider.const,'local');assert.deepEqual(schema.allOf[0].then.required,['provider']);
});
