import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {runBoundedProcess,type ProcessRequest,type ProcessResult} from '../packages/actions/system';
import {CREPE_PIPELINES} from '../packages/github-actions/crepe';
import {configPath,readConfig,updateConfig} from '../packages/host/src/config';
import {actionsInBehavior,singlePressBehavior,validateStudioDocument,type ButtonDefinition,type StudioDocument} from '../packages/studio/document';
import {StudioRepository} from '../packages/studio/repository';

type Dependencies={which(name:string):string|undefined|null;runProcess(request:ProcessRequest,signal?:AbortSignal):Promise<ProcessResult>};
const context={pipelines:CREPE_PIPELINES.map(({id})=>({id}))};
const label=(text:string,color:string):ButtonDefinition['appearance']=>({contentMode:'label-only',label:{text,position:'center',size:'medium',color:'#ffffff'},background:{color,opacity:.82}});
const pipelineButton=(id:string,index:number,text:string,pipelineId:string,role:'trigger'|'deployment',options:{hold?:boolean}={}):ButtonDefinition=>({id,index,behavior:options.hold?{press:{type:'single',action:{type:'github-pipeline',pipelineId,role}},hold:{type:'single',action:{type:'github-pipeline',pipelineId,role}},doublePressMs:300,holdMs:700}:singlePressBehavior({type:'github-pipeline',pipelineId,role}),appearance:label(text,role==='trigger'?'#243b64':'#273746')});
const releaseButtons=():ButtonDefinition[]=>[
  pipelineButton('crepe-rc-cut',0,'RC 컷','crepe-backend-stg','trigger'),
  pipelineButton('crepe-stg-deploy',1,'Stg 배포','crepe-backend-stg','deployment'),
  pipelineButton('crepe-prod-promote',5,'Prod 승격','crepe-backend-prod','trigger',{hold:true}),
  pipelineButton('crepe-prod-deploy',6,'Prod 배포','crepe-backend-prod','deployment'),
  {id:'crepe-release-previous',index:10,behavior:singlePressBehavior({type:'previous-page'}),appearance:label('이전 페이지','#3a1830')},
];

function managedReleasePage(document:StudioDocument):boolean{
  const page=document.pages.find(item=>item.id==='crepe-release');if(!page||page.title!=='Crepe Release')return false;const expected=releaseButtons();return expected.every(button=>page.buttons?.some(item=>item.id===button.id&&item.index===button.index));
}

export function addCrepeReleasePage(input:StudioDocument):StudioDocument{
  const document=validateStudioDocument(input,context),existing=document.pages.find(page=>page.id==='crepe-release');if(existing){if(!managedReleasePage(document))throw new Error('The crepe-release page ID is already used by another page');return document;}
  const prior=document.pages.at(-1)!;
  if(!(prior.buttons??[]).some(button=>actionsInBehavior(button.behavior).some(action=>action.type==='next-page'))){
    const index=[14,13,12,11,9,8,7,6,5,4,3,2,1,0].find(value=>!prior.buttons?.some(button=>button.index===value));if(index===undefined)throw new Error('The previous page has no free key for Crepe release navigation');
    prior.buttons=[...(prior.buttons??[]),{id:'crepe-release-next',index,behavior:singlePressBehavior({type:'next-page'}),appearance:label('릴리스','#3a1830')}];
  }
  document.pages.push({id:'crepe-release',title:'Crepe Release',buttons:releaseButtons()});return validateStudioDocument(document,context);
}

function publish(path:string,document:StudioDocument){const temporary=`${path}.${randomUUID()}.tmp`;try{writeFileSync(temporary,JSON.stringify(document,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,path);}finally{rmSync(temporary,{force:true});}}

export async function registerCrepeGitHubActions(dependencies:Partial<Dependencies>={}):Promise<{gh:string;pageId:'crepe-release';draftUpdated:boolean}>{
  const which=dependencies.which??(name=>Bun.which(name)),runProcess=dependencies.runProcess??runBoundedProcess,gh=which('gh');if(!gh||!gh.startsWith('/'))throw new Error('Install and authenticate the gh CLI before registration');
  try{await runProcess({argv:[gh,'auth','status','--hostname','github.com'],timeoutMs:10_000,maxOutputBytes:65_536});}catch{throw new Error('Authenticate the gh CLI for github.com before registration');}
  readConfig(true);const studioDirectory=join(dirname(configPath()),'studio'),repository=new StudioRepository(studioDirectory,context),snapshot=repository.snapshot(),next=addCrepeReleasePage(snapshot.document),draftPath=join(studioDirectory,'draft.json');let nextDraft:StudioDocument|undefined,draftUpdated=false;
  if(existsSync(draftPath))try{nextDraft=addCrepeReleasePage(validateStudioDocument(JSON.parse(readFileSync(draftPath,'utf8')),context));}catch{/* preserve an invalid or incompatible draft */}
  updateConfig(config=>({...config,githubActions:{executable:gh,pipelines:CREPE_PIPELINES.map(item=>structuredClone(item))}}));repository.apply(next,snapshot.version);if(nextDraft){publish(draftPath,nextDraft);draftUpdated=true;}
  return{gh,pageId:'crepe-release',draftUpdated};
}

if(import.meta.main){registerCrepeGitHubActions().then(result=>{console.log(`Registered ${result.pageId} with ${result.gh}. No workflow was dispatched.`);}).catch(error=>{console.error(error instanceof Error?error.message:'Registration failed');process.exitCode=1;});}
