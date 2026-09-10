import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, type HostRuntime } from '../host/src/runtime';
import { startServer } from '../host/src/server';
import { SignalStore } from '../host/src/store';
import { ActionRegistry } from '../host/src/actions';
import { parseLive } from '../host/src/validation';
import { startDisplay } from '../host/src/display';
import type { SessionState } from '../host/src/session-monitor';
import type { ApplicationContext } from '../host/src/app-context';
import { HidDisplay } from '../streamdeck/hid';
import { validatePageSources, validatePageConfig, type PageConfig } from '../streamdeck/pages';
import type { ButtonEffect, DeckPage, SessionRecord } from '../streamdeck';

type EventBody =
  | {type:'effect';effect:ButtonEffect;status:'running'|'success'|'error';message?:string}
  | {type:'key';index:number;rgb:Buffer}
  | {type:'frame'|'standby'|'connect'|'close'|'restart'}
  | {type:'write-begin'|'write-end';frame:DeckPage;aborted:boolean}
  | {type:'input';index:number;edge:'down'|'up'}
  | {type:'session';active:boolean}
  | {type:'context';appBundleId:string|null;available:boolean};
export type SimulationEvent=EventBody & {at:number;generation:number};
export type SimulationState={revision:number;records:SessionRecord[];display:{session:SessionState;inputEnabled:boolean;lastError?:string;pageId?:string;manual?:boolean;selectionReason?:string;context?:ApplicationContext}};
export type SimulationSignal={source?:string;id:string;label:string;level?:'info'|'warn'|'urgent';detail?:string};
export type SimulationOptions={retainEvents?:boolean;sources?:string[];board?:PageConfig;latencyMs?:number;pollMs?:number;onEvent?:(event:SimulationEvent)=>void};
export type SimulationSnapshot={standby:boolean;pixels:(Buffer|null)[];generation:number;frame:DeckPage|null};
export type SimulationHost={
  readonly url:string;readonly device:SimulationSnapshot;readonly events:SimulationEvent[];
  upsert(signal:{id:string;label:string;level?:'info'|'warn'|'urgent';detail?:string},deliveryId?:string,source?:string):Promise<{revision:number}>;
  remove(id:string,deliveryId?:string,source?:string):Promise<{revision:number}>;
  state():Promise<SimulationState>;key(index:number,edge:'down'|'up'):void;
  setSession(active:boolean):void;setContext(appBundleId:string|null,available?:boolean,details?:{windowTitle?:string|null;displayId?:string|null}):void;
  applyDraft(board:PageConfig,selectedPage?:string):Promise<void>;selectPage(pageId:string):Promise<void>;auto():Promise<void>;
  markSourceStale(source:string):void;setActionResult(result:'success'|'error'):void;setLatency(ms:number):void;replaceSignals(records:SimulationSignal[]):Promise<void>;
  snapshot():SimulationSnapshot;restart():Promise<void>;stop():Promise<void>;
};
export const defaultSimulationBoard:PageConfig={defaultPage:'home',transition:'fade',durationMs:250,pages:[
  {id:'home',title:'Home',signals:{},buttons:[{index:12,type:'page',pageId:'terminal',label:'Terminal'},{index:13,type:'auto',label:'Auto'}]},
  {id:'terminal',title:'Terminal',signals:{},match:{appBundleId:'com.apple.Terminal'},buttons:[{index:12,type:'page',pageId:'home',label:'Home'},{index:13,type:'auto',label:'Auto'}]},
]};

/** Real host and durable store, with only external device/OS inputs substituted. */
export async function startSimulation(options:SimulationOptions={}):Promise<SimulationHost>{
  const sourceNames=options.sources??['demo'];
  if(!sourceNames.length||new Set(sourceNames).size!==sourceNames.length||sourceNames.some(source=>! /^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)))throw new Error('Invalid simulation sources');
  const sources=Object.fromEntries(sourceNames.map(source=>[source,{token:randomUUID()+randomUUID()}]));
  const validateBoard=(input:PageConfig)=>{
    const result=validatePageConfig(input);
    validatePageSources(result,sourceNames);
    return result;
  };
  let board=validateBoard(options.board??defaultSimulationBoard);
  let latency=options.latencyMs??0,actionResult:'success'|'error'='success';
  const pollMs=options.pollMs??100;
  if(!Number.isFinite(latency)||latency<0||latency>100)throw new Error('Latency must be between 0 and 100 ms');
  if(!Number.isInteger(pollMs)||pollMs<1||pollMs>1000)throw new Error('Invalid simulator poll interval');
  const directory=await mkdtemp(join(tmpdir(),'streamhub-simulator-'));
  const adminToken=randomUUID()+randomUUID();
  const started=performance.now(),events:SimulationEvent[]=[];
  let signalStore:SignalStore|undefined;
  let display:Awaited<ReturnType<typeof startDisplay>>|undefined;
  let runtime:HostRuntime|undefined,generation=0,standby=true,pixels:(Buffer|null)[]=Array(15).fill(null);
  let session:SessionState={active:true,reason:'active'},context:ApplicationContext={appBundleId:null,available:true};
  let sessionCallback:((state:SessionState)=>void)|undefined,contextCallback:((context:ApplicationContext)=>void)|undefined;
  let keyCallback:((index:number,edge:'down'|'up')=>void)|undefined;
  let frame:DeckPage|null=null;
  let stopped=false,stopping:Promise<void>|undefined,restarting:Promise<void>|undefined;
  function emit(body:EventBody){
    const event={...body,at:performance.now()-started,generation} as SimulationEvent;
    if(options.retainEvents!==false)events.push(event);
    // A broken artifact consumer must not affect transport or lifecycle behavior.
    try{options.onEvent?.(event);}catch{}
  }
  function mockActions(){const definitions:Record<string,{exec:string[];args:Record<string,string>;sources:string[]}>=Object.create(null);for(const page of board.pages)for(const button of page.buttons??[])if(button.type==='action'){const names=Object.keys(button.args);definitions[button.name]={exec:['/usr/bin/true',...names.map(name=>`{${name}}`)],args:Object.fromEntries(names.map(name=>[name,'.*'])),sources:sourceNames};}return definitions;}
  async function boot(){
    runtime=await startHost({port:31415,adminToken,sources,actions:mockActions(),streamdeck:{enabled:true,board}},directory,{
      dependencies:{openStore:path=>signalStore=new SignalStore(path),serve:options=>startServer({...options,port:0}),display:async(store,path,displayOptions)=>display=await startDisplay(store,path,{
        ...displayOptions,pollMs,
        execute:async(effect,signal)=>{const result=actionResult;emit({type:'effect',effect,status:'running'});await new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new Error('Cancelled'));return;}const abort=()=>{clearTimeout(timer);reject(new Error('Cancelled'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},100);signal?.addEventListener('abort',abort,{once:true});});emit({type:'effect',effect,status:result,...(result==='error'?{message:'모의 실행 실패'}:{})});if(result==='error')throw new Error('모의 실행 실패');},
        monitor:async callback=>{sessionCallback=callback;callback({...session});return{stop:async()=>{if(sessionCallback===callback)sessionCallback=undefined;}};},
        context:async callback=>{contextCallback=callback;callback({...context});return{stop:async()=>{if(contextCallback===callback)contextCallback=undefined;}};},
        connect:async onKey=>{
          generation++;keyCallback=onKey;let closed=false;emit({type:'connect'});
          const hid=new HidDisplay({
            fillKeyBuffer:async(index,bytes)=>{
              if(latency)await Bun.sleep(latency);
              if(closed)throw new Error('Virtual device is closed');
              pixels[index]=Buffer.from(bytes);standby=false;
              emit({type:'key',index,rgb:Buffer.from(bytes)});
              if(index===14)emit({type:'frame'});
            },
            resetToLogo:async()=>{if(closed)return;standby=true;pixels=Array(15).fill(null);emit({type:'standby'});},
            close:async()=>{if(closed)return;closed=true;if(keyCallback===onKey)keyCallback=undefined;emit({type:'close'});},
          });
          return {write:async(page,signal)=>{frame=structuredClone(page);emit({type:'write-begin',frame:structuredClone(page),aborted:signal.aborted});await hid.write(page,signal);emit({type:'write-end',frame:structuredClone(page),aborted:signal.aborted});},standby:()=>hid.standby(),close:()=>hid.close()};
        },
      })},
    });
  }
  function running(){if(stopped||!runtime||restarting)throw new Error('Simulator is not running');return runtime;}
  async function request<T>(path:string,token:string,method='GET',body?:unknown):Promise<T>{
    const response=await fetch(new URL(path,running().url),{method,signal:AbortSignal.timeout(3000),headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const result=await response.json();
    if(!response.ok)throw new Error(`Simulator HTTP ${response.status}: ${result.error}`);
    return result as T;
  }
  function snapshot():SimulationSnapshot{return{standby,pixels:pixels.map(bytes=>bytes?Buffer.from(bytes):null),generation,frame:frame?structuredClone(frame):null};}
  function stop():Promise<void>{
    if(stopping)return stopping;stopped=true;
    stopping=(async()=>{try{await restarting;await runtime?.stop();}finally{await rm(directory,{recursive:true,force:true});}})();
    return stopping;
  }
  try{await boot();}catch(error){await stop();throw error;}
  const sourceAuth=(source:string)=>{if(!Object.hasOwn(sources,source))throw new Error(`Unknown signal source: ${source}`);return sources[source].token;};
  const upsert=(signal:Omit<SimulationSignal,'source'>,deliveryId=randomUUID(),source=sourceNames[0])=>request<{revision:number}>(`/v1/sources/${source}/signals`,sourceAuth(source),'POST',{deliveryId,signal:{kind:'live',level:'info',...signal}});
  const remove=(id:string,deliveryId=randomUUID(),source=sourceNames[0])=>request<{revision:number}>(`/v1/sources/${source}/signals/${encodeURIComponent(id)}`,sourceAuth(source),'DELETE',{deliveryId});
  return{
    get url(){return running().url.toString();},get device(){return snapshot();},events,snapshot,
    upsert,remove,
    async applyDraft(input,selectedPage){running();const next=validateBoard(input);display!.applyDraft(next,selectedPage);board=next;},
    async selectPage(pageId){running();display!.selectPage(pageId);},
    async auto(){running();display!.auto();},
    markSourceStale(source){running();sourceAuth(source);signalStore!.apply({op:'markStale',source});},
    setActionResult(result){if(result!=='success'&&result!=='error')throw new Error('Invalid action result');actionResult=result;},
    setLatency(ms){running();if(!Number.isFinite(ms)||ms<0||ms>100)throw new Error('Latency must be between 0 and 100 ms');latency=ms;},
    async replaceSignals(records){
      running();if(!Array.isArray(records)||records.length>256)throw new Error('Expected at most 256 simulation records');
      const seen=new Set<string>(),actions=new ActionRegistry();
      const prepared=records.map(record=>{
        const {source=sourceNames[0],...signal}=record;sourceAuth(source);
        const parsed=parseLive({kind:'live',level:'info',...signal},source,actions);
        const key=JSON.stringify([source,parsed.id]);if(seen.has(key))throw new Error('Duplicate simulation signal');seen.add(key);
        return{source,signal:parsed};
      });
      const current=await request<SimulationState>('/v1/state',adminToken);
      for(const record of current.records)if(!seen.has(JSON.stringify([record.source,record.id])))await remove(record.id,undefined,record.source);
      for(const record of prepared)await upsert(record.signal,undefined,record.source);
    },
    state:()=>request('/v1/state',adminToken),
    key(index,edge){running();if(!Number.isInteger(index)||index<0||index>14||(edge!=='down'&&edge!=='up'))throw new Error('Invalid key event');emit({type:'input',index,edge});keyCallback?.(index,edge);},
    setSession(active){running();session={active,reason:active?'active':'locked'};emit({type:'session',active});sessionCallback?.({...session});},
    setContext(appBundleId,available=true,details={}){running();context={appBundleId,available,...details};emit({type:'context',...context});contextCallback?.({...context});},
    restart(){
      if(restarting)return restarting;running();
      restarting=(async()=>{await runtime!.stop();emit({type:'restart'});if(!stopped)await boot();})().finally(()=>{restarting=undefined;});return restarting;
    },stop,
  };
}
