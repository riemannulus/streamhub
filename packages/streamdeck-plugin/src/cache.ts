import {mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {parseRuntimeMessage,type RuntimeToPluginMessage} from '../../presentation/protocol';
export type PresentationMessage=Extract<RuntimeToPluginMessage,{type:'presentation'}>;
export class PresentationCache{private current:string;private previous:string;constructor(readonly directory:string){mkdirSync(directory,{recursive:true,mode:0o700});this.current=join(directory,'current.json');this.previous=join(directory,'previous.json');}
  save(message:PresentationMessage){const valid=parseRuntimeMessage(message);if(valid.type!=='presentation')throw new Error('Expected presentation');const tmp=join(this.directory,`${randomUUID()}.tmp`);try{writeFileSync(tmp,JSON.stringify(valid),{flag:'wx',mode:0o600});try{renameSync(this.current,this.previous);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}renameSync(tmp,this.current);}finally{rmSync(tmp,{force:true});}}
  load():PresentationMessage|undefined{for(const path of [this.current,this.previous])try{const parsed=parseRuntimeMessage(JSON.parse(readFileSync(path,'utf8')));if(parsed.type==='presentation')return parsed;}catch{}return;}
  corruptCurrentForTest(){writeFileSync(this.current,'{',{mode:0o600});}
}
