import {expect,test} from 'bun:test';
import {CREPE_PIPELINES} from './crepe';
import {startGitHubActionsPipeline} from './pipeline';
import type {GitHubActionsGateway,GitHubPendingDeployment,GitHubRelease,GitHubRunDetails,GitHubWorkflowRun,PipelineDefinition} from './types';
import {MemoryPipelinePersistence} from './store';

const makeRun=(id:number,change:Partial<GitHubWorkflowRun>={}):GitHubWorkflowRun=>({id,workflowId:id,url:`https://github.com/cookieplace/crepe/actions/runs/${id}`,event:'workflow_dispatch',headBranch:'develop',headSha:'a'.repeat(40),status:'completed',conclusion:'success',createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:01:00Z',actor:'riemannulus',...change});
const details=(run:GitHubWorkflowRun,jobs:GitHubRunDetails['jobs']=[]):GitHubRunDetails=>({...run,jobs});

class FakeGateway implements GitHubActionsGateway{
  runs=new Map<string,GitHubWorkflowRun[]>();details=new Map<number,GitHubRunDetails>();pending=new Map<number,GitHubPendingDeployment[]>();releases:GitHubRelease[]=[];dispatchUrls=new Map<string,string|undefined>();dispatches:string[]=[];opened:string[]=[];
  viewer=async()=> 'riemannulus';
  dispatch=async(definition:PipelineDefinition)=>{this.dispatches.push(definition.id);return this.dispatchUrls.get(definition.id);};
  listRuns=async(_repository:string,workflow:string)=>structuredClone(this.runs.get(workflow)??[]);
  getRun=async(_repository:string,id:number)=>structuredClone(this.details.get(id)??details(makeRun(id)));
  pendingDeployments=async(_repository:string,id:number)=>structuredClone(this.pending.get(id)??[]);
  listReleases=async()=>structuredClone(this.releases);
  open=async(_repository:string,url:string)=>{this.opened.push(url);};
}

test('RC press dispatches, active duplicate opens, and Prod dispatches only on hold',async()=>{
  const gateway=new FakeGateway(),persistence=new MemoryPipelinePersistence();
  gateway.dispatchUrls.set('crepe-backend-stg','https://github.com/cookieplace/crepe/actions/runs/101');
  gateway.dispatchUrls.set('crepe-backend-prod','https://github.com/cookieplace/crepe/actions/runs/201');
  const pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence,schedule:()=>({cancel(){}})}),signal=new AbortController().signal;
  await pipeline.activate({pipelineId:'crepe-backend-stg',role:'trigger'},'press',signal);
  expect(gateway.dispatches).toEqual(['crepe-backend-stg']);
  await pipeline.activate({pipelineId:'crepe-backend-stg',role:'trigger'},'press',signal);
  expect(gateway.dispatches).toEqual(['crepe-backend-stg']);expect(gateway.opened.at(-1)).toContain('/runs/101');
  await pipeline.activate({pipelineId:'crepe-backend-prod',role:'trigger'},'press',signal);
  expect(gateway.dispatches).toEqual(['crepe-backend-stg']);
  await pipeline.activate({pipelineId:'crepe-backend-prod',role:'trigger'},'hold',signal);
  expect(gateway.dispatches).toEqual(['crepe-backend-stg','crepe-backend-prod']);await pipeline.stop();
});

test('Stg monitor shows the exact approval gate and failure opens the failed job',async()=>{
  let tick=()=>{};
  const gateway=new FakeGateway(),deployment=makeRun(301,{event:'push',headBranch:'backend/v1.2.3-rc.1',status:'in_progress',conclusion:null});
  gateway.runs.set('release-backend.yaml',[deployment]);gateway.details.set(301,details(deployment));gateway.pending.set(301,[{environment:{id:1,name:'stg-backend',htmlUrl:'https://github.com/cookieplace/crepe/deployments/stg'},currentUserCanApprove:true}]);
  const pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence:new MemoryPipelinePersistence(),schedule:(_delay,callback)=>{tick=callback;return{cancel(){}};}}),signal=new AbortController().signal;
  const approval=pipeline.snapshot().find(item=>item.binding.pipelineId==='crepe-backend-stg'&&item.binding.role==='deployment');
  expect(approval).toMatchObject({state:'approval-required',runUrl:deployment.url});expect(approval?.detail).toContain('승인 대기');
  await pipeline.activate({pipelineId:'crepe-backend-stg',role:'deployment'},'press',signal);expect(gateway.opened.at(-1)).toBe(deployment.url);
  const failedJob={id:9,name:'deploy-backend',url:`${deployment.url}/job/9`,status:'completed',conclusion:'failure',startedAt:'2026-09-21T02:00:00Z',completedAt:'2026-09-21T02:01:00Z',steps:[]};
  const failed={...deployment,status:'completed',conclusion:'failure',updatedAt:'2026-09-21T02:01:00Z'};gateway.runs.set('release-backend.yaml',[failed]);gateway.details.set(301,details(failed,[failedJob]));gateway.pending.set(301,[]);
  tick();await Bun.sleep(5);
  expect(pipeline.snapshot().find(item=>item.binding.pipelineId==='crepe-backend-stg'&&item.binding.role==='deployment')).toMatchObject({state:'failed',runUrl:failedJob.url});
  await pipeline.activate({pipelineId:'crepe-backend-stg',role:'deployment'},'press',signal);expect(gateway.opened.at(-1)).toBe(failedJob.url);await pipeline.stop();
});

test('stored run IDs are refreshed exactly on restart and unavailable queries keep their URLs',async()=>{
  const persistence=new MemoryPipelinePersistence(),gateway=new FakeGateway(),stored=makeRun(401,{status:'in_progress',conclusion:null});
  persistence.save('crepe-backend-prod',{version:1,trigger:{id:401,url:stored.url,headSha:stored.headSha,headBranch:stored.headBranch,createdAt:stored.createdAt,state:'running'}});gateway.details.set(401,details(stored));
  const pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence,schedule:()=>({cancel(){}})});
  expect(pipeline.snapshot().find(item=>item.binding.pipelineId==='crepe-backend-prod'&&item.binding.role==='trigger')).toMatchObject({state:'running',runUrl:stored.url});await pipeline.stop();
});

test('a new dispatch never adopts a deployment run created before that dispatch',async()=>{
  let tick=()=>{};const gateway=new FakeGateway(),old=makeRun(500,{event:'push',headBranch:'backend/v1.0.0-rc.1',createdAt:'2026-09-20T01:00:00Z'});
  gateway.runs.set('release-backend.yaml',[old]);gateway.details.set(500,details(old));gateway.dispatchUrls.set('crepe-backend-stg','https://github.com/cookieplace/crepe/actions/runs/501');
  const pipeline=await startGitHubActionsPipeline({definitions:CREPE_PIPELINES,gateway,persistence:new MemoryPipelinePersistence(),now:()=>Date.parse('2026-09-21T01:00:00Z'),schedule:(_delay,callback)=>{tick=callback;return{cancel(){}};}}),signal=new AbortController().signal;
  await pipeline.activate({pipelineId:'crepe-backend-stg',role:'trigger'},'press',signal);tick();await Bun.sleep(5);
  const monitor=pipeline.snapshot().find(item=>item.binding.pipelineId==='crepe-backend-stg'&&item.binding.role==='deployment');
  expect(monitor?.runUrl).toBe('https://github.com/cookieplace/crepe/actions/runs/501');expect(monitor?.runUrl).not.toBe(old.url);await pipeline.stop();
});
