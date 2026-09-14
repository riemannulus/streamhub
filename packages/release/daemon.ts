import {closeSync,chmodSync,lstatSync,mkdirSync,openSync,readSync,renameSync,unlinkSync} from 'node:fs';
import {lstat,mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {isManagedLaunchAgentPaths,launchAgentPaths,parseLaunchctlPrint,renderLaunchAgent,runtimeLabel,validateOwnedLaunchAgent,type LaunchAgentInput,type LaunchAgentPaths} from './launch-agent';

export type CommandResult={code:number;stdout:string;stderr:string};
export type CommandRunner=(argv:readonly string[])=>Promise<CommandResult>;
export type DaemonStatus={enabled:boolean;loaded:boolean;running:boolean;pid?:number;lastExitStatus?:number};
export type DaemonOptions=LaunchAgentInput&{
  runner?:CommandRunner;
  now?:()=>number;
  sleep?:(milliseconds:number)=>Promise<void>;
  isPidRunning?:(pid:number)=>Promise<boolean>;
  bootoutTimeoutMs?:number;
};
export type RuntimeDaemon={
  enable():Promise<DaemonStatus>;
  disable():Promise<DaemonStatus>;
  restart():Promise<DaemonStatus>;
  status():Promise<DaemonStatus>;
  paths:LaunchAgentPaths;
};

const launchctl='/bin/launchctl';
const plutil='/usr/bin/plutil';
const maxLogBytes=64*1024;
const rolloverBytes=5*1024*1024;
const bootoutPollMs=50;
const defaultBootoutTimeoutMs=2_000;
const maxBootoutTimeoutMs=5_000;

class PublicBoundaryError extends Error{
  constructor(message:string,readonly decision=false){super(message);}
}

function publicError(action:string):PublicBoundaryError{
  return new PublicBoundaryError(`Unable to ${action} Streamhub runtime service`);
}

function publicLogError(action:string):PublicBoundaryError{
  return new PublicBoundaryError(`Unable to ${action} Streamhub runtime log`);
}

function refusal(message:string):PublicBoundaryError{
  return new PublicBoundaryError(message,true);
}

function isDecisionError(error:unknown):error is PublicBoundaryError{
  return error instanceof PublicBoundaryError&&error.decision;
}

function isMissing(error:unknown):boolean{
  return typeof error==='object'&&error!==null&&'code' in error&&(error as {code?:string}).code==='ENOENT';
}

function unescapeXml(value:string):string{
  return value.replace(/&(amp|lt|gt|quot|apos);/g,(_,entity:string)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[entity]!);
}

function valueAfterKey(xml:string,key:string):string|undefined{
  const expression=new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  const match=xml.match(expression);
  return match?.[1]===undefined?undefined:unescapeXml(match[1]);
}

function packageApplicationRoot(packageRoot:string):string|undefined{
  return packageRoot.match(/^(.*)\/app\/[^/]+$/)?.[1];
}

function legacyOwnedInput(xml:string,input:LaunchAgentInput):LaunchAgentInput|undefined{
  const argumentsMatch=xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/);
  const packageRoot=valueAfterKey(xml,'WorkingDirectory');
  if(!argumentsMatch||!packageRoot) return undefined;
  const candidate={...input,bunPath:unescapeXml(argumentsMatch[1]!),packageRoot:unescapeXml(packageRoot)};
  try{
    validateOwnedLaunchAgent(xml,candidate);
    if(packageApplicationRoot(candidate.packageRoot)!==packageApplicationRoot(input.packageRoot)) return undefined;
    return candidate;
  }catch{
    return undefined;
  }
}

function validateManagedDefinition(bytes:string,input:LaunchAgentInput):void{
  try{
    validateOwnedLaunchAgent(bytes,input);
    return;
  }catch{
    if(legacyOwnedInput(bytes,input)) return;
  }
  throw refusal('Refusing to modify an unowned LaunchAgent definition');
}

function assertRegular(path:string,kind:string):void{
  const info=lstatSync(path);
  if(info.isSymbolicLink()) throw refusal(`Refusing symbolic ${kind}`);
  if(!info.isFile()) throw refusal(`Refusing non-regular ${kind}`);
}

function inspectLog(path:string):ReturnType<typeof lstatSync>|undefined{
  try{
    assertRegular(path,'runtime log');
    return lstatSync(path);
  }catch(error){
    if(isMissing(error)) return undefined;
    throw error;
  }
}

function assertManagedLogPaths(paths:LaunchAgentPaths):void{
  if(!isManagedLaunchAgentPaths(paths)) throw refusal('Refusing unmanaged runtime log paths');
  const domain=paths.domain.match(/^gui\/([1-9]\d*)$/);
  const plistSuffix=`/Library/LaunchAgents/${runtimeLabel}.plist`;
  const isNormalizedAbsolute=(path:string):boolean=>path.startsWith('/')&&!path.includes('\0')&&path.split('/').every((segment,index)=>index===0||Boolean(segment)&&segment!=='.'&&segment!=='..');
  if(!domain||!Number.isSafeInteger(Number(domain[1]))||!paths.plistPath.endsWith(plistSuffix)){
    throw refusal('Refusing unmanaged runtime log paths');
  }
  const home=paths.plistPath.slice(0,-plistSuffix.length);
  const dataPath=`${home}/Library/Application Support/Streamhub/data`;
  const runtimeSuffix='/app/runtime.ts';
  const packageRoot=paths.runtimePath.endsWith(runtimeSuffix)?paths.runtimePath.slice(0,-runtimeSuffix.length):'';
  const applicationRoot=packageRoot.match(/^(.*\/Streamhub)\/app\/[^/]+$/)?.[1];
  if(!home||paths.label!==runtimeLabel||paths.service!==`${paths.domain}/${runtimeLabel}`||
    paths.configPath!==`${dataPath}/config.json`||paths.logPath!==`${dataPath}/logs/runtime.log`||
    paths.previousLogPath!==`${dataPath}/logs/runtime.log.1`||!applicationRoot||
    ![paths.plistPath,paths.configPath,paths.logPath,paths.previousLogPath,paths.runtimePath,packageRoot,applicationRoot].every(isNormalizedAbsolute)){
    throw refusal('Refusing unmanaged runtime log paths');
  }
}

function prepareRuntimeLogUnsafe(paths:LaunchAgentPaths):string{
  const existing=inspectLog(paths.logPath);
  if(!existing){
    mkdirSync(dirname(paths.logPath),{recursive:true,mode:0o700});
    const descriptor=openSync(paths.logPath,'wx',0o600);
    closeSync(descriptor);
  }
  chmodSync(paths.logPath,0o600);
  return paths.logPath;
}

export function prepareRuntimeLog(paths:LaunchAgentPaths):string{
  try{
    assertManagedLogPaths(paths);
    return prepareRuntimeLogUnsafe(paths);
  }catch(error){
    if(isDecisionError(error)) throw error;
    throw publicLogError('prepare');
  }
}

function rollRuntimeLog(paths:LaunchAgentPaths):void{
  const current=inspectLog(paths.logPath);
  if(!current){
    prepareRuntimeLogUnsafe(paths);
    return;
  }
  if(current.size<=rolloverBytes) return;
  const previous=inspectLog(paths.previousLogPath);
  if(previous) unlinkSync(paths.previousLogPath);
  renameSync(paths.logPath,paths.previousLogPath);
  prepareRuntimeLogUnsafe(paths);
}

export function readRuntimeLog(paths:LaunchAgentPaths,maxBytes=maxLogBytes):string{
  try{
    assertManagedLogPaths(paths);
    const info=inspectLog(paths.logPath);
    if(!info) return '';
    const requested=Number.isFinite(maxBytes)?Math.floor(maxBytes):maxLogBytes;
    const bytes=Math.max(0,Math.min(maxLogBytes,requested));
    if(bytes===0) return '';
    const size=Number(info.size);
    const length=Math.min(size,bytes);
    const buffer=Buffer.alloc(length);
    const descriptor=openSync(paths.logPath,'r');
    try{readSync(descriptor,buffer,0,length,size-length);}finally{closeSync(descriptor);}
    const text=buffer.toString('utf8');
    const endsWithNewline=text.endsWith('\n');
    const lines=text.split('\n');
    if(endsWithNewline) lines.pop();
    const recent=lines.slice(-200).join('\n');
    return endsWithNewline&&recent?`${recent}\n`:recent;
  }catch(error){
    if(isDecisionError(error)) throw error;
    throw publicLogError('read');
  }
}

async function boundedOutput(stream:ReadableStream<Uint8Array>|null):Promise<string>{
  if(!stream) return '';
  const reader=stream.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done) break;
      const available=Math.max(0,maxLogBytes-size);
      if(available>0) chunks.push(next.value.slice(0,available));
      size+=next.value.length;
    }
  }finally{reader.releaseLock();}
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function defaultRunner(argv:readonly string[]):Promise<CommandResult>{
  const process=Bun.spawn([...argv],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [code,stdout,stderr]=await Promise.all([process.exited,boundedOutput(process.stdout),boundedOutput(process.stderr)]);
  return {code,stdout,stderr};
}

async function defaultPidRunning(pid:number):Promise<boolean>{
  try{process.kill(pid,0);return true;}
  catch(error){
    if(typeof error==='object'&&error!==null&&'code' in error&&(error as {code?:string}).code==='ESRCH')return false;
    throw error;
  }
}

type Definition={exists:false}|{exists:true;bytes:string;identity:{device:number;inode:number}};

async function readDefinition(paths:LaunchAgentPaths,input:LaunchAgentInput):Promise<Definition>{
  try{
    const info=await lstat(paths.plistPath);
    if(info.isSymbolicLink()) throw refusal('Refusing symbolic LaunchAgent definition');
    if(!info.isFile()) throw refusal('Refusing non-regular LaunchAgent definition');
    const bytes=await readFile(paths.plistPath,'utf8');
    validateManagedDefinition(bytes,input);
    return {exists:true,bytes,identity:{device:info.dev,inode:info.ino}};
  }catch(error){
    if(isMissing(error)) return {exists:false};
    throw error;
  }
}

async function assertDefinitionUnchanged(paths:LaunchAgentPaths,input:LaunchAgentInput,expected:Definition):Promise<Definition>{
  const current=await readDefinition(paths,input);
  if(expected.exists!==current.exists||
    (expected.exists&&current.exists&&(expected.bytes!==current.bytes||expected.identity.device!==current.identity.device||expected.identity.inode!==current.identity.inode))){
    throw refusal('Refusing to modify a changed LaunchAgent definition');
  }
  return current;
}

async function removeDefinition(paths:LaunchAgentPaths,input:LaunchAgentInput,expected:Definition):Promise<void>{
  const current=await assertDefinitionUnchanged(paths,input,expected);
  if(current.exists) await unlink(paths.plistPath);
}

async function publishDefinition(paths:LaunchAgentPaths,input:LaunchAgentInput,bytes:string,runner:CommandRunner,expected:Definition,validate=true):Promise<Definition>{
  await mkdir(dirname(paths.plistPath),{recursive:true,mode:0o700});
  const temporary=`${paths.plistPath}.${crypto.randomUUID()}.tmp`;
  try{
    const file=await open(temporary,'wx',0o600);
    try{
      await file.writeFile(bytes);
      await file.chmod(0o600);
    }finally{await file.close();}
    if(validate){
      const validation=await runner([plutil,'-lint',temporary]);
      if(validation.code!==0) throw publicError('validate');
    }
    await assertDefinitionUnchanged(paths,input,expected);
    await rename(temporary,paths.plistPath);
    return await readDefinition(paths,input);
  }catch(error){
    try{await unlink(temporary);}catch(unlinkError){if(!isMissing(unlinkError)) throw unlinkError;}
    throw error;
  }
}

export function createRuntimeDaemon(options:DaemonOptions):RuntimeDaemon{
  const input:LaunchAgentInput={home:options.home,uid:options.uid,bunPath:options.bunPath,packageRoot:options.packageRoot};
  const paths=launchAgentPaths(input);
  const runner=options.runner??defaultRunner;
  const now=options.now??(()=>performance.now());
  const sleep=options.sleep??(milliseconds=>Bun.sleep(milliseconds));
  const isPidRunning=options.isPidRunning??defaultPidRunning;
  const bootoutTimeoutMs=Number.isSafeInteger(options.bootoutTimeoutMs)&&options.bootoutTimeoutMs!>0
    ?Math.min(options.bootoutTimeoutMs!,maxBootoutTimeoutMs)
    :defaultBootoutTimeoutMs;

  async function inspect(){
    const result=await runner([launchctl,'print',paths.service]);
    if(result.code===0) return parseLaunchctlPrint(result.stdout);
    if(/could not find service|service .* not found/i.test(`${result.stdout}\n${result.stderr}`)){
      return {loaded:false,running:false};
    }
    throw publicError('inspect');
  }

  async function status():Promise<DaemonStatus>{
    const definition=await readDefinition(paths,input);
    const current=await inspect();
    return {enabled:definition.exists,loaded:current.loaded,running:current.running,...(current.pid===undefined?{}:{pid:current.pid}),...(current.lastExitStatus===undefined?{}:{lastExitStatus:current.lastExitStatus})};
  }

  function assertObservableRuntimeExit(current:ReturnType<typeof parseLaunchctlPrint>):void{
    if(current.running&&current.pid===undefined) throw publicError('verify runtime exit');
  }

  async function bootoutAndWait(current:ReturnType<typeof parseLaunchctlPrint>):Promise<void>{
    assertObservableRuntimeExit(current);
    const bootout=await runner([launchctl,'bootout',paths.service]);
    if(bootout.code!==0) throw publicError('disable');
    const deadline=now()+bootoutTimeoutMs;
    while(true){
      const observed=await inspect();
      if(!observed.loaded&&(current.pid===undefined||!await isPidRunning(current.pid)))return;
      const remaining=deadline-now();
      if(remaining<=0) throw publicError('wait for disable');
      await sleep(Math.min(bootoutPollMs,remaining));
    }
  }

  async function restore(previous:Definition,wasLoaded:boolean,newlyLoaded:boolean,published:Definition|undefined):Promise<void>{
    if(newlyLoaded){
      await bootoutAndWait(await inspect());
    }
    if(published){
      if(previous.exists) await publishDefinition(paths,input,previous.bytes,runner,published,false);
      else await removeDefinition(paths,input,published);
    }else if(previous.exists){
      await assertDefinitionUnchanged(paths,input,previous);
    }
    if(wasLoaded&&previous.exists){
      const result=await runner([launchctl,'bootstrap',paths.domain,paths.plistPath]);
      if(result.code!==0) throw publicError('restore');
    }
  }

  async function safeLifecycle<T>(action:'enable'|'disable'|'restart'|'inspect',operation:()=>Promise<T>):Promise<T>{
    try{return await operation();}catch(error){
      if(isDecisionError(error)) throw error;
      throw publicError(action);
    }
  }

  return {
    paths,
    status:()=>safeLifecycle('inspect',status),
    enable:()=>safeLifecycle('enable',async():Promise<DaemonStatus>=>{
      const previous=await readDefinition(paths,input);
      const initial=await inspect();
      if(initial.loaded&&!previous.exists) throw refusal('Refusing to replace an unowned loaded LaunchAgent');
      const desired=renderLaunchAgent(input);
      const changed=!previous.exists||previous.bytes!==desired;
      if(initial.loaded&&!changed) return {enabled:true,loaded:true,running:initial.running,...(initial.pid===undefined?{}:{pid:initial.pid}),...(initial.lastExitStatus===undefined?{}:{lastExitStatus:initial.lastExitStatus})};
      if(initial.loaded) assertObservableRuntimeExit(initial);
      rollRuntimeLog(paths);
      if(initial.loaded){
        await bootoutAndWait(initial);
      }
      let newlyLoaded=false,published:Definition|undefined;
      try{
        if(changed) published=await publishDefinition(paths,input,desired,runner,previous);
        const bootstrap=await runner([launchctl,'bootstrap',paths.domain,paths.plistPath]);
        if(bootstrap.code!==0) throw publicError('enable');
        newlyLoaded=true;
        return await status();
      }catch(error){
        try{await restore(previous,initial.loaded,newlyLoaded,published);}catch{ /* Preserve the primary public failure. */ }
        throw error;
      }
    }),
    disable:()=>safeLifecycle('disable',async():Promise<DaemonStatus>=>{
      const previous=await readDefinition(paths,input);
      const current=await inspect();
      if(!previous.exists){
        if(current.loaded) throw refusal('Refusing to disable an unowned loaded LaunchAgent');
        return {enabled:false,loaded:false,running:false};
      }
      if(current.loaded){
        await bootoutAndWait(current);
      }
      await removeDefinition(paths,input,previous);
      return {enabled:false,loaded:false,running:false};
    }),
    restart:()=>safeLifecycle('restart',async():Promise<DaemonStatus>=>{
      const previous=await readDefinition(paths,input);
      const current=await inspect();
      if(!previous.exists||!current.loaded) throw refusal('Streamhub runtime is not enabled');
      rollRuntimeLog(paths);
      const kickstart=await runner([launchctl,'kickstart','-k',paths.service]);
      if(kickstart.code!==0) throw publicError('restart');
      return status();
    }),
  };
}
