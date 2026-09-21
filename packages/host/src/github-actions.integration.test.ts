import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {CREPE_PIPELINES} from '../../github-actions/crepe';
import {startGitHubActionsPipeline} from '../../github-actions/pipeline';
import {MemoryPipelinePersistence} from '../../github-actions/store';
import type {GitHubActionsGateway,GitHubJob,GitHubPendingDeployment,GitHubRelease,GitHubRunDetails,GitHubWorkflowRun,PipelineDefinition} from '../../github-actions/types';
import type {DeckBackend,DeckBackendStatus,PreparedPresentation,PresentationRequest} from '../../presentation/backend';
import {singlePressBehavior} from '../../studio/document';
import {SignalStore} from './store';
import {startPresentationCoordinator} from './presentation';

const run=(change:Partial<GitHubWorkflowRun>={}):GitHubWorkflowRun=>({id:301,workflowId:341993367,url:'https://github.com/cookieplace/crepe/actions/runs/301',event:'push',headBranch:'backend/v1.2.3-rc.1',headSha:'a'.repeat(40),status:'in_progress',conclusion:null,createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:01:00Z',actor:'riemannulus',...change});
class Gateway implements GitHubActionsGateway{
  deployment=run();pending:GitHubPendingDeployment[]=[{environment:{id:1,name:'stg-backend',htmlUrl:'https://github.com/cookieplace/crepe/deployments/stg'},currentUserCanApprove:true}];jobs:GitHubJob[]=[];opened:string[]=[];
  viewer=async()=> 'riemannulus';dispatch=async(_definition:PipelineDefinition)=>undefined;
  listRuns=async(_repo:string,workflow:string)=>workflow==='release-backend.yaml'?[structuredClone(this.deployment)]:[];
  getRun=async(_repo:string,id:number):Promise<GitHubRunDetails>=>({...structuredClone(this.deployment),id,jobs:structuredClone(this.jobs)});
  pendingDeployments=async()=>structuredClone(this.pending);listReleases=async():Promise<GitHubRelease[]>=>[];
  open=async(_repo:string,url:string)=>{this.opened.push(url);};
}
class Backend implements DeckBackend{
  requests:PresentationRequest[]=[];async prepare(request:PresentationRequest){this.requests.push(request);return{backend:'plugin' as const,generation:request.generation,token:request.generation};}async present(_value:PreparedPresentation){}status():DeckBackendStatus{return{mode:'plugin',state:'ready',connected:true};}async stop(){}
}
const waitFor=async(predicate:()=>boolean)=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await Bun.sleep(5);expect(predicate()).toBe(true);};

test('Stg approval and failed job flow survives the real pipeline, Presentation and persistence seams',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'streamhub-github-integration-')),store=new SignalStore(':memory:'),gateway=new Gateway(),persistence=new MemoryPipelinePersistence(),backend=new Backend();let tick=()=>{},presentation:Awaited<ReturnType<typeof startPresentationCoordinator>>|undefined,pipeline:Awaited<ReturnType<typeof startGitHubActionsPipeline>>|undefined;
  try{
    pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence,schedule:(_delay,callback)=>{tick=callback;return{cancel(){}};}});presentation=await startPresentationCoordinator({store,directory,backend,pipelines:pipeline,execute:async()=>{}});
    const snapshot=presentation.snapshot(),document=structuredClone(snapshot.document);document.pages[0].buttons=[{id:'stg',index:0,behavior:singlePressBehavior({type:'github-pipeline',pipelineId:'crepe-backend-stg',role:'deployment'}),appearance:{contentMode:'label-only',label:{text:'Stg 배포',position:'center',size:'medium',color:'#ffffff'}}}];await presentation.apply(document,snapshot.version);
    let raw=await sharp(backend.requests.at(-1)!.to.keyPngs[0]).raw().toBuffer();expect([...raw.subarray(0,3)]).toEqual([245,158,11]);let generation=presentation.status().generation!;await presentation.key({index:0,phase:'down',generation});await presentation.key({index:0,phase:'up',generation});expect(gateway.opened.at(-1)).toBe(gateway.deployment.url);
    const failedJob:GitHubJob={id:9,name:'deploy-backend',url:`${gateway.deployment.url}/job/9`,status:'completed',conclusion:'failure',startedAt:'2026-09-21T02:00:00Z',completedAt:'2026-09-21T02:01:00Z',steps:[]};gateway.deployment=run({status:'completed',conclusion:'failure',updatedAt:'2026-09-21T02:01:00Z'});gateway.pending=[];gateway.jobs=[failedJob];const requestCount=backend.requests.length;tick();await waitFor(()=>backend.requests.length>requestCount);
    raw=await sharp(backend.requests.at(-1)!.to.keyPngs[0]).raw().toBuffer();expect([...raw.subarray(0,3)]).toEqual([220,55,65]);generation=presentation.status().generation!;await presentation.key({index:0,phase:'down',generation});await presentation.key({index:0,phase:'up',generation});expect(gateway.opened.at(-1)).toBe(failedJob.url);
    await presentation.stop();presentation=undefined;await pipeline.stop();pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence,schedule:()=>({cancel(){}})});expect(pipeline.snapshot().find(item=>item.binding.pipelineId==='crepe-backend-stg'&&item.binding.role==='deployment')).toMatchObject({state:'failed',runUrl:failedJob.url});
  }finally{await presentation?.stop();await pipeline?.stop();store.close();rmSync(directory,{recursive:true,force:true});}
});
