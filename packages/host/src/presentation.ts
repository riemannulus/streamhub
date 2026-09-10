import type {ButtonEffect} from '../../streamdeck';
import {PageBoard,studioDocumentToPageConfig,type PageContext} from '../../streamdeck/pages';
import type {PluginToRuntimeMessage,PresentationTrigger,RuntimeToPluginMessage} from '../../presentation/protocol';
import {DeckVisualRenderer} from '../../presentation/render';
import {TransitionCompiler} from '../../presentation/transitions';
import {StudioRepository,type StudioSnapshot} from '../../studio/repository';
import type {StudioDocument} from '../../studio/document';
import type {SignalStore} from './store';

type Gateway={publish(message:RuntimeToPluginMessage):void;status():{connected:boolean;deviceId?:string}};
export type PresentationService={message(message:PluginToRuntimeMessage):Promise<void>;context(context:PageContext,now?:number):Promise<void>;refresh(trigger?:PresentationTrigger):Promise<void>;apply(document:StudioDocument,expectedVersion:string):Promise<StudioSnapshot>;snapshot():StudioSnapshot;status():{connected:boolean;deviceId?:string;locked:boolean;generation?:string};stop():Promise<void>};

function publicFailure(error:unknown):string{
  if(error&&typeof error==='object'&&'code' in error){
    const code=(error as {code?:unknown}).code;
    if(code==='accessibility-permission-required')return '손쉬운 사용 권한 필요';
    if(code==='media-unsupported')return '미디어 키 미지원';
    if(code==='timeout')return '시간 초과';
  }
  return '실행 실패';
}

export async function startPresentationService(options:{store:SignalStore;directory:string;gateway:Gateway;execute(effect:ButtonEffect,signal?:AbortSignal):Promise<void>}):Promise<PresentationService>{
  const repository=new StudioRepository(options.directory),renderer=new DeckVisualRenderer(),compiler=new TransitionCompiler(),executions=new Set<AbortController>();
  let snapshot=repository.snapshot(),board=new PageBoard(studioDocumentToPageConfig(snapshot.document)),canvas:Buffer|undefined,generation=0,currentGeneration:string|undefined,locked=false,closed=false,revision=options.store.state().revision,polling=false;
  board.update(options.store.records());
  const cancelExecutions=()=>{for(const controller of executions)controller.abort();};
  const renderLive=async()=>{
    board.update(options.store.records());const deck=board.page(),page=snapshot.document.pages.find(item=>item.id===deck.viewId)??snapshot.document.pages.find(item=>item.id===snapshot.document.defaultPageId)!;
    return renderer.render(snapshot.document,page,deck,repository.assets);
  };
  const publish=async(trigger:PresentationTrigger,spec=snapshot.document.motion.pageChange)=>{
    if(closed)return;
    const target=trigger==='standby'?await renderer.renderStandby(snapshot.document,repository.assets):await renderLive(),from=canvas??target.png;canvas=target.png;
    const plan=await compiler.compile(from,target.png,trigger==='initial'||trigger==='refresh'||trigger==='standby'?{type:'none',durationMs:0}:spec,`g${++generation}`);
    currentGeneration=plan.generation;options.gateway.publish({v:1,type:'presentation',trigger,plan,inputEnabled:!locked});
  };
  const execute=async(intent:Extract<ReturnType<PageBoard['up']>,{type:'button-effect'|'effect'}>)=>{
    const controller=new AbortController();executions.add(controller);
    try{
      await options.execute(intent.effect,controller.signal);
      if(!controller.signal.aborted&&!closed&&intent.type==='button-effect')board.setActionStatus(intent.pageId,intent.index,'success');
    }catch(error){
      if(!controller.signal.aborted&&!closed&&intent.type==='button-effect')board.setActionStatus(intent.pageId,intent.index,'error',publicFailure(error));
    }finally{executions.delete(controller);}
    if(!controller.signal.aborted&&!locked&&!closed)await publish('refresh');
  };
  const timer=setInterval(()=>{
    if(closed||polling)return;const next=options.store.state().revision;if(next===revision)return;revision=next;board.update(options.store.records());
    if(!locked){polling=true;void publish('refresh').finally(()=>{polling=false;});}
  },100);
  const service:PresentationService={
    async message(message){
      if(closed)return;
      if(message.type==='lock'){
        locked=message.locked;board.cancelInput();if(locked)cancelExecutions();await publish(locked?'standby':'unlock',snapshot.document.motion.unlock);return;
      }
      if(message.type==='cells-ready'){await publish('reconnect',snapshot.document.motion.reconnect);return;}
      if(message.type!=='key'||message.generation!==currentGeneration||locked)return;
      if(message.phase==='down'){board.down(message.index);return;}
      const intent=board.up(message.index);if(!intent)return;
      if(intent.type==='button-effect'||intent.type==='effect'){await execute(intent);return;}
      await publish('page');
    },
    async context(value,now=Date.now()){board.context(value,now);if(!locked)await publish('page');},
    refresh:async(trigger='refresh')=>publish(trigger),
    async apply(document,expectedVersion){cancelExecutions();snapshot=repository.apply(document,expectedVersion);board.cancelInput();board=new PageBoard(studioDocumentToPageConfig(snapshot.document));board.update(options.store.records());await publish('page');return snapshot;},
    snapshot:()=>structuredClone(snapshot),
    status:()=>({...options.gateway.status(),locked,...(currentGeneration?{generation:currentGeneration}:{})}),
    async stop(){closed=true;clearInterval(timer);cancelExecutions();board.cancelInput();},
  };
  await publish('initial');return service;
}
