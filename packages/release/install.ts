import {randomUUID} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {validateReleaseManifest} from './manifest';
import {packageVersion} from './version';

const markerName='.streamhub-preview-install.json';
const payloadEntries=['README.md','DEVELOPMENT.md','manifest.json','SHA256SUMS','install.sh','uninstall.sh','bin','app','share'] as const;
type InstallOptions={packageRoot:string;applicationRoot:string;binDirectory:string};
type InstallResult={installRoot:string;commandPath:string;dataRoot:string};
type InstallMarker={name:'streamhub-preview';version:string;gitCommit:string};
export type InstallerArguments={operation:'install'|'uninstall';prefix?:string};

const stat=(path:string)=>{try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
const canonical=(path:string)=>{try{return realpathSync(path);}catch{return resolve(path);}};
const samePath=(left:string,right:string)=>canonical(left)===canonical(right);
const readManifest=(packageRoot:string)=>validateReleaseManifest(JSON.parse(readFileSync(join(packageRoot,'manifest.json'),'utf8')));
const readMarker=(installRoot:string):InstallMarker|undefined=>{try{const value=JSON.parse(readFileSync(join(installRoot,markerName),'utf8')) as Partial<InstallMarker>;if(value.name==='streamhub-preview'&&typeof value.version==='string'&&typeof value.gitCommit==='string')return value as InstallMarker;}catch{}return undefined;};

export function parseInstallerArguments(argv:string[]):InstallerArguments{
  const usage=()=>new Error('Usage: install.sh [--prefix /absolute/path] or uninstall.sh [--prefix /absolute/path]');
  const operation=argv[0];
  if(operation!=='install'&&operation!=='uninstall')throw usage();
  if(argv.length===1)return{operation};
  if(argv.length!==3||argv[1]!=='--prefix'||!isAbsolute(argv[2]!))throw usage();
  return{operation,prefix:resolve(argv[2]!)};
}

function assertLocations(options:InstallOptions,version:string){
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

export async function installPreview(options:InstallOptions):Promise<InstallResult>{
  const packageRoot=realpathSync(options.packageRoot),manifest=readManifest(packageRoot),locations=assertLocations(options,manifest.version),target=join(locations.installRoot,'bin','streamhub');
  if(samePath(packageRoot,locations.installRoot))throw new Error('Package source cannot be the install destination');
  const existing=assertOwnedDirectory(locations.installRoot,manifest.version);
  assertCommandAvailable(locations.commandPath,target);
  const result={installRoot:locations.installRoot,commandPath:locations.commandPath,dataRoot:locations.dataRoot};
  if(existing?.gitCommit===manifest.gitCommit){
    mkdirSync(locations.binDirectory,{recursive:true});
    if(!stat(locations.commandPath))symlinkSync(target,locations.commandPath);
    return result;
  }
  for(const entry of payloadEntries)if(!existsSync(join(packageRoot,entry)))throw new Error(`Incomplete preview package: missing ${entry}`);
  mkdirSync(join(locations.applicationRoot,'app'),{recursive:true});
  const staging=join(locations.applicationRoot,'app',`.${manifest.version}.${randomUUID()}.tmp`),backup=join(locations.applicationRoot,'app',`.${manifest.version}.${randomUUID()}.backup`);
  let published=false;
  try{
    mkdirSync(staging);
    for(const entry of payloadEntries)cpSync(join(packageRoot,entry),join(staging,entry),{recursive:true,preserveTimestamps:true});
    writeFileSync(join(staging,markerName),JSON.stringify({name:'streamhub-preview',version:manifest.version,gitCommit:manifest.gitCommit},null,2)+'\n',{mode:0o600});
    if(existing)renameSync(locations.installRoot,backup);
    renameSync(staging,locations.installRoot);
    published=true;
    mkdirSync(locations.binDirectory,{recursive:true});
    if(stat(locations.commandPath))unlinkSync(locations.commandPath);
    symlinkSync(target,locations.commandPath);
    if(existing)rmSync(backup,{recursive:true});
    return result;
  }catch(error){
    if(stat(staging))rmSync(staging,{recursive:true});
    if(published&&stat(locations.installRoot))rmSync(locations.installRoot,{recursive:true});
    if(stat(backup))renameSync(backup,locations.installRoot);
    throw error;
  }
}

export async function uninstallPreview(options:InstallOptions):Promise<{removed:boolean;dataRoot:string}>{
  const packageRoot=resolve(options.packageRoot),locations=assertLocations(options,packageVersion);
  if(!samePath(packageRoot,locations.installRoot))throw new Error('Refusing to uninstall outside the exact install root');
  const installed=stat(locations.installRoot);
  if(!installed)return{removed:false,dataRoot:locations.dataRoot};
  assertOwnedDirectory(locations.installRoot,packageVersion);
  readManifest(locations.installRoot);
  assertCommandAvailable(locations.commandPath,join(locations.installRoot,'bin','streamhub'));
  if(stat(locations.commandPath))unlinkSync(locations.commandPath);
  rmSync(locations.installRoot,{recursive:true});
  return{removed:true,dataRoot:locations.dataRoot};
}
