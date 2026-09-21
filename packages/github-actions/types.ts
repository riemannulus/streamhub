export type PipelineState='idle'|'dispatching'|'queued'|'running'|'approval-required'|'succeeded'|'no-change'|'failed'|'cancelled'|'unavailable';
export type PipelineButtonRole='trigger'|'deployment';
export type PipelineGesture='press'|'hold';
export type PipelineButtonBinding={pipelineId:string;role:PipelineButtonRole};
export type PipelineButtonSnapshot={binding:PipelineButtonBinding;state:PipelineState;detail:string;color:string;runUrl?:string};

export type PipelineDefinition={
  id:string;
  repository:string;
  ref:string;
  trigger:{workflow:string;inputs:Record<string,string>;gesture:PipelineGesture};
  chain:{kind:'tag-push'|'release-published';anchorJob:string;anchorStep:string;tagPattern:string};
  deployment:{workflow:string;event:'push'|'release';approvalEnvironment?:string};
};
export type GitHubActionsConfig={executable:string;pipelines:PipelineDefinition[]};

export type GitHubWorkflowRun={id:number;workflowId:number;url:string;event:string;headBranch:string;headSha:string;status:string;conclusion:string|null;createdAt:string;updatedAt:string;actor:string};
export type GitHubStep={name:string;status:string;conclusion:string|null;startedAt:string|null;completedAt:string|null};
export type GitHubJob={id:number;name:string;url:string;status:string;conclusion:string|null;startedAt:string|null;completedAt:string|null;steps:GitHubStep[]};
export type GitHubRunDetails=GitHubWorkflowRun&{jobs:GitHubJob[]};
export type GitHubPendingDeployment={environment:{id:number;name:string;htmlUrl:string};currentUserCanApprove:boolean};
export type GitHubRelease={id:number;tagName:string;targetCommitish:string;publishedAt:string;url:string};

export interface GitHubActionsGateway{
  viewer(signal?:AbortSignal):Promise<string>;
  dispatch(definition:PipelineDefinition,signal?:AbortSignal):Promise<string|undefined>;
  listRuns(repository:string,workflow:string,signal?:AbortSignal):Promise<GitHubWorkflowRun[]>;
  getRun(repository:string,runId:number,signal?:AbortSignal):Promise<GitHubRunDetails>;
  pendingDeployments(repository:string,runId:number,signal?:AbortSignal):Promise<GitHubPendingDeployment[]>;
  listReleases(repository:string,signal?:AbortSignal):Promise<GitHubRelease[]>;
  open(repository:string,url:string,signal?:AbortSignal):Promise<void>;
}

export interface GitHubActionsPipeline{
  snapshot():readonly PipelineButtonSnapshot[];
  activate(binding:PipelineButtonBinding,gesture:PipelineGesture,signal:AbortSignal):Promise<void>;
  subscribe(listener:()=>void):()=>void;
  stop():Promise<void>;
}
