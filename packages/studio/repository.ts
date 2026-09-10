import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {VisualAssetStore} from './assets';
import {defaultStudioDocument,validateStudioDocument,type StudioDocument,type StudioValidationContext} from './document';

export type StudioReset={fromVersion:2;backupPath:string};
export type StudioSnapshot={document:StudioDocument;version:string;reset?:StudioReset};
export class StudioVersionConflictError extends Error{constructor(){super('Studio document version conflict');this.name='StudioVersionConflictError';}}
const serialize=(document:StudioDocument)=>JSON.stringify(document,null,2)+'\n';
const version=(contents:string)=>createHash('sha256').update(contents).digest('hex');
const compactUtc=()=>new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');

export class StudioRepository{
  readonly assets:VisualAssetStore;
  private readonly path:string;
  private pendingReset?:StudioReset;
  constructor(directory:string,private readonly context:StudioValidationContext={}){mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'studio.json');this.assets=new VisualAssetStore(join(directory,'assets'));}
  snapshot():StudioSnapshot{
    let contents:string;
    try{contents=readFileSync(this.path,'utf8');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;contents=serialize(defaultStudioDocument());this.publish(contents);}
    const raw=JSON.parse(contents) as {version?:unknown};
    if(raw?.version===2){const backupPath=join(this.path.replace(/studio\.json$/,''),`studio.v2.${compactUtc()}.backup.json`);renameSync(this.path,backupPath);this.pendingReset={fromVersion:2,backupPath};contents=serialize(defaultStudioDocument());this.publish(contents);}
    const document=validateStudioDocument(JSON.parse(contents),this.context),reset=this.pendingReset;this.pendingReset=undefined;
    return{document,version:version(serialize(document)),...(reset?{reset}:{})};
  }
  apply(input:unknown,expectedVersion:string):StudioSnapshot{const current=this.snapshot();if(current.version!==expectedVersion)throw new StudioVersionConflictError();const document=validateStudioDocument(input,this.context),contents=serialize(document);this.publish(contents);return{document,version:version(contents)};}
  async putAsset(bytes:Uint8Array):Promise<string>{return this.assets.put(bytes);}
  private publish(contents:string){const temporary=`${this.path}.${randomUUID()}.tmp`;try{writeFileSync(temporary,contents,{flag:'wx',mode:0o600});renameSync(temporary,this.path);}finally{rmSync(temporary,{force:true});}}
}
