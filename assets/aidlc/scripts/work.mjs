import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { executeWork } from '../work/lib/local.mjs';
import { WorkError } from '../work/lib/contracts.mjs';
import { parseArguments, rootOption, validateArguments } from './lib/runtime.mjs';
export { executeWork };
if(resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)){
  try{
    const args=parseArguments(process.argv.slice(2),{valueOptions:['--root']});
    validateArguments(args,{minPositionals:1,maxPositionals:1,usage:'Usage: work.mjs <operation> [--root <project>] with JSON input on stdin'});
    let body='';for await(const chunk of process.stdin){body+=chunk;if(body.length>1000000)throw Error('Input exceeds personal-work budget');}
    const result=await executeWork(rootOption(args),args.positionals[0],body.trim()?JSON.parse(body):{});
    console.log(JSON.stringify({ok:true,result}));
  }catch(error){console.error(JSON.stringify({ok:false,error:{code:error instanceof WorkError?error.code:'WORK_ERROR',message:error instanceof WorkError?error.message:'Personal-work input/configuration could not be processed'}}));process.exitCode=1;}
}
