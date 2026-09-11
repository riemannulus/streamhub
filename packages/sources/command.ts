import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {validateConfig,type Config} from '../host/src/config';
import type {ActionDefinition} from '../host/src/actions';

type Identity={source?:string;id?:string;label?:string};
function identity(options:Identity){
  const source=options.source??'build',id=options.id??'checks',label=options.label??'프로젝트 검사';
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)||!id||id.length>128||/[\u0000-\u001f\u007f]/.test(id)||!label||label.length>64||/[\u0000-\u001f\u007f]/.test(label))throw new Error('Invalid command source identity');
  return{source,id,label};
}
export type RegistrationOptions=Identity&{configFile:string;cwd:string;bun:string;script:string;argv?:string[]};
/** Explicit registration never replaces a conflicting user action or page. */
export function registerCommandSource(input:Config,options:RegistrationOptions):Config{
  const config=validateConfig(input),{source,id,label}=identity(options);
  for(const path of [options.configFile,options.cwd,options.bun,options.script])if(!isAbsolute(path))throw new Error('Registration paths must be absolute');
  const argv=options.argv??[options.bun,'run','check'];validateArgv(argv);
  const action:ActionDefinition={exec:[options.bun,options.script,'--source',source,'--id',id,'--label',label,'--',...argv],args:{},sources:[source],cwd:options.cwd,env:{STREAMHUB_CONFIG:options.configFile},timeoutMs:60000,maxOutputBytes:1048576};
  const existingAction=config.actions?.['run-checks'];
  if(existingAction&&!isDeepStrictEqual(existingAction,action))throw new Error('run-checks action already exists with different settings');
  return validateConfig({...config,sources:{...config.sources,[source]:config.sources[source]??{token:randomUUID()+randomUUID()}},actions:{...config.actions,'run-checks':action}});
}
function validateArgv(argv:string[]){if(!Array.isArray(argv)||!argv.length||argv.some(arg=>typeof arg!=='string'||arg.includes('\0'))||!argv[0])throw new Error('A command argv is required');}
export type RunCommandOptions=Identity&{argv:string[];cwd?:string;signal?:AbortSignal};
/** Publish before spawning; host failures cannot silently run an unobservable command. */
export async function runCommandSource(config:Config,options:RunCommandOptions):Promise<{exitCode:number;publicationError?:string}>{
  const {source,id,label}=identity(options);validateArgv(options.argv);
  if(!Object.hasOwn(config.sources,source))throw new Error('Command source is not registered');
  const publish=async(level:'info'|'warn'|'urgent',suffix:string,detail:string)=>{
    const response=await fetch(`http://127.0.0.1:${config.port}/v1/sources/${source}/signals`,{method:'POST',headers:{authorization:`Bearer ${config.sources[source].token}`,'content-type':'application/json'},body:JSON.stringify({deliveryId:randomUUID(),signal:{id,kind:'live',level,label:`${label} · ${suffix}`,detail}}),signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw new Error('Host rejected command status');
    await response.body?.cancel();
  };
  if(options.signal?.aborted)return{exitCode:options.signal.reason===143?143:130};
  try{await publish('warn','실행 중','로컬 명령을 실행하고 있습니다.');}catch{throw new Error('호스트에 실행 상태를 보낼 수 없어 명령을 시작하지 않았습니다. bun start와 소스 등록 상태를 확인하세요.');}
  let exitCode=1,cancelled=false;
  let child:ReturnType<typeof Bun.spawn>|undefined;
  let killTimer:ReturnType<typeof setTimeout>|undefined;
  const abort=()=>{cancelled=true;child?.kill('SIGTERM');if(child)killTimer=setTimeout(()=>child?.kill('SIGKILL'),500);};
  options.signal?.addEventListener('abort',abort,{once:true});
  try{
    if(options.signal?.aborted){cancelled=true;exitCode=options.signal.reason===143?143:130;}
    else{
      // Inherit the wrapper process group so the host action timeout also kills descendants.
      child=Bun.spawn(options.argv,{cwd:options.cwd??process.cwd(),stdin:'ignore',stdout:'inherit',stderr:'inherit'});
      if(options.signal?.aborted)abort();
      exitCode=await child.exited;
    }
  }catch{exitCode=1;}
  finally{clearTimeout(killTimer);options.signal?.removeEventListener('abort',abort);}
  if(cancelled)exitCode=options.signal?.reason===143?143:130;
  try{await publish(exitCode===0?'info':'urgent',cancelled?'취소':exitCode===0?'통과':'실패',cancelled?'로컬 명령 실행이 취소되었습니다.':`종료 코드: ${exitCode}`);return{exitCode};}
  catch{return{exitCode:exitCode||1,publicationError:'명령은 종료됐지만 최종 상태를 호스트에 전달하지 못했습니다.'};}
}
