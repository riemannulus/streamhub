import {anchorResult,firstFailureUrl,matchPublishedRelease,matchReleaseRun,matchTagPushRun,normalizeRunState} from './state';
import type {PipelinePersistence,StoredPipelineState,StoredRun} from './store';
import type {GitHubActionsGateway,GitHubActionsPipeline,GitHubRelease,GitHubRunDetails,GitHubWorkflowRun,PipelineButtonBinding,PipelineButtonSnapshot,PipelineDefinition,PipelineGesture,PipelineState} from './types';

type Timer={cancel():void};
export type PipelineOptions={definitions:readonly PipelineDefinition[];gateway:GitHubActionsGateway;persistence:PipelinePersistence;now?:()=>number;schedule?:(delayMs:number,callback:()=>void)=>Timer;onError?:(error:unknown)=>void};
type RuntimeEntry={definition:PipelineDefinition;stored:StoredPipelineState;error:boolean};
const ACTIVE=new Set<PipelineState>(['dispatching','queued','running','approval-required']);
const COLORS:Record<PipelineState,string>={idle:'#6b7280',dispatching:'#dba52f',queued:'#dba52f',running:'#3b82f6','approval-required':'#f59e0b',succeeded:'#269d91','no-change':'#6b7280',failed:'#dc3741',cancelled:'#dc3741',unavailable:'#6b7280'};
const LABELS:Record<PipelineState,string>={idle:'대기',dispatching:'요청 중',queued:'대기열',running:'실행 중','approval-required':'승인 대기',succeeded:'완료','no-change':'변경 없음',failed:'실패',cancelled:'취소됨',unavailable:'확인 불가'};
const latest=(runs:readonly GitHubWorkflowRun[])=>[...runs].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)||b.id-a.id)[0];
const storedRun=(run:GitHubWorkflowRun,state:PipelineState,failureUrl?:string):StoredRun=>({id:run.id,url:run.url,...(failureUrl&&failureUrl!==run.url?{failureUrl}:{}),headSha:run.headSha,headBranch:run.headBranch,createdAt:run.createdAt,state});
const runIdFromUrl=(value:string|undefined)=>{if(!value)return;const match=/\/actions\/runs\/(\d+)(?:\/|$)/.exec(new URL(value).pathname);if(!match)return;const id=Number(match[1]);return Number.isSafeInteger(id)&&id>0?id:undefined;};

export async function startGitHubActionsPipeline(options:PipelineOptions):Promise<GitHubActionsPipeline>{
  const now=options.now??Date.now,schedule=options.schedule??((delay,callback)=>{const timer=setTimeout(callback,delay);return{cancel:()=>clearTimeout(timer)};}),entries=new Map<string,RuntimeEntry>(),listeners=new Set<()=>void>(),controller=new AbortController();
  for(const definition of options.definitions){if(entries.has(definition.id))throw new Error('Duplicate pipeline');entries.set(definition.id,{definition,stored:options.persistence.load(definition.id)??{version:1},error:false});}
  let viewer:string|undefined,timer:Timer|undefined,inFlight:Promise<void>|undefined,closed=false,errorCount=0,lastSerialized='';
  const report=(error:unknown)=>{try{options.onError?.(error);}catch{}};
  const fallback=(entry:RuntimeEntry,role:'trigger'|'deployment')=>role==='trigger'?entry.stored.trigger:entry.stored.deployment??entry.stored.trigger;
  const snapshotFor=(entry:RuntimeEntry,role:'trigger'|'deployment'):PipelineButtonSnapshot=>{
    const binding={pipelineId:entry.definition.id,role} as const,run=fallback(entry,role);let state:PipelineState=run?.state??'idle';
    if(entry.error)state='unavailable';
    if(role==='deployment'&&!entry.stored.deployment&&entry.stored.trigger?.state==='succeeded'){
      const expired=entry.stored.anchorCompletedAt!==undefined&&now()-Date.parse(entry.stored.anchorCompletedAt)>90_000;state=expired?'unavailable':'queued';
    }
    const suffix=entry.stored.release?.tagName??entry.stored.deployment?.headBranch;
    return{binding,state,detail:suffix?`${suffix.replace(/^backend\//,'').slice(0,24)} · ${LABELS[state]}`:LABELS[state],color:COLORS[state],...(run?{runUrl:run.failureUrl??run.url}:{})};
  };
  const snapshots=()=>[...entries.values()].flatMap(entry=>[snapshotFor(entry,'trigger'),snapshotFor(entry,'deployment')]);
  const notify=()=>{const serialized=JSON.stringify(snapshots());if(serialized===lastSerialized)return;lastSerialized=serialized;for(const listener of listeners)try{listener();}catch{}};
  const persist=(entry:RuntimeEntry)=>{options.persistence.save(entry.definition.id,entry.stored);};
  const updateRun=async(entry:RuntimeEntry,kind:'trigger'|'deployment',runId:number):Promise<GitHubRunDetails>=>{
    const details=await options.gateway.getRun(entry.definition.repository,runId,controller.signal),pending=kind==='deployment'&&entry.definition.deployment.approvalEnvironment?await options.gateway.pendingDeployments(entry.definition.repository,runId,controller.signal):[],state=normalizeRunState(details,pending,kind==='deployment'?entry.definition.deployment.approvalEnvironment:undefined),failure=state==='failed'?firstFailureUrl(details):undefined;
    entry.stored[kind]=storedRun(details,state,failure);if(state==='succeeded')entry.stored.lastSuccessAt=now();return details;
  };
  const discoverRuns=async(entry:RuntimeEntry)=>{
    const definition=entry.definition,[triggers,deployments]=await Promise.all([options.gateway.listRuns(definition.repository,definition.trigger.workflow,controller.signal),options.gateway.listRuns(definition.repository,definition.deployment.workflow,controller.signal)]);
    if(!entry.stored.trigger){
      const candidates=entry.stored.dispatchStartedAt?triggers.filter(run=>run.event==='workflow_dispatch'&&run.actor===viewer&&run.headBranch===definition.ref&&Date.parse(run.createdAt)>=Date.parse(entry.stored.dispatchStartedAt!)):triggers;
      if(entry.stored.dispatchStartedAt&&candidates.length>1)throw new Error('Ambiguous dispatched workflow run');
      const discovered=latest(candidates);if(discovered)entry.stored.trigger=storedRun(discovered,normalizeRunState(discovered));
    }
    if(!entry.stored.deployment&&!entry.stored.dispatchStartedAt){const discovered=latest(deployments);if(discovered)entry.stored.deployment=storedRun(discovered,normalizeRunState(discovered));}
    return{triggers,deployments};
  };
  const refreshEntry=async(entry:RuntimeEntry)=>{
    const {definition}=entry,lists=await discoverRuns(entry);let triggerDetails:GitHubRunDetails|undefined;
    if(entry.stored.trigger)triggerDetails=await updateRun(entry,'trigger',entry.stored.trigger.id);
    if(entry.stored.deployment)await updateRun(entry,'deployment',entry.stored.deployment.id);
    if(triggerDetails&&!entry.stored.deployment){
      const anchor=anchorResult(definition,triggerDetails);
      if(anchor.kind==='skipped'){entry.stored.trigger={...entry.stored.trigger!,state:'no-change'};entry.stored.anchorCompletedAt=anchor.completedAt;}
      else if(anchor.kind==='success'){
        entry.stored.anchorCompletedAt=anchor.completedAt;
        if(definition.chain.kind==='tag-push'){
          const match=matchTagPushRun(definition,triggerDetails,anchor.completedAt,lists.deployments);if(match.kind==='ambiguous')throw new Error('Ambiguous downstream workflow run');if(match.kind==='matched')await updateRun(entry,'deployment',match.value.id);
        }else if(entry.stored.baselineReleaseIds){
          const releases=await options.gateway.listReleases(definition.repository,controller.signal),releaseMatch=matchPublishedRelease(definition,new Set(entry.stored.baselineReleaseIds),anchor.completedAt,releases);if(releaseMatch.kind==='ambiguous')throw new Error('Ambiguous published release');
          if(releaseMatch.kind==='matched'){entry.stored.release=releaseMatch.value;const runMatch=matchReleaseRun(definition,releaseMatch.value,lists.deployments);if(runMatch.kind==='ambiguous')throw new Error('Ambiguous release workflow run');if(runMatch.kind==='matched')await updateRun(entry,'deployment',runMatch.value.id);}
        }
      }else if(anchor.kind==='ambiguous'||anchor.kind==='missing')throw new Error('Invalid workflow anchor');
    }
    entry.error=false;persist(entry);
  };
  const nextDelay=()=>{if(errorCount)return Math.min(60_000,5_000*2**(errorCount-1));const states=snapshots().map(item=>item.state);return states.includes('approval-required')?30_000:states.some(state=>ACTIVE.has(state))?10_000:60_000;};
  const queue=()=>{if(closed)return;timer?.cancel();timer=schedule(nextDelay(),()=>{void poll();});};
  const poll=async()=>{
    if(closed||inFlight)return inFlight;inFlight=(async()=>{
      try{viewer??=await options.gateway.viewer(controller.signal);for(const entry of entries.values())await refreshEntry(entry);errorCount=0;}
      catch(error){errorCount++;for(const entry of entries.values())entry.error=true;report(error);}
      finally{notify();inFlight=undefined;queue();}
    })();return inFlight;
  };
  await poll();
  return{
    snapshot:()=>structuredClone(snapshots()),
    async activate(binding:PipelineButtonBinding,gesture:PipelineGesture,signal:AbortSignal){
      if(closed||signal.aborted)throw new DOMException('Pipeline activation cancelled','AbortError');const entry=entries.get(binding.pipelineId);if(!entry)throw new Error('Unknown GitHub pipeline');const current=fallback(entry,binding.role),definition=entry.definition;
      if(binding.role==='deployment'||gesture!==definition.trigger.gesture||current&&ACTIVE.has(current.state)){if(current)await options.gateway.open(definition.repository,current.failureUrl??current.url,signal);return;}
      if(definition.chain.kind==='release-published')entry.stored.baselineReleaseIds=(await options.gateway.listReleases(definition.repository,signal)).map(release=>release.id);
      entry.stored={...entry.stored,dispatchStartedAt:new Date(now()).toISOString(),baselineReleaseIds:entry.stored.baselineReleaseIds};entry.stored.trigger=undefined;entry.stored.deployment=undefined;entry.stored.release=undefined;entry.stored.anchorCompletedAt=undefined;entry.error=false;persist(entry);notify();
      const url=await options.gateway.dispatch(definition,signal),id=runIdFromUrl(url);if(url&&id)entry.stored.trigger={id,url,headSha:'0'.repeat(40),headBranch:definition.ref,createdAt:entry.stored.dispatchStartedAt!,state:'queued'};
      else{
        viewer??=await options.gateway.viewer(signal);const candidates=(await options.gateway.listRuns(definition.repository,definition.trigger.workflow,signal)).filter(run=>run.event==='workflow_dispatch'&&run.actor===viewer&&run.headBranch===definition.ref&&Date.parse(run.createdAt)>=Date.parse(entry.stored.dispatchStartedAt!));
        if(candidates.length===1)entry.stored.trigger=storedRun(candidates[0]!,normalizeRunState(candidates[0]!));else entry.error=true;
      }
      persist(entry);notify();queue();
    },
    subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    async stop(){if(closed)return;closed=true;timer?.cancel();controller.abort();try{await inFlight;}catch{}listeners.clear();},
  };
}
