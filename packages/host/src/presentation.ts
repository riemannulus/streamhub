import type {ButtonEffect} from '../../streamdeck';
import {PageBoard,studioDocumentToPageConfig,type PageContext} from '../../streamdeck/pages';
import {createGestureRecognizer,type Gesture} from '../../streamdeck/gestures';
import type {PluginToRuntimeMessage,PresentationTrigger,RuntimeToPluginMessage} from '../../presentation/protocol';
import {DeckVisualRenderer,type DeckCanvas} from '../../presentation/render';
import type {FramePlan} from '../../presentation/playback';
import {TransitionCompiler} from '../../presentation/transitions';
import {StudioRepository,type StudioSnapshot} from '../../studio/repository';
import {primaryButtonAction,type ActionProgram,type ButtonAction,type ButtonDefinition,type StudioDocument} from '../../studio/document';
import {executeProgram,type ActionResult,type ProgramContext} from '../../actions/composite';
import {MemoryButtonStateStore,buttonStateKey,type ButtonStateStore} from './button-state';
import type {SignalStore} from './store';

type Gateway={publish(message:RuntimeToPluginMessage):void;status():{connected:boolean;deviceId?:string}};
export type PresentationService={message(message:PluginToRuntimeMessage):Promise<void>;disconnect():void;context(context:PageContext,now?:number):Promise<void>;refresh(trigger?:PresentationTrigger):Promise<void>;apply(document:StudioDocument,expectedVersion:string):Promise<StudioSnapshot>;snapshot():StudioSnapshot;status():{connected:boolean;deviceId?:string;locked:boolean;generation?:string};stop():Promise<void>};

function publicFailure(error:unknown):string{
  if(error&&typeof error==='object'&&'code' in error){
    const code=(error as {code?:unknown}).code;
    if(code==='accessibility-permission-required')return '손쉬운 사용 권한 필요';
    if(code==='media-unsupported')return '미디어 키 미지원';
    if(code==='timeout')return '시간 초과';
  }
  return '실행 실패';
}

export async function startPresentationService(options:{store:SignalStore;directory:string;gateway:Gateway;execute(effect:ButtonEffect,signal?:AbortSignal):Promise<void>;buttonState?:ButtonStateStore;now?:()=>number;schedule?:(delayMs:number,callback:()=>void)=>{cancel():void};sleep?:ProgramContext['sleep']}):Promise<PresentationService>{
  const repository=new StudioRepository(options.directory),renderer=new DeckVisualRenderer(),compiler=new TransitionCompiler(),executions=new Set<AbortController>(),buttonState=options.buttonState??new MemoryButtonStateStore();
  type PreparedUnlock={plan:FramePlan;startKeys:readonly string[];target:Buffer;revision:number};
  let snapshot=repository.snapshot(),board=new PageBoard(studioDocumentToPageConfig(snapshot.document)),canvas:Buffer|undefined,standby:DeckCanvas|undefined,preparedUnlock:PreparedUnlock|undefined,generation=0,currentGeneration:string|undefined,recoveringGeneration:string|undefined,lifecycle=0,locked=false,closed=false,revision=options.store.state().revision,polling=false;
  const validStateKeys=()=>new Set(snapshot.document.pages.flatMap(page=>(page.buttons??[]).map(button=>buttonStateKey({documentId:snapshot.document.id,pageId:page.id,buttonId:button.id}))));
  await buttonState.prune(validStateKeys());
  board.update(options.store.records());
  const cancelExecutions=()=>{for(const controller of executions)controller.abort();board.clearRunningActionStatuses();};
  const currentButton=(index:number)=>{const pageId=board.page().viewId??snapshot.document.defaultPageId,page=snapshot.document.pages.find(item=>item.id===pageId);return{pageId,button:page?.buttons?.find(item=>item.index===index)};};
  const navigation=(action:ButtonAction):action is Extract<ButtonAction,{type:'go-to-page'|'previous-page'|'next-page'|'resume-auto-page'}>=>['go-to-page','previous-page','next-page','resume-auto-page'].includes(action.type);
  const effect=(action:ButtonAction):ButtonEffect|undefined=>action.type==='open-app'?{type:'app',bundleId:action.bundleId}:action.type==='open-path'?{type:'path',path:action.path}:action.type==='open-url'?{type:'open',url:action.url,...(action.browserBundleId?{browserBundleId:action.browserBundleId}:{})}:action.type==='hotkey'?{type:'hotkey',keys:action.keys}:action.type==='text'?action:action.type==='media'?action:action.type==='registered'?{type:'action',name:action.name,args:action.args}:undefined;
  const executable=(program:ActionProgram|undefined)=>!!program&&(program.type!=='single'||!['none','page-indicator'].includes(program.action.type));
  let immediateGesture:Promise<void>|undefined;
  const renderLive=async()=>{
    board.update(options.store.records());const deck=board.page(),page=snapshot.document.pages.find(item=>item.id===deck.viewId)??snapshot.document.pages.find(item=>item.id===snapshot.document.defaultPageId)!;
    return renderer.render(snapshot.document,page,deck,repository.assets,{toggle:(pageId,buttonId)=>buttonState.getToggle({documentId:snapshot.document.id,pageId,buttonId})});
  };
  const publish=async(trigger:PresentationTrigger,spec=snapshot.document.motion.pageChange,provided?:DeckCanvas)=>{
    if(closed)return;
    gestures.accept({type:'cancel-all',reason:trigger,at:(options.now??Date.now)()});cancelExecutions();
    const target=provided??(trigger==='standby'?await renderer.renderStandby(snapshot.document,repository.assets):await renderLive()),from=canvas??target.png;canvas=target.png;
    const plan=await compiler.compile(from,target.png,trigger==='initial'||trigger==='refresh'||trigger==='standby'?{type:'none',durationMs:0}:spec,`g${++generation}`);
    currentGeneration=plan.generation;recoveringGeneration=undefined;
    if(trigger!=='standby'){standby=undefined;preparedUnlock=undefined;}
    options.gateway.publish({v:1,type:'presentation',trigger,delivery:'immediate',plan,inputEnabled:!locked});
  };
  const buildUnlock=async(start:DeckCanvas):Promise<PreparedUnlock>=>{
    const preparedRevision=revision,target=await renderLive(),plan=await compiler.compile(start.png,target.png,snapshot.document.motion.unlock,`g${++generation}`);
    return{plan,startKeys:start.keys,target:target.png,revision:preparedRevision};
  };
  const prepareWhileLocked=async(epoch:number)=>{
    const start=standby??await renderer.renderStandby(snapshot.document,repository.assets),prepared=await buildUnlock(start);
    if(closed||!locked||epoch!==lifecycle)return;
    standby=start;preparedUnlock=prepared;
    options.gateway.publish({v:1,type:'presentation',trigger:'unlock',delivery:'prepare',plan:prepared.plan,startKeys:prepared.startKeys,inputEnabled:false});
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
  const executeBehavior=async(pageId:string,button:ButtonDefinition,program:ActionProgram)=>{
    const stateKey={documentId:snapshot.document.id,pageId,buttonId:button.id},toggle=program.type==='toggle'?(buttonState.getToggle(stateKey)??program.initial):undefined,resolved=program.type==='toggle'?{...program,initial:toggle!}:program;
    const singleNavigation=program.type==='single'&&navigation(program.action);
    if(!singleNavigation){board.setActionStatus(pageId,button.index,'running');await publish('refresh');}
    if(locked||closed)return;const controller=new AbortController();executions.add(controller);let result:ActionResult,navigated=false;
    try{result=await executeProgram(resolved,{signal:controller.signal,...(options.sleep?{sleep:options.sleep}:{}),run:async(action,signal)=>{
      if(navigation(action)){const moved=board.navigateAction(action);navigated ||= moved;return moved?{ok:true}:{ok:false,code:'navigation-unavailable',message:'Page navigation is unavailable'};}
      const mapped=effect(action);if(!mapped)return{ok:false,code:'not-executable',message:'Action is not executable'};
      try{await options.execute(mapped,signal);return{ok:true};}catch(error){return{ok:false,code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'execution-failed',message:publicFailure(error)};}
    }});}finally{executions.delete(controller);}
    if(controller.signal.aborted||closed||locked)return;
    if(result!.ok&&toggle)try{await buttonState.setToggle(stateKey,toggle==='off'?'on':'off');}catch{result={ok:false,code:'state-write-failed',message:'토글 상태를 저장하지 못했습니다.'};}
    if(navigated){await publish('page');return;}
    const current=currentButton(button.index);if(current.pageId!==pageId||current.button?.id!==button.id)return;
    if(!singleNavigation)board.setActionStatus(pageId,button.index,result!.ok?'success':'error',result!.ok?undefined:result!.message);
    await publish('refresh');
  };
  const gestures=createGestureRecognizer({
    schedule:options.schedule??((delay,callback)=>{const timer=setTimeout(callback,delay);return{cancel:()=>clearTimeout(timer)};}),
    resolve:(key,revision)=>{if(revision!==generation)return;const {button}=currentButton(key);if(!button)return;return{press:executable(button.behavior.press),doublePress:executable(button.behavior.doublePress),hold:executable(button.behavior.hold),doublePressMs:button.behavior.doublePressMs,holdMs:button.behavior.holdMs};},
    emit:(key,revision,gesture:Gesture)=>{if(revision!==generation||locked||closed)return;const {pageId,button}=currentButton(key);if(!button)return;const program=gesture==='press'?button.behavior.press:gesture==='double-press'?button.behavior.doublePress:button.behavior.hold;if(!program)return;const task=executeBehavior(pageId,button,program);immediateGesture=task;void task.catch(()=>{});},
  });
  const timer=setInterval(()=>{
    if(closed||polling)return;const next=options.store.state().revision;if(next===revision)return;revision=next;board.update(options.store.records());
    polling=true;const task=locked?prepareWhileLocked(lifecycle):publish('refresh');void task.finally(()=>{polling=false;});
  },100);
  const service:PresentationService={
    async message(message){
      if(closed)return;
      if(message.type==='lock'){
        if(locked===message.locked)return;
        locked=message.locked;const epoch=++lifecycle;board.cancelInput();gestures.accept({type:'cancel-all',reason:'lock',at:(options.now??Date.now)()});
        if(locked){
          cancelExecutions();preparedUnlock=undefined;recoveringGeneration=undefined;
          const target=await renderer.renderStandby(snapshot.document,repository.assets);if(closed||!locked||epoch!==lifecycle)return;
          standby=target;await publish('standby',snapshot.document.motion.unlock,target);if(closed||!locked||epoch!==lifecycle)return;
          await prepareWhileLocked(epoch);return;
        }
        const next=options.store.state().revision;if(next!==revision){revision=next;board.update(options.store.records());}
        const start=standby??await renderer.renderStandby(snapshot.document,repository.assets);
        const prepared=preparedUnlock?.revision===revision?preparedUnlock:await buildUnlock(start);
        if(closed||locked||epoch!==lifecycle)return;
        canvas=prepared.target;currentGeneration=prepared.plan.generation;recoveringGeneration=prepared.plan.generation;preparedUnlock=prepared;
        options.gateway.publish({v:1,type:'presentation',trigger:'unlock',delivery:'resume',plan:prepared.plan,startKeys:prepared.startKeys,inputEnabled:true});return;
      }
      if(message.type==='frame-sent'){if(message.generation===recoveringGeneration&&message.frame===preparedUnlock!.plan.frames.length-1)recoveringGeneration=undefined;return;}
      if(message.type==='cells-ready'){if(locked||recoveringGeneration)return;await publish('reconnect',snapshot.document.motion.reconnect);return;}
      if(message.type!=='key'||message.generation!==currentGeneration||locked)return;
      const fixed=currentButton(message.index).button;
      if(fixed){immediateGesture=undefined;gestures.accept({type:message.phase,key:message.index,bindingRevision:generation,at:(options.now??Date.now)()});const task=immediateGesture;if(task)await task;return;}
      if(message.phase==='down'){board.down(message.index);return;}
      const intent=board.up(message.index);if(!intent)return;
      if(intent.type==='button-effect'||intent.type==='effect'){await execute(intent);return;}
      await publish('page');
    },
    disconnect(){gestures.accept({type:'cancel-all',reason:'disconnect',at:(options.now??Date.now)()});cancelExecutions();board.cancelInput();},
    async context(value,now=Date.now()){board.context(value,now);if(!locked)await publish('page');},
    refresh:async(trigger='refresh')=>publish(trigger),
    async apply(document,expectedVersion){gestures.accept({type:'cancel-all',reason:'apply',at:(options.now??Date.now)()});cancelExecutions();snapshot=repository.apply(document,expectedVersion);await buttonState.prune(validStateKeys());board.cancelInput();board=new PageBoard(studioDocumentToPageConfig(snapshot.document));board.update(options.store.records());await publish('page');return snapshot;},
    snapshot:()=>structuredClone(snapshot),
    status:()=>({...options.gateway.status(),locked,...(currentGeneration?{generation:currentGeneration}:{})}),
    async stop(){closed=true;clearInterval(timer);gestures.accept({type:'cancel-all',reason:'stop',at:(options.now??Date.now)()});cancelExecutions();board.cancelInput();},
  };
  await publish('initial');return service;
}
