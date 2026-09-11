import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {updateConfig,type Config} from '../host/src/config';

export type SetupResult={mode:'hid'|'plugin';guidance:string;backupPath?:string};
type SetupOptions={mode:'hid'|'plugin';packageRoot:string;applicationSupport:string;now?:()=>Date;update?:(mutate:(current:Config)=>Config)=>Config;pluginSource?:string};

const bundleName='com.streamhub.studio.sdPlugin';
const inside=(parent:string,path:string)=>{const value=relative(resolve(parent),resolve(path));return value!==''&&!value.startsWith(`..${sep}`)&&value!=='..';};
const manifest=(directory:string)=>{
  let value:unknown;try{value=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));}catch{throw new Error('Stream Deck plugin bundle is missing or invalid');}
  if(!value||typeof value!=='object'||Array.isArray(value)||(value as any).UUID!=='com.streamhub.studio'||typeof (value as any).Version!=='string'||(value as any).CodePath!=='bin/plugin.js')throw new Error('Stream Deck plugin bundle is invalid');
};
const files=(root:string,current=root):string[]=>{
  const result:string[]=[];
  for(const name of readdirSync(current).sort()){
    if(name==='logs')continue;
    const path=join(current,name),stat=lstatSync(path);if(stat.isSymbolicLink())throw new Error('Stream Deck plugin bundle contains a symbolic link');
    if(stat.isDirectory())result.push(...files(root,path));else if(stat.isFile())result.push(relative(root,path));else throw new Error('Stream Deck plugin bundle contains an unsupported file');
  }
  return result;
};
const digest=(root:string)=>{const hash=createHash('sha256');for(const file of files(root)){hash.update(file);hash.update('\0');hash.update(readFileSync(join(root,file)));hash.update('\0');}return hash.digest('hex');};
const stamp=(date:Date)=>date.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');

export function setupPluginFiles(directory:string){
  mkdirSync(directory,{recursive:true,mode:0o700});const tokenFile=join(directory,'token');let token:string;
  try{token=readFileSync(tokenFile,'utf8').trim();}catch{token=randomBytes(32).toString('hex');writeFileSync(tokenFile,token+'\n',{flag:'wx',mode:0o600});}
  if(token.length<32)throw new Error('Existing plugin token is invalid');
  const connection={url:'ws://127.0.0.1:31417',tokenFile};writeFileSync(join(directory,'connection.json'),JSON.stringify(connection,null,2)+'\n',{mode:0o600});return{directory,tokenFile,connection};
}

export async function setupDisplayMode(options:SetupOptions):Promise<SetupResult>{
  const update=options.update??updateConfig;
  if(options.mode==='hid'){
    update(config=>({...config,display:{...config.display,mode:'hid'}}));
    return{mode:'hid',guidance:'Stream Deck 앱을 완전히 종료한 뒤 streamhub start를 실행하세요.'};
  }
  const source=resolve(options.pluginSource??join(options.packageRoot,'share','streamdeck-plugin',bundleName));
  const pluginParent=resolve(options.applicationSupport,'com.elgato.StreamDeck','Plugins'),target=join(pluginParent,bundleName);
  if(!inside(options.packageRoot,source)&&options.pluginSource===undefined)throw new Error('Stream Deck plugin bundle escapes the package');
  if(!existsSync(source)||!lstatSync(source).isDirectory())throw new Error('Stream Deck plugin bundle is missing');
  manifest(source);files(source);
  mkdirSync(pluginParent,{recursive:true,mode:0o700});
  let backupPath:string|undefined,installed=false;
  if(existsSync(target)){
    if(lstatSync(target).isSymbolicLink())throw new Error('Stream Deck plugin target is a symbolic link');
    if(!lstatSync(target).isDirectory())throw new Error('Stream Deck plugin target is not a directory');
    manifest(target);
    if(digest(target)!==digest(source)){
      backupPath=`${target}.${stamp((options.now??(()=>new Date()))())}.backup`;
      if(existsSync(backupPath))throw new Error('Stream Deck plugin backup already exists');
      renameSync(target,backupPath);
    }else installed=true;
  }
  if(!installed){
    const staging=join(pluginParent,`.${bundleName}.${randomUUID()}.tmp`);
    try{cpSync(source,staging,{recursive:true,filter:path=>path.split(sep).at(-1)!=='logs'});manifest(staging);renameSync(staging,target);}
    catch(error){rmSync(staging,{recursive:true,force:true});if(backupPath&&!existsSync(target))renameSync(backupPath,target);throw error;}
  }
  try{
    const plugin=setupPluginFiles(join(options.applicationSupport,'Streamhub','plugin'));
    update(config=>({...config,display:{mode:'plugin',plugin:{port:31417,tokenFile:plugin.tokenFile}}}));
    return{mode:'plugin',guidance:'Stream Deck 앱을 다시 시작하고 Streamhub 프로필을 선택한 뒤 streamhub start를 실행하세요.',...(backupPath?{backupPath}:{})};
  }catch(error){
    if(backupPath&&existsSync(backupPath)){rmSync(target,{recursive:true,force:true});renameSync(backupPath,target);}
    throw error;
  }
}
