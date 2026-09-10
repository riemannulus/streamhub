import type {AppCatalogItem,PathPickerResult} from '../../host/src/catalog';
import type {StudioDocument} from '../../studio/document';
import {StudioModel} from './model';

export type Geometry={x:number[];y:number[]};
export type RegisteredActionItem={name:string;args:string[]};
type Bootstrap={token:string;snapshot:{document:StudioDocument;version:string};draft?:StudioDocument;runtimeStatus:{connected?:boolean;message?:string};geometry:Geometry};

export class StudioState{
  readonly model:StudioModel;
  apps:AppCatalogItem[]=[];
  actions:RegisteredActionItem[]=[];
  runtimeStatus:Bootstrap['runtimeStatus'];
  private draftQueue:Promise<void>=Promise.resolve();
  private constructor(private readonly request:typeof fetch,private readonly token:string,private version:string,readonly geometry:Geometry,bootstrap:Bootstrap){this.model=new StudioModel(bootstrap.draft??bootstrap.snapshot.document);this.runtimeStatus=bootstrap.runtimeStatus;}
  static async connect(request:typeof fetch=fetch):Promise<StudioState>{
    const response=await request('/api/bootstrap');const bootstrap=await response.json() as Bootstrap;if(!response.ok)throw new Error('Studio를 불러오지 못했습니다.');
    const state=new StudioState(request,bootstrap.token,bootstrap.snapshot.version,bootstrap.geometry,bootstrap);
    const headers={'X-Streamhub-Editor':bootstrap.token};
    const [apps,actions]=await Promise.all([request('/api/catalog/apps',{headers}),request('/api/catalog/actions',{headers})]);
    if(apps.ok)state.apps=await apps.json() as AppCatalogItem[];if(actions.ok)state.actions=await actions.json() as RegisteredActionItem[];
    return state;
  }
  changed():void{this.draftQueue=this.draftQueue.then(()=>this.saveDraft()).catch(()=>{});}
  private async saveDraft():Promise<void>{const response=await this.request('/api/draft',{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':this.token},body:JSON.stringify({document:this.model.document})});if(!response.ok)throw new Error((await response.json() as {error:string}).error);}
  async apply():Promise<void>{
    await this.draftQueue;const response=await this.request('/api/apply',{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':this.token},body:JSON.stringify({document:this.model.document,expectedVersion:this.version})}),body=await response.json() as {error?:string;version?:string;runtimeStatus?:Bootstrap['runtimeStatus']};
    if(!response.ok)throw new Error(body.error??'장치에 적용하지 못했습니다.');this.version=body.version!;this.runtimeStatus=body.runtimeStatus??this.runtimeStatus;this.model.markApplied();
  }
  async upload(file:File):Promise<string>{const response=await this.request('/api/assets',{method:'POST',headers:{'X-Streamhub-Editor':this.token,'Content-Type':file.type||'application/octet-stream'},body:file}),body=await response.json() as {assetId?:string;error?:string};if(!response.ok)throw new Error(body.error??'이미지를 저장하지 못했습니다.');return body.assetId!;}
  async pick(kind:'file'|'folder'):Promise<PathPickerResult>{const response=await this.request('/api/picker/path',{method:'POST',headers:{'X-Streamhub-Editor':this.token,'Content-Type':'application/json'},body:JSON.stringify({kind})}),body=await response.json() as PathPickerResult&{error?:string};if(!response.ok)throw new Error(body.error??'경로를 선택하지 못했습니다.');return body;}
}
