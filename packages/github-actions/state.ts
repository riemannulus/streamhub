import type {GitHubPendingDeployment,GitHubRelease,GitHubRunDetails,GitHubWorkflowRun,PipelineDefinition,PipelineState} from './types';

export type MatchResult<T>={kind:'matched';value:T}|{kind:'none'|'ambiguous'};
export type AnchorResult={kind:'pending'|'missing'|'ambiguous'}|{kind:'skipped'|'success';completedAt:string};

export function normalizeRunState(run:GitHubWorkflowRun,pending:readonly GitHubPendingDeployment[]=[],approvalEnvironment?:string):PipelineState{
  if(approvalEnvironment&&pending.some(item=>item.environment.name===approvalEnvironment))return'approval-required';
  if(['queued','requested','pending','waiting'].includes(run.status))return'queued';
  if(run.status==='in_progress')return'running';
  if(run.status!=='completed')return'unavailable';
  if(run.conclusion==='success')return'succeeded';
  if(run.conclusion==='cancelled')return'cancelled';
  return'failed';
}

export function firstFailureUrl(run:GitHubRunDetails):string{
  return [...run.jobs].filter(job=>job.conclusion==='failure'||job.conclusion==='timed_out'||job.conclusion==='startup_failure'||job.conclusion==='action_required')
    .sort((left,right)=>Date.parse(left.startedAt??'9999-12-31T23:59:59Z')-Date.parse(right.startedAt??'9999-12-31T23:59:59Z')||left.id-right.id)[0]?.url??run.url;
}

export function anchorResult(definition:PipelineDefinition,run:GitHubRunDetails):AnchorResult{
  const jobs=run.jobs.filter(job=>job.name===definition.chain.anchorJob);if(jobs.length>1)return{kind:'ambiguous'};if(!jobs.length)return run.status==='completed'?{kind:'missing'}:{kind:'pending'};
  const steps=jobs[0]!.steps.filter(step=>step.name===definition.chain.anchorStep);if(steps.length>1)return{kind:'ambiguous'};const step=steps[0];if(!step)return run.status==='completed'?{kind:'missing'}:{kind:'pending'};
  if(step.status!=='completed'||!step.completedAt)return{kind:'pending'};if(step.conclusion==='skipped')return{kind:'skipped',completedAt:step.completedAt};if(step.conclusion==='success')return{kind:'success',completedAt:step.completedAt};return{kind:'missing'};
}

function tagRegex(pattern:string):RegExp{
  const escaped=pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','[0-9]+');return new RegExp(`^${escaped}$`);
}
function result<T>(values:T[]):MatchResult<T>{return values.length===1?{kind:'matched',value:values[0]!}:values.length?{kind:'ambiguous'}:{kind:'none'};}

export function matchTagPushRun(definition:PipelineDefinition,trigger:GitHubWorkflowRun,anchorCompletedAt:string,candidates:readonly GitHubWorkflowRun[]):MatchResult<GitHubWorkflowRun>{
  const pattern=tagRegex(definition.chain.tagPattern),since=Date.parse(anchorCompletedAt);
  return result(candidates.filter(run=>run.event===definition.deployment.event&&run.headSha===trigger.headSha&&Date.parse(run.createdAt)>=since&&pattern.test(run.headBranch)));
}

export function matchPublishedRelease(definition:PipelineDefinition,baseline:ReadonlySet<number>,anchorCompletedAt:string,candidates:readonly GitHubRelease[]):MatchResult<GitHubRelease>{
  const pattern=tagRegex(definition.chain.tagPattern),since=Date.parse(anchorCompletedAt);
  return result(candidates.filter(release=>!baseline.has(release.id)&&Date.parse(release.publishedAt)>=since&&pattern.test(release.tagName)));
}

export function matchReleaseRun(definition:PipelineDefinition,release:GitHubRelease,candidates:readonly GitHubWorkflowRun[]):MatchResult<GitHubWorkflowRun>{
  const sha=/^[a-f0-9]{40}$/i.test(release.targetCommitish)?release.targetCommitish.toLowerCase():undefined,since=Date.parse(release.publishedAt);
  return result(candidates.filter(run=>run.event===definition.deployment.event&&run.headBranch===release.tagName&&Date.parse(run.createdAt)>=since&&(!sha||run.headSha===sha)));
}
