import {runBoundedProcess,type ProcessRequest,type ProcessResult} from '../actions/system';
import type {GitHubActionsGateway,GitHubJob,GitHubPendingDeployment,GitHubRelease,GitHubRunDetails,GitHubStep,GitHubWorkflowRun,PipelineDefinition} from './types';
import {homedir} from 'node:os';

type RunProcess=(request:ProcessRequest,signal?:AbortSignal)=>Promise<ProcessResult>;
export type GitHubCliGatewayOptions={executable:string;home?:string;runProcess?:RunProcess};

class GitHubCliError extends Error{
  constructor(readonly code:'command-failed'|'invalid-response'|'invalid-url',message:string){super(message);this.name='GitHubCliError';}
}

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=()=>new GitHubCliError('invalid-response','Invalid GitHub response');
const integer=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw invalid();return value;};
const text=(value:unknown,max=512)=>{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw invalid();return value;};
const nullableText=(value:unknown,max=64)=>value===null?null:text(value,max);
const timestamp=(value:unknown)=>{const result=text(value,64);if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)||!Number.isFinite(Date.parse(result)))throw invalid();return result;};
const nullableTimestamp=(value:unknown)=>value===null?null:timestamp(value);
const STATUSES=new Set(['queued','in_progress','completed','waiting','requested','pending']);
const CONCLUSIONS=new Set(['action_required','cancelled','failure','neutral','skipped','stale','startup_failure','success','timed_out']);
const status=(value:unknown)=>{const result=text(value,32);if(!STATUSES.has(result))throw invalid();return result;};
const conclusion=(value:unknown)=>{const result=nullableText(value,32);if(result!==null&&!CONCLUSIONS.has(result))throw invalid();return result;};
const repositoryName=(value:string)=>{if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value))throw new GitHubCliError('invalid-url','Invalid GitHub URL');return value;};
const repositoryUrl=(value:unknown,repository:string)=>{const result=text(value,2048);let url:URL;try{url=new URL(result);}catch{throw invalid();}if(url.protocol!=='https:'||url.hostname!=='github.com'||url.username||url.password||!url.pathname.startsWith(`/${repositoryName(repository)}/`))throw invalid();return url.href;};
const runUrl=(value:unknown,repository:string)=>{const result=repositoryUrl(value,repository);if(!new URL(result).pathname.startsWith(`/${repository}/actions/`))throw invalid();return result;};
const releaseUrl=(value:unknown,repository:string)=>{const result=repositoryUrl(value,repository);if(!new URL(result).pathname.startsWith(`/${repository}/releases/`))throw invalid();return result;};

function parseJson(stdout:string):unknown{try{return JSON.parse(stdout);}catch{throw invalid();}}
function parseRun(raw:unknown,repository:string):GitHubWorkflowRun{
  if(!record(raw)||!record(raw.actor))throw invalid();
  const headSha=text(raw.head_sha,64);if(!/^[a-f0-9]{40}$/i.test(headSha))throw invalid();
  const actor=text(raw.actor.login,64);if(!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(actor))throw invalid();
  return{id:integer(raw.id),workflowId:integer(raw.workflow_id),url:runUrl(raw.html_url,repository),event:text(raw.event,64),headBranch:text(raw.head_branch,255),headSha:headSha.toLowerCase(),status:status(raw.status),conclusion:conclusion(raw.conclusion),createdAt:timestamp(raw.created_at),updatedAt:timestamp(raw.updated_at),actor};
}
function parseStep(raw:unknown):GitHubStep{
  if(!record(raw))throw invalid();
  return{name:text(raw.name,128),status:status(raw.status),conclusion:conclusion(raw.conclusion),startedAt:nullableTimestamp(raw.started_at),completedAt:nullableTimestamp(raw.completed_at)};
}
function parseJob(raw:unknown,repository:string):GitHubJob{
  if(!record(raw)||!Array.isArray(raw.steps)||raw.steps.length>100)throw invalid();
  return{id:integer(raw.id),name:text(raw.name,128),url:runUrl(raw.html_url,repository),status:status(raw.status),conclusion:conclusion(raw.conclusion),startedAt:nullableTimestamp(raw.started_at),completedAt:nullableTimestamp(raw.completed_at),steps:raw.steps.map(parseStep)};
}

export function createGitHubCliGateway(options:GitHubCliGatewayOptions):GitHubActionsGateway{
  if(!options.executable.startsWith('/'))throw new Error('GitHub CLI executable must be absolute');
  const execute=options.runProcess??runBoundedProcess,home=options.home??homedir();if(!home.startsWith('/'))throw new Error('GitHub CLI home must be absolute');
  const command=async(argv:string[],limits:{timeoutMs:number;maxOutputBytes:number},signal?:AbortSignal)=>{
    try{const result=await execute({argv,env:{HOME:home},timeoutMs:limits.timeoutMs,maxOutputBytes:limits.maxOutputBytes},signal);if(result.exitCode!==0)throw new Error();return result.stdout;}
    catch(error){if(error instanceof GitHubCliError)throw error;if(signal?.aborted||error instanceof DOMException&&error.name==='AbortError')throw new GitHubCliError('command-failed','GitHub command cancelled');throw new GitHubCliError('command-failed','GitHub command failed');}
  };
  const read=(argv:string[],signal?:AbortSignal)=>command(argv,{timeoutMs:10_000,maxOutputBytes:1_048_576},signal);
  const gh=(...args:string[])=>[options.executable,...args];
  return{
    async viewer(signal){const raw=parseJson(await read(gh('api','user'),signal));if(!record(raw))throw invalid();const login=text(raw.login,64);if(!/^[A-Za-z0-9-]+$/.test(login))throw invalid();return login;},
    async dispatch(definition,signal){
      const argv=gh('workflow','run',definition.trigger.workflow,'--repo',definition.repository,'--ref',definition.ref);
      for(const [key,value] of Object.entries(definition.trigger.inputs))argv.push('-f',`${key}=${value}`);
      const stdout=(await command(argv,{timeoutMs:60_000,maxOutputBytes:1_048_576},signal)).trim();if(!stdout)return;
      const candidates=stdout.split(/\s+/).filter(value=>value.startsWith('https://'));
      if(!candidates.length)return;
      if(candidates.length!==1)throw invalid();return runUrl(candidates[0],definition.repository);
    },
    async listRuns(repository,workflow,signal){
      repositoryName(repository);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/.test(workflow))throw invalid();
      const raw=parseJson(await read(gh('api',`repos/${repository}/actions/workflows/${workflow}/runs?per_page=30`),signal));
      if(!record(raw)||!Array.isArray(raw.workflow_runs)||raw.workflow_runs.length>30)throw invalid();
      const runs=raw.workflow_runs.map(value=>parseRun(value,repository));if(new Set(runs.map(run=>run.id)).size!==runs.length)throw invalid();return runs;
    },
    async getRun(repository,runId,signal){
      repositoryName(repository);integer(runId);
      const [runBody,jobsBody]=await Promise.all([
        read(gh('api',`repos/${repository}/actions/runs/${runId}`),signal),
        read(gh('api',`repos/${repository}/actions/runs/${runId}/jobs?per_page=100`),signal),
      ]);
      const run=parseRun(parseJson(runBody),repository),rawJobs=parseJson(jobsBody);if(run.id!==runId||!record(rawJobs)||!Array.isArray(rawJobs.jobs)||rawJobs.jobs.length>100)throw invalid();
      const jobs=rawJobs.jobs.map(value=>parseJob(value,repository));if(new Set(jobs.map(job=>job.id)).size!==jobs.length)throw invalid();return{...run,jobs};
    },
    async pendingDeployments(repository,runId,signal){
      repositoryName(repository);integer(runId);const raw=parseJson(await read(gh('api',`repos/${repository}/actions/runs/${runId}/pending_deployments`),signal));if(!Array.isArray(raw)||raw.length>32)throw invalid();
      return raw.map((value):GitHubPendingDeployment=>{if(!record(value)||!record(value.environment)||typeof value.current_user_can_approve!=='boolean')throw invalid();return{environment:{id:integer(value.environment.id),name:text(value.environment.name,64),htmlUrl:repositoryUrl(value.environment.html_url,repository)},currentUserCanApprove:value.current_user_can_approve};});
    },
    async listReleases(repository,signal){
      repositoryName(repository);const raw=parseJson(await read(gh('api',`repos/${repository}/releases?per_page=30`),signal));if(!Array.isArray(raw)||raw.length>30)throw invalid();
      const releases=raw.map((value):GitHubRelease=>{if(!record(value))throw invalid();return{id:integer(value.id),tagName:text(value.tag_name,128),targetCommitish:text(value.target_commitish,64),publishedAt:timestamp(value.published_at),url:releaseUrl(value.html_url,repository)};});if(new Set(releases.map(release=>release.id)).size!==releases.length)throw invalid();return releases;
    },
    async open(repository,url,signal){
      repositoryName(repository);let parsed:URL;try{parsed=new URL(url);}catch{throw new GitHubCliError('invalid-url','Invalid GitHub URL');}
      const prefix=`/${repository}/`,allowed=parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password&&parsed.pathname.startsWith(prefix)&&(parsed.pathname.startsWith(`${prefix}actions/`)||parsed.pathname.startsWith(`${prefix}releases/`));
      if(!allowed)throw new GitHubCliError('invalid-url','Invalid GitHub URL');await command(['/usr/bin/open',parsed.href],{timeoutMs:3_000,maxOutputBytes:4_096},signal);
    },
  };
}
