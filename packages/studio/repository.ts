import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {VisualAssetStore} from './assets';
import {defaultStudioDocument,validateStudioDocument,type StudioDocument,type StudioValidationContext} from './document';

export type StudioSnapshot={document:StudioDocument;version:string};
export class StudioVersionConflictError extends Error{constructor(){super('Studio document version conflict');this.name='StudioVersionConflictError';}}
const serialize=(document:StudioDocument)=>JSON.stringify(document,null,2)+'\n';
const version=(contents:string)=>createHash('sha256').update(contents).digest('hex');
export class StudioRepository{
  readonly assets:VisualAssetStore;private readonly path:string;private readonly context:StudioValidationContext;
  constructor(directory:string,context:StudioValidationContext={}){mkdirSync(directory,{recursive:true,mode:0o700});this.path=join(directory,'studio.json');this.assets=new VisualAssetStore(join(directory,'assets'));this.context=context;}
  snapshot():StudioSnapshot{let contents:string;try{contents=readFileSync(this.path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const document=defaultStudioDocument();contents=serialize(document);this.publish(contents);}const document=validateStudioDocument(JSON.parse(contents),this.context);return{document,version:version(serialize(document))};}
  apply(input:unknown,expectedVersion:string):StudioSnapshot{const current=this.snapshot();if(current.version!==expectedVersion)throw new StudioVersionConflictError();const document=validateStudioDocument(input,this.context),contents=serialize(document);this.publish(contents);return{document,version:version(contents)};}
  async putAsset(bytes:Uint8Array):Promise<string>{return this.assets.put(bytes);}
  private publish(contents:string){const temporary=`${this.path}.${randomUUID()}.tmp`;try{writeFileSync(temporary,contents,{flag:'wx',mode:0o600});renameSync(temporary,this.path);}finally{rmSync(temporary,{force:true});}}
}
