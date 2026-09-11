import {existsSync,mkdtempSync,readdirSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {runBoundedProcess} from '../../actions/system';

export type AppCatalogItem={id:string;name:string;bundleId:string;path:string;iconPng?:string};
export type PathPickerResult={path:string}|{cancelled:true};
export type AppCatalogReader=()=>Promise<unknown>;
export type AppIconProvider={read(app:AppCatalogItem):Promise<Uint8Array>};

const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid app catalog item');return value as Record<string,unknown>;};
const safeText=(value:unknown,max:number)=>{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Invalid app catalog string');return value;};

export function normalizeAppCatalog(raw:unknown):AppCatalogItem[]{
  if(!Array.isArray(raw))throw new Error('Invalid app catalog');
  if(raw.length>2000)throw new Error('App catalog exceeds 2,000 items');
  const ids=new Set<string>(),bundleIds=new Set<string>(),result:AppCatalogItem[]=[];
  for(const item of raw){
    const value=object(item);if(Object.keys(value).some(key=>!['id','name','bundleId','path','iconPng'].includes(key)))throw new Error('Unknown app catalog field');
    const name=safeText(value.name,256),bundleId=safeText(value.bundleId,255),path=safeText(value.path,4096);
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundleId))throw new Error('Invalid app bundle ID');
    if(!path.startsWith('/'))throw new Error('App path must be absolute');
    if(bundleIds.has(bundleId))throw new Error(`Duplicate app bundle ID: ${bundleId}`);bundleIds.add(bundleId);
    const id=value.id===undefined?`bundle:${bundleId}`:safeText(value.id,512);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id))throw new Error('Invalid app catalog ID');if(ids.has(id))throw new Error(`Duplicate app catalog ID: ${id}`);ids.add(id);
    let iconPng:string|undefined;
    if(value.iconPng!==undefined){iconPng=safeText(value.iconPng,700000);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(iconPng)||iconPng.length%4!==0||Buffer.from(iconPng,'base64').byteLength>512*1024)throw new Error('Invalid app icon');}
    result.push({id,name,bundleId,path,...(iconPng===undefined?{}:{iconPng})});
  }
  return result.sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'})||a.bundleId.localeCompare(b.bundleId));
}

type MacAppIconOptions={platform?:string;convert?:(path:string)=>Promise<Uint8Array>};
const plistString=(contents:string,key:string)=>{const match=new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(contents);return match?decodeXml(match[1]!.trim()):undefined;};
async function convertMacIcon(path:string):Promise<Uint8Array>{
  const directory=mkdtempSync(join(tmpdir(),'streamhub-app-icon-')),output=join(directory,'icon.png');
  try{await runBoundedProcess({argv:['/usr/bin/sips','-s','format','png',path,'--out',output],timeoutMs:10000,maxOutputBytes:16384});return new Uint8Array(readFileSync(output));}
  finally{rmSync(directory,{recursive:true,force:true});}
}
export class MacAppIconProvider implements AppIconProvider{
  private readonly platform:string;private readonly convert:(path:string)=>Promise<Uint8Array>;
  constructor(options:MacAppIconOptions={}){this.platform=options.platform??process.platform;this.convert=options.convert??convertMacIcon;}
  async read(app:AppCatalogItem):Promise<Uint8Array>{
    if(this.platform!=='darwin')throw new Error('App icons are not supported on this platform');
    const resources=realpathSync(join(app.path,'Contents','Resources')),plist=readFileSync(join(app.path,'Contents','Info.plist'),'utf8'),raw=plistString(plist,'CFBundleIconFile');
    if(!raw||basename(raw)!==raw)throw new Error('App icon is not available');
    const filename=raw.toLowerCase().endsWith('.icns')?raw:`${raw}.icns`,path=realpathSync(join(resources,filename));
    if(path!==resources&&!path.startsWith(`${resources}${sep}`))throw new Error('App icon path escapes its bundle');
    return this.convert(path);
  }
}

const decodeXml=(value:string)=>value.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
function applicationPaths(root:string):string[]{
  if(!existsSync(root))return[];
  const paths:string[]=[];
  const visit=(directory:string,depth:number)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory()&&entry.name.endsWith('.app'))paths.push(path);else if(entry.isDirectory()&&depth<2)visit(path,depth+1);}};
  visit(root,0);return paths;
}
export async function readMacAppCatalog():Promise<AppCatalogItem[]>{
  if(process.platform!=='darwin')return[];
  const roots=['/Applications','/System/Applications',resolve(process.env.USERPROFILE??process.env.HOME??'/nonexistent','Applications')],seen=new Set<string>(),items:AppCatalogItem[]=[];
  for(const path of roots.flatMap(applicationPaths)){
    let plist:string;try{plist=readFileSync(join(path,'Contents/Info.plist'),'utf8');}catch{continue;}
    const match=/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);if(!match)continue;
    const bundleId=decodeXml(match[1]!);if(seen.has(bundleId))continue;seen.add(bundleId);
    items.push({id:`bundle:${bundleId}`,name:basename(path,'.app'),bundleId,path});if(items.length===2000)break;
  }
  return normalizeAppCatalog(items);
}

export class AppCatalog{
  private cached?:{expires:number;value:Promise<AppCatalogItem[]>};
  constructor(private readonly reader:AppCatalogReader=readMacAppCatalog,private readonly now:()=>number=Date.now){}
  apps():Promise<AppCatalogItem[]>{
    const now=this.now();if(this.cached&&now<this.cached.expires)return this.cached.value.then(value=>structuredClone(value));
    const value=this.reader().then(normalizeAppCatalog);this.cached={expires:now+30000,value};
    return value.then(result=>structuredClone(result)).catch(error=>{if(this.cached?.value===value)this.cached=undefined;throw error;});
  }
}

export function normalizePickerResult(raw:unknown):PathPickerResult{
  const value=object(raw),keys=Object.keys(value);if(keys.length!==1)throw new Error('Invalid picker result');
  if(value.cancelled===true&&keys[0]==='cancelled')return{cancelled:true};
  const path=safeText(value.path,4096);if(keys[0]!=='path'||!path.startsWith('/'))throw new Error('Picker path must be absolute');return{path};
}

export async function pickNativePath(kind:'file'|'folder',signal?:AbortSignal):Promise<PathPickerResult>{
  const script=kind==='file'?'POSIX path of (choose file)':'POSIX path of (choose folder)';
  try{const result=await runBoundedProcess({argv:['/usr/bin/osascript','-e',script],timeoutMs:60000,maxOutputBytes:8192},signal);return normalizePickerResult({path:result.stdout.trim()});}
  catch(error){if(error instanceof Error&&error.message.includes('(-128)'))return{cancelled:true};throw error;}
}
