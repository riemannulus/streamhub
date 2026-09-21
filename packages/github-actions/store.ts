import type {SignalStore} from '../host/src/store';
import type {PipelineState} from './types';

export type StoredRun={id:number;url:string;failureUrl?:string;headSha:string;headBranch:string;createdAt:string;state:PipelineState};
export type StoredRelease={id:number;tagName:string;targetCommitish:string;publishedAt:string;url:string};
export type StoredPipelineState={version:1;trigger?:StoredRun;deployment?:StoredRun;release?:StoredRelease;dispatchStartedAt?:string;anchorCompletedAt?:string;lastSuccessAt?:number;baselineReleaseIds?:number[]};
export interface PipelinePersistence{load(pipelineId:string):StoredPipelineState|undefined;save(pipelineId:string,state:StoredPipelineState):void;}

const id=(value:string)=>{if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value))throw new Error('Invalid pipeline ID');return value;};
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,fields:readonly string[])=>{if(Object.keys(value).some(key=>!fields.includes(key)))throw new Error('Invalid stored pipeline state');};
const integer=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new Error('Invalid stored pipeline state');return value;};
const timestamp=(value:unknown)=>{if(typeof value!=='string'||value.length>64||!Number.isFinite(Date.parse(value)))throw new Error('Invalid stored pipeline state');return value;};
const url=(value:unknown)=>{if(typeof value!=='string'||value.length>2048)throw new Error('Invalid stored pipeline state');let parsed:URL;try{parsed=new URL(value);}catch{throw new Error('Invalid stored pipeline state');}if(parsed.protocol!=='https:'||parsed.hostname!=='github.com'||parsed.username||parsed.password)throw new Error('Invalid stored pipeline state');return parsed.href;};
const states=new Set<PipelineState>(['idle','dispatching','queued','running','approval-required','succeeded','no-change','failed','cancelled','unavailable']);
const storedRun=(value:unknown):StoredRun=>{if(!record(value))throw new Error('Invalid stored pipeline state');exact(value,['id','url','failureUrl','headSha','headBranch','createdAt','state']);if(typeof value.headSha!=='string'||!/^[a-f0-9]{40}$/.test(value.headSha)||typeof value.headBranch!=='string'||!value.headBranch||value.headBranch.length>255||!states.has(value.state as PipelineState))throw new Error('Invalid stored pipeline state');return{id:integer(value.id),url:url(value.url),...(value.failureUrl===undefined?{}:{failureUrl:url(value.failureUrl)}),headSha:value.headSha,headBranch:value.headBranch,createdAt:timestamp(value.createdAt),state:value.state as PipelineState};};
const storedRelease=(value:unknown):StoredRelease=>{if(!record(value))throw new Error('Invalid stored pipeline state');exact(value,['id','tagName','targetCommitish','publishedAt','url']);if(typeof value.tagName!=='string'||!value.tagName||value.tagName.length>128||typeof value.targetCommitish!=='string'||!value.targetCommitish||value.targetCommitish.length>64)throw new Error('Invalid stored pipeline state');return{id:integer(value.id),tagName:value.tagName,targetCommitish:value.targetCommitish,publishedAt:timestamp(value.publishedAt),url:url(value.url)};};

export function validateStoredPipelineState(value:unknown):StoredPipelineState{
  if(!record(value)||value.version!==1)throw new Error('Invalid stored pipeline state');exact(value,['version','trigger','deployment','release','dispatchStartedAt','anchorCompletedAt','lastSuccessAt','baselineReleaseIds']);
  if(value.lastSuccessAt!==undefined&&(typeof value.lastSuccessAt!=='number'||!Number.isFinite(value.lastSuccessAt)||value.lastSuccessAt<0))throw new Error('Invalid stored pipeline state');
  if(value.baselineReleaseIds!==undefined&&(!Array.isArray(value.baselineReleaseIds)||value.baselineReleaseIds.length>30||new Set(value.baselineReleaseIds).size!==value.baselineReleaseIds.length))throw new Error('Invalid stored pipeline state');
  const baseline=value.baselineReleaseIds?.map(integer);
  return{version:1,...(value.trigger===undefined?{}:{trigger:storedRun(value.trigger)}),...(value.deployment===undefined?{}:{deployment:storedRun(value.deployment)}),...(value.release===undefined?{}:{release:storedRelease(value.release)}),...(value.dispatchStartedAt===undefined?{}:{dispatchStartedAt:timestamp(value.dispatchStartedAt)}),...(value.anchorCompletedAt===undefined?{}:{anchorCompletedAt:timestamp(value.anchorCompletedAt)}),...(value.lastSuccessAt===undefined?{}:{lastSuccessAt:value.lastSuccessAt as number}),...(baseline?{baselineReleaseIds:baseline}:{})};
}

export class SignalStorePipelinePersistence implements PipelinePersistence{
  constructor(private readonly store:Pick<SignalStore,'getViewState'|'setViewState'>){}
  load(pipelineId:string){try{const value=this.store.getViewState(`github-actions/${id(pipelineId)}`);return value===undefined?undefined:validateStoredPipelineState(value);}catch{return;}}
  save(pipelineId:string,state:StoredPipelineState){const validated=validateStoredPipelineState(state);this.store.setViewState(`github-actions/${id(pipelineId)}`,validated);}
}
export class MemoryPipelinePersistence implements PipelinePersistence{
  private values=new Map<string,StoredPipelineState>();
  load(pipelineId:string){const value=this.values.get(id(pipelineId));return value?structuredClone(value):undefined;}
  save(pipelineId:string,state:StoredPipelineState){this.values.set(id(pipelineId),structuredClone(validateStoredPipelineState(state)));}
}
