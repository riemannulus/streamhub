import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

export type ButtonStateKey={documentId:string;pageId:string;buttonId:string};
export interface ButtonStateStore{
  getToggle(key:ButtonStateKey):'off'|'on'|undefined;
  setToggle(key:ButtonStateKey,value:'off'|'on'):Promise<void>;
  prune(valid:Set<string>):Promise<void>;
}
const id=(value:string)=>{if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))throw new Error('Invalid button state ID');return value;};
export const buttonStateKey=(key:ButtonStateKey)=>`${id(key.documentId)}/${id(key.pageId)}/${id(key.buttonId)}`;
const validStoredKey=(value:string)=>{const parts=value.split('/');return parts.length===3&&parts.every(part=>{try{id(part);return true;}catch{return false;}});};

export class FileButtonStateStore implements ButtonStateStore{
  private readonly directory:string;private readonly path:string;private values=new Map<string,'off'|'on'>();private writing=Promise.resolve();
  constructor(stateDirectory:string){
    this.directory=stateDirectory;this.path=join(this.directory,'button-state.json');mkdirSync(this.directory,{recursive:true,mode:0o700});
    try{const raw=JSON.parse(readFileSync(this.path,'utf8')) as unknown;if(!raw||typeof raw!=='object'||Array.isArray(raw)||(raw as any).version!==1||!(raw as any).values||typeof (raw as any).values!=='object'||Array.isArray((raw as any).values))throw new Error('Invalid state');const entries=Object.entries((raw as any).values);if(entries.length>4096||entries.some(([key,value])=>!validStoredKey(key)||(value!=='off'&&value!=='on')))throw new Error('Invalid state');this.values=new Map(entries as [string,'off'|'on'][]);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;const quarantine=join(this.directory,`button-state.invalid.${Date.now()}.json`);try{renameSync(this.path,quarantine);}catch{}this.values.clear();}
  }
  getToggle(key:ButtonStateKey){return this.values.get(buttonStateKey(key));}
  async setToggle(key:ButtonStateKey,value:'off'|'on'):Promise<void>{
    if(value!=='off'&&value!=='on')throw new Error('Invalid toggle state');
    const encoded=buttonStateKey(key);if(!this.values.has(encoded)&&this.values.size>=4096)throw new Error('Button state limit exceeded');
    this.values.set(encoded,value);await this.enqueue();
  }
  prune(valid:Set<string>):Promise<void>{let changed=false;for(const key of this.values.keys())if(!valid.has(key)){this.values.delete(key);changed=true;}return changed?this.enqueue():this.writing;}
  private enqueue(){const contents=JSON.stringify({version:1,values:Object.fromEntries(this.values)},null,2)+'\n';this.writing=this.writing.then(()=>this.publish(contents));return this.writing;}
  private publish(contents:string){
    const temporary=`${this.path}.tmp`;let file:number|undefined,directory:number|undefined;try{file=openSync(temporary,'w',0o600);writeFileSync(file,contents);fsyncSync(file);closeSync(file);file=undefined;renameSync(temporary,this.path);directory=openSync(this.directory,'r');fsyncSync(directory);}finally{if(file!==undefined)closeSync(file);if(directory!==undefined)closeSync(directory);if(existsSync(temporary))rmSync(temporary,{force:true});}
  }
}

export class MemoryButtonStateStore implements ButtonStateStore{
  private values=new Map<string,'off'|'on'>();getToggle(key:ButtonStateKey){return this.values.get(buttonStateKey(key));}async setToggle(key:ButtonStateKey,value:'off'|'on'){this.values.set(buttonStateKey(key),value);}async prune(valid:Set<string>){for(const key of this.values.keys())if(!valid.has(key))this.values.delete(key);}
}
