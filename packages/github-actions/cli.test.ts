import {expect,test} from 'bun:test';
import type {ProcessRequest,ProcessResult} from '../actions/system';
import {CREPE_PIPELINES} from './crepe';
import {createGitHubCliGateway} from './cli';

type Response=ProcessResult|Error;
function harness(responses:Response[]){
  const calls:ProcessRequest[]=[];
  const gateway=createGitHubCliGateway({executable:'/opt/homebrew/bin/gh',home:'/Users/test',runProcess:async(request,signal)=>{
    calls.push(structuredClone(request));
    if(signal?.aborted)throw new DOMException('aborted','AbortError');
    const response=responses.shift();if(!response)throw new Error('unexpected call');if(response instanceof Error)throw response;return response;
  }});
  return{gateway,calls};
}
const result=(value:unknown):ProcessResult=>({stdout:typeof value==='string'?value:JSON.stringify(value),stderr:'',exitCode:0});
const run={id:42,workflow_id:341993367,html_url:'https://github.com/cookieplace/crepe/actions/runs/42',event:'push',head_branch:'backend/v1.2.3-rc.1',head_sha:'a'.repeat(40),status:'in_progress',conclusion:null,created_at:'2026-09-21T01:00:00Z',updated_at:'2026-09-21T01:01:00Z',actor:{login:'riemannulus'}};
const job={id:7,name:'deploy-backend',html_url:'https://github.com/cookieplace/crepe/actions/runs/42/job/7',status:'completed',conclusion:'failure',started_at:'2026-09-21T01:02:00Z',completed_at:'2026-09-21T01:03:00Z',steps:[{name:'Deploy to EB',status:'completed',conclusion:'failure',started_at:'2026-09-21T01:02:10Z',completed_at:'2026-09-21T01:02:50Z'}]};

test('dispatch uses literal argv and returns only a repository run URL',async()=>{
  const {gateway,calls}=harness([result('https://github.com/cookieplace/crepe/actions/runs/123\n')]);
  expect(await gateway.dispatch(CREPE_PIPELINES[0]!)).toBe('https://github.com/cookieplace/crepe/actions/runs/123');
  expect(calls[0]).toEqual({argv:['/opt/homebrew/bin/gh','workflow','run','cut-rc.yaml','--repo','cookieplace/crepe','--ref','develop','-f','force-bump=auto'],env:{HOME:'/Users/test'},timeoutMs:60_000,maxOutputBytes:1_048_576});
});

test('viewer and workflow runs are strictly projected from REST responses',async()=>{
  const {gateway,calls}=harness([result({login:'riemannulus',token:'hidden'}),result({workflow_runs:[run],total_count:1,secret:'hidden'})]);
  expect(await gateway.viewer()).toBe('riemannulus');
  expect(await gateway.listRuns('cookieplace/crepe','release-backend.yaml')).toEqual([{id:42,workflowId:341993367,url:run.html_url,event:'push',headBranch:run.head_branch,headSha:run.head_sha,status:'in_progress',conclusion:null,createdAt:run.created_at,updatedAt:run.updated_at,actor:'riemannulus'}]);
  expect(calls[1]!.argv).toEqual(['/opt/homebrew/bin/gh','api','repos/cookieplace/crepe/actions/workflows/release-backend.yaml/runs?per_page=30']);
});

test('run details combine exact run and jobs endpoints',async()=>{
  const {gateway,calls}=harness([result(run),result({total_count:1,jobs:[job]})]);
  expect(await gateway.getRun('cookieplace/crepe',42)).toMatchObject({id:42,jobs:[{id:7,name:'deploy-backend',conclusion:'failure',steps:[{name:'Deploy to EB',conclusion:'failure'}]}]});
  expect(calls.map(call=>call.argv.at(-1))).toEqual(['repos/cookieplace/crepe/actions/runs/42','repos/cookieplace/crepe/actions/runs/42/jobs?per_page=100']);
});

test('pending deployments and releases expose only bounded correlation fields',async()=>{
  const pending=[{environment:{id:9,name:'stg-backend',html_url:'https://github.com/cookieplace/crepe/deployments/activity_log?environments_filter=stg-backend'},current_user_can_approve:true,reviewers:[{secret:'hidden'}]}];
  const releases=[{id:11,tag_name:'backend/v1.2.3',target_commitish:'a'.repeat(40),published_at:'2026-09-21T02:00:00Z',html_url:'https://github.com/cookieplace/crepe/releases/tag/backend%2Fv1.2.3',body:'hidden'}];
  const {gateway}=harness([result(pending),result(releases)]);
  expect(await gateway.pendingDeployments('cookieplace/crepe',42)).toEqual([{environment:{id:9,name:'stg-backend',htmlUrl:pending[0]!.environment.html_url},currentUserCanApprove:true}]);
  expect(await gateway.listReleases('cookieplace/crepe')).toEqual([{id:11,tagName:'backend/v1.2.3',targetCommitish:'a'.repeat(40),publishedAt:'2026-09-21T02:00:00Z',url:releases[0]!.html_url}]);
});

test('foreign URLs, malformed payloads and process failures become sanitized adapter errors',async()=>{
  const foreign=harness([result('https://evil.example/run/1')]).gateway;
  await expect(foreign.dispatch(CREPE_PIPELINES[0]!)).rejects.toThrow('Invalid GitHub response');
  const malformed=harness([result({workflow_runs:[{...run,status:'invented'}]})]).gateway;
  await expect(malformed.listRuns('cookieplace/crepe','release-backend.yaml')).rejects.toThrow('Invalid GitHub response');
  const failed=harness([new Error('token=secret raw stderr')]).gateway;
  await expect(failed.viewer()).rejects.toThrow('GitHub command failed');
  try{await failed.viewer();}catch(error){expect(String(error)).not.toContain('secret');}
});

test('open accepts only repository action and release URLs and uses the bounded process seam',async()=>{
  const {gateway,calls}=harness([result('')]);
  await gateway.open('cookieplace/crepe','https://github.com/cookieplace/crepe/actions/runs/42/job/7');
  expect(calls[0]).toEqual({argv:['/usr/bin/open','https://github.com/cookieplace/crepe/actions/runs/42/job/7'],env:{HOME:'/Users/test'},timeoutMs:3_000,maxOutputBytes:4_096});
  await expect(gateway.open('cookieplace/crepe','https://github.com/other/repo/actions/runs/1')).rejects.toThrow('Invalid GitHub URL');
});
