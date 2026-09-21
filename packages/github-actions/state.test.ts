import {expect,test} from 'bun:test';
import {CREPE_PIPELINES} from './crepe';
import type {GitHubJob,GitHubPendingDeployment,GitHubRelease,GitHubRunDetails,GitHubWorkflowRun} from './types';
import {anchorResult,firstFailureUrl,matchPublishedRelease,matchReleaseRun,matchTagPushRun,normalizeRunState} from './state';

const baseRun:GitHubWorkflowRun={id:1,workflowId:1,url:'https://github.com/cookieplace/crepe/actions/runs/1',event:'push',headBranch:'backend/v1.2.3-rc.1',headSha:'a'.repeat(40),status:'in_progress',conclusion:null,createdAt:'2026-09-21T01:00:00Z',updatedAt:'2026-09-21T01:01:00Z',actor:'riemannulus'};
const run=(change:Partial<GitHubWorkflowRun>={}):GitHubWorkflowRun=>({...baseRun,...change});
const job=(id:number,conclusion:GitHubJob['conclusion'],startedAt:string):GitHubJob=>({id,name:`job-${id}`,url:`https://github.com/cookieplace/crepe/actions/runs/1/job/${id}`,status:'completed',conclusion,startedAt,completedAt:'2026-09-21T03:00:00Z',steps:[]});
const details=(jobs:GitHubJob[],change:Partial<GitHubRunDetails>={}):GitHubRunDetails=>({...run(),jobs,...change});

test('normalizes GitHub states and lets the exact pending Environment override running',()=>{
  for(const status of ['queued','requested','pending','waiting'])expect(normalizeRunState(run({status}))).toBe('queued');
  expect(normalizeRunState(run({status:'in_progress'}))).toBe('running');
  expect(normalizeRunState(run({status:'completed',conclusion:'success'}))).toBe('succeeded');
  expect(normalizeRunState(run({status:'completed',conclusion:'cancelled'}))).toBe('cancelled');
  for(const conclusion of ['failure','timed_out','startup_failure','action_required'])expect(normalizeRunState(run({status:'completed',conclusion}))).toBe('failed');
  const pending:GitHubPendingDeployment[]=[{environment:{id:1,name:'stg-backend',htmlUrl:'https://github.com/cookieplace/crepe/deployments/a'},currentUserCanApprove:true}];
  expect(normalizeRunState(run(),pending,'stg-backend')).toBe('approval-required');
  expect(normalizeRunState(run(),pending,'prod')).toBe('running');
});

test('finds the configured anchor and distinguishes skipped tags from successful chains',()=>{
  const trigger=details([{...job(1,'success','2026-09-21T01:00:00Z'),name:'cut-rc',steps:[{name:'Push rc tag',status:'completed',conclusion:'skipped',startedAt:'2026-09-21T01:10:00Z',completedAt:'2026-09-21T01:11:00Z'}]}]);
  expect(anchorResult(CREPE_PIPELINES[0]!,trigger)).toEqual({kind:'skipped',completedAt:'2026-09-21T01:11:00Z'});
  trigger.jobs[0]!.steps[0]!.conclusion='success';
  expect(anchorResult(CREPE_PIPELINES[0]!,trigger)).toEqual({kind:'success',completedAt:'2026-09-21T01:11:00Z'});
});

test('tag and release correlation rejects wrong and ambiguous candidates',()=>{
  const stg=CREPE_PIPELINES[0]!,trigger=run({headSha:'b'.repeat(40)}),valid=run({id:2,workflowId:99,event:'push',headSha:'b'.repeat(40),headBranch:'backend/v1.2.3-rc.2',createdAt:'2026-09-21T01:12:00Z'});
  expect(matchTagPushRun(stg,trigger,'2026-09-21T01:11:00Z',[valid])).toEqual({kind:'matched',value:valid});
  expect(matchTagPushRun(stg,trigger,'2026-09-21T01:11:00Z',[valid,{...valid,id:3,url:valid.url.replace('/2','/3')}]).kind).toBe('ambiguous');
  expect(matchTagPushRun(stg,trigger,'2026-09-21T01:11:00Z',[{...valid,headSha:'c'.repeat(40)}]).kind).toBe('none');

  const prod=CREPE_PIPELINES[1]!,release:GitHubRelease={id:20,tagName:'backend/v1.2.3',targetCommitish:'d'.repeat(40),publishedAt:'2026-09-21T02:00:00Z',url:'https://github.com/cookieplace/crepe/releases/tag/backend%2Fv1.2.3'};
  expect(matchPublishedRelease(prod,new Set([19]),'2026-09-21T01:59:00Z',[release])).toEqual({kind:'matched',value:release});
  const deploy=run({id:4,event:'release',headBranch:release.tagName,headSha:release.targetCommitish,createdAt:'2026-09-21T02:00:05Z'});
  expect(matchReleaseRun(prod,release,[deploy])).toEqual({kind:'matched',value:deploy});
  expect(matchReleaseRun(prod,release,[{...deploy,headBranch:'backend/v9.9.9'}]).kind).toBe('none');
});

test('failure URL chooses the earliest failed job and falls back to the run',()=>{
  const value=details([job(2,'failure','2026-09-21T02:00:00Z'),job(1,'failure','2026-09-21T01:00:00Z')]);
  expect(firstFailureUrl(value)).toContain('/job/1');
  expect(firstFailureUrl(details([]))).toBe(baseRun.url);
});
