import {randomUUID} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {validateReleaseManifest} from './manifest';
import {packageVersion} from './version';

const markerName='.streamhub-preview-install.json';
const payloadEntries=['README.md','DEVELOPMENT.md','manifest.json','SHA256SUMS','install.sh','uninstall.sh','bin','app','share'] as const;
export type InstallResult={installRoot:string;commandPath:string;dataRoot:string};
export type InstallServiceHooks<State>={
  inspect?(context:{currentRoot?:string;targetRoot:string}):Promise<void>;
  prepare(context:{currentRoot?:string;targetRoot:string}):Promise<State>;
  activate(state:State,result:InstallResult):Promise<void>;
  rollback(state:State,context:{restoredRoot?:string}):Promise<void>;
};
export type InstallOptions<State=never>={packageRoot:string;applicationRoot:string;binDirectory:string;service?:InstallServiceHooks<State>};
export type UninstallOptions={packageRoot:string;applicationRoot:string;binDirectory:string;beforeRemove?:()=>Promise<void>};
type InstallLocations={packageRoot:string;applicationRoot:string;binDirectory:string};
type InstallMarker={name:'streamhub-preview';version:string;gitCommit:string};
export type InstallerArguments={operation:'install'|'uninstall';prefix?:string};
type InstallerPathInput={arguments:InstallerArguments;packageRoot:string;home:string;commandPath?:string;installedPackage:boolean};

const stat=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
const samePath=(left:string,right:string)=>canonical(left)===canonical(right);
const readManifest=(packageRoot:string)=>validateReleaseManifest(JSON.parse(readFileSync(join(packageRoot,'manifest.json'),'utf8')));
const markerFromValue=(value:unknown):InstallMarker|undefined=>{
  if(typeof value!=='object'||value===null)return undefined;
  const marker=value as Partial<InstallMarker>;
  return marker.name==='streamhub-preview'&&typeof marker.version==='string'&&typeof marker.gitCommit==='string'?marker as InstallMarker:undefined;
};
const readMarker=(installRoot:string):InstallMarker|undefined=>{try{return markerFromValue(JSON.parse(readFileSync(join(installRoot,markerName),'utf8')));}catch{return undefined;}};
const inspectMarker=(installRoot:string):InstallMarker|undefined=>markerFromValue(JSON.parse(readFileSync(join(installRoot,markerName),'utf8')));

export function parseInstallerArguments(argv:string[]):InstallerArguments{
  const usage=()=>new Error('Usage: install.sh [--prefix /absolute/path] or uninstall.sh [--prefix /absolute/path]');
  const operation=argv[0];
  if(operation!=='install'&&operation!=='uninstall')throw usage();
  if(argv.length===1)return{operation};
  if(argv.length!==3||argv[1]!=='--prefix'||!isAbsolute(argv[2]!))throw usage();
  return{operation,prefix:resolve(argv[2]!)};
}

export function resolveInstallerPaths(input:InstallerPathInput):{applicationRoot:string;binDirectory:string}{
  if(input.arguments.prefix)return{applicationRoot:join(input.arguments.prefix,'Application Support','Streamhub'),binDirectory:join(input.arguments.prefix,'bin')};
  if(input.arguments.operation==='uninstall'&&input.installedPackage)return{applicationRoot:dirname(dirname(resolve(input.packageRoot))),binDirectory:dirname(resolve(input.commandPath??join(input.home,'.local','bin','streamhub')))};
  return{applicationRoot:join(input.home,'Library','Application Support','Streamhub'),binDirectory:join(input.home,'.local','bin')};
}

function assertLocations(options:InstallLocations,version:string){
  const applicationRoot=resolve(options.applicationRoot),binDirectory=resolve(options.binDirectory);
  if(!isAbsolute(options.applicationRoot)||applicationRoot===sep||basename(applicationRoot)!=='Streamhub'||dirname(applicationRoot)===sep)throw new Error('Refusing unsafe install root');
  if(!isAbsolute(options.binDirectory)||binDirectory===sep)throw new Error('Refusing unsafe command directory');
  const installRoot=join(applicationRoot,'app',version),commandPath=join(binDirectory,'streamhub'),dataRoot=join(applicationRoot,'data');
  return{applicationRoot,binDirectory,installRoot,commandPath,dataRoot};
}

function assertOwnedDirectory(installRoot:string,version:string){
  const destination=stat(installRoot);
  if(!destination)return undefined;
  if(destination.isSymbolicLink())throw new Error('Refusing symbolic link install destination');
  if(!destination.isDirectory())throw new Error('Refusing install destination that is not owned');
  const marker=readMarker(installRoot);
  if(!marker||marker.version!==version)throw new Error('Refusing to replace a directory that is not owned by Streamhub Preview');
  return marker;
}

function assertCommandAvailable(commandPath:string,target:string){
  const command=stat(commandPath);
  if(!command)return;
  if(!command.isSymbolicLink())throw new Error('Refusing to replace a foreign command');
  let actual:string;
  try{actual=realpathSync(commandPath);}catch{throw new Error('Refusing to replace a broken command link');}
  if(!samePath(actual,target))throw new Error('Refusing to replace a foreign command');
}

function isNewPayload(installRoot:string,manifest:InstallMarker):boolean{
  const marker=inspectMarker(installRoot);
  return marker?.version===manifest.version&&marker.gitCommit===manifest.gitCommit;
}

function restoreCommand(commandPath:string,target:string,wasPresent:boolean){
  if(stat(commandPath))unlinkSync(commandPath);
  if(wasPresent)symlinkSync(target,commandPath);
}

type RecoveryFailure={step:string;error:unknown};

function recoveryDetail(error:unknown):string{
  if(typeof error==='object'&&error!==null&&'code' in error&&typeof (error as {code?:unknown}).code==='string'){
    const code=(error as {code:string}).code;
    if(/^[A-Z][A-Z0-9_]{0,31}$/.test(code))return code;
  }
  return error instanceof Error&&error.name==='Error'?'Error':'unknown error';
}

function withRollbackContext(error:unknown,failures:RecoveryFailure[]):Error{
  const primary=error instanceof Error?error:new Error('Preview install failed',{cause:error});
  const detail=failures.map(failure=>`${failure.step}: ${recoveryDetail(failure.error)}`).join('; ').slice(0,200);
  primary.message=`${primary.message} (recovery incomplete: ${detail||'unknown error'})`;
  return primary;
}

export async function installPreview<State=never>(options:InstallOptions<State>):Promise<InstallResult>{
  const packageRoot=realpathSync(options.packageRoot),manifest=readManifest(packageRoot),locations=assertLocations(options,manifest.version),target=join(locations.installRoot,'bin','streamhub');
  if(samePath(packageRoot,locations.installRoot))throw new Error('Package source cannot be the install destination');
  const existing=assertOwnedDirectory(locations.installRoot,manifest.version);
  assertCommandAvailable(locations.commandPath,target);
  await options.service?.inspect?.({currentRoot:existing?locations.installRoot:undefined,targetRoot:locations.installRoot});
  const result={installRoot:locations.installRoot,commandPath:locations.commandPath,dataRoot:locations.dataRoot};
  if(existing?.gitCommit===manifest.gitCommit){
    mkdirSync(locations.binDirectory,{recursive:true});
    if(!stat(locations.commandPath))symlinkSync(target,locations.commandPath);
    return result;
  }
  for(const entry of payloadEntries)if(!existsSync(join(packageRoot,entry)))throw new Error(`Incomplete preview package: missing ${entry}`);
  const staging=join(locations.applicationRoot,'app',`.${manifest.version}.${randomUUID()}.tmp`),backup=join(locations.applicationRoot,'app',`.${manifest.version}.${randomUUID()}.backup`);
  const commandWasPresent=Boolean(stat(locations.commandPath));
  let published=false,commandTouched=false,servicePrepared=false;
  let serviceState:State|undefined;
  try{
    if(existing&&options.service){
      serviceState=await options.service.prepare({currentRoot:locations.installRoot,targetRoot:locations.installRoot});
      servicePrepared=true;
    }
    mkdirSync(join(locations.applicationRoot,'app'),{recursive:true});
    mkdirSync(staging);
    for(const entry of payloadEntries)cpSync(join(packageRoot,entry),join(staging,entry),{recursive:true,preserveTimestamps:true});
    writeFileSync(join(staging,markerName),JSON.stringify({name:'streamhub-preview',version:manifest.version,gitCommit:manifest.gitCommit},null,2)+'\n',{mode:0o600});
    if(existing)renameSync(locations.installRoot,backup);
    renameSync(staging,locations.installRoot);
    published=true;
    if(servicePrepared)await options.service!.activate(serviceState as State,result);
    mkdirSync(locations.binDirectory,{recursive:true});
    commandTouched=true;
    if(stat(locations.commandPath))unlinkSync(locations.commandPath);
    symlinkSync(target,locations.commandPath);
    if(existing)rmSync(backup,{recursive:true});
    return result;
  }catch(error){
    const failures:RecoveryFailure[]=[];
    const recover=(step:string,operation:()=>void)=>{try{operation();}catch(recoveryError){failures.push({step,error:recoveryError});}};
    let newPayload=false,restoredRoot:string|undefined;
    recover('staging cleanup',()=>{if(stat(staging))rmSync(staging,{recursive:true});});
    recover('new payload inspection',()=>{newPayload=published&&isNewPayload(locations.installRoot,{name:'streamhub-preview',version:manifest.version,gitCommit:manifest.gitCommit});});
    recover('new payload removal',()=>{if(newPayload)rmSync(locations.installRoot,{recursive:true});});
    recover('payload restoration',()=>{if(stat(backup))renameSync(backup,locations.installRoot);});
    recover('command restoration',()=>{if(commandTouched)restoreCommand(locations.commandPath,target,commandWasPresent);});
    recover('restored payload inspection',()=>{if(existing&&isNewPayload(locations.installRoot,existing))restoredRoot=locations.installRoot;});
    if(servicePrepared){
      try{await options.service!.rollback(serviceState as State,{restoredRoot});}
      catch(rollbackError){failures.push({step:'service rollback',error:rollbackError});}
    }
    if(failures.length)throw withRollbackContext(error,failures);
    throw error;
  }
}

export async function uninstallPreview(options:UninstallOptions):Promise<{removed:boolean;dataRoot:string}>{
  const packageRoot=resolve(options.packageRoot),locations=assertLocations(options,packageVersion);
  if(!samePath(packageRoot,locations.installRoot))throw new Error('Refusing to uninstall outside the exact install root');
  const installed=stat(locations.installRoot);
  if(!installed)return{removed:false,dataRoot:locations.dataRoot};
  assertOwnedDirectory(locations.installRoot,packageVersion);
  readManifest(locations.installRoot);
  assertCommandAvailable(locations.commandPath,join(locations.installRoot,'bin','streamhub'));
  await options.beforeRemove?.();
  if(stat(locations.commandPath))unlinkSync(locations.commandPath);
  rmSync(locations.installRoot,{recursive:true});
  return{removed:true,dataRoot:locations.dataRoot};
}
