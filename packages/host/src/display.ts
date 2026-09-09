import { join } from 'node:path';
import { SessionDeck, type DeckLayout } from '../../streamdeck';
import { DisplayLifecycle, type DisplayDevice } from '../../streamdeck/lifecycle';
import { openHidDisplay } from '../../streamdeck/hid';
import { startSessionMonitor, type SessionState } from './session-monitor';
import type { SignalStore } from './store';
import { PageBoard, validatePageConfig, type PageBoardLayout, type PageConfig } from '../../streamdeck/pages';
import { startAppContextMonitor, type ApplicationContext } from './app-context';

type DisplayOptions={
  connect?:(onKey:(index:number,edge:'down'|'up')=>void,onError:(error:unknown)=>void)=>Promise<DisplayDevice>;
  monitor?:(callback:(state:SessionState)=>void)=>Promise<{stop():Promise<void>}>;
  pollMs?:number;
  signal?:AbortSignal;
  board?:PageConfig;
  context?:(callback:(value:ApplicationContext)=>void)=>Promise<{stop():Promise<void>}>;
};
export async function startDisplay(store:SignalStore,directory:string,options:DisplayOptions={}){
  const cancelled=()=>new DOMException('Display startup was cancelled','AbortError');
  if(options.signal?.aborted)throw cancelled();
  const layoutName=options.board?'streamdeck-pages-v1-15x72':'streamdeck-v1-15x72';
  let config=options.board;
  let board=options.board?new PageBoard(options.board,store.getViewState(layoutName) as PageBoardLayout|undefined):undefined;
  let deck=board??new SessionDeck(store.getViewState(layoutName) as DeckLayout|undefined);
  let context:ApplicationContext={available:false,appBundleId:null};
  let session:SessionState={active:false,reason:'monitor-unavailable'};
  let stopped=false,lastFrame='',lastLayout='',lastError:string|undefined;
  let dataHealthy=false,requestedAllowed:boolean|undefined;
  let generation=0;
  let monitor:{stop():Promise<void>}|undefined;
  let monitorStarting:Promise<{stop():Promise<void>}>|undefined;
  let tick:ReturnType<typeof setInterval>|undefined,retry:ReturnType<typeof setInterval>|undefined;
  let stopping:Promise<void>|undefined;
  let rejectStartup:((error:unknown)=>void)|undefined;
  const onError=(error:unknown)=>{lastError=String(error);deck.cancelInput();console.error('[display]',lastError);};
  let lifecycle:DisplayLifecycle;
  const key=(index:number,edge:'down'|'up')=>{
    if(!lifecycle.noteKey(index,edge)){
      if(edge==='up')deck.cancelInput(index);
      return;
    }
    if(edge==='down')deck.down(index);
    else {
      const intent=deck.up(index);
      // Focus/open/approval remain disabled until target validation is implemented.
      if(intent?.type==='navigate')refresh();
    }
  };
  lifecycle=new DisplayLifecycle(()=> {
    const connection=++generation;
    return (options.connect??openHidDisplay)((index,edge)=>{if(connection===generation && !stopped)key(index,edge);},error=>{
      if(connection!==generation || stopped)return;
      onError(error);void lifecycle.disconnected();
    });
  },{onError});
  function syncAllowed(){
    const allowed=session.active && dataHealthy;
    if(allowed===requestedAllowed)return;
    requestedAllowed=allowed;
    void lifecycle.setAllowed(allowed);
  }
  function refresh(){
    if(stopped)return;
    try {
      deck.update(store.records());
      if(session.active)board?.context(context,performance.now());
      const frame=deck.page();const serialized=JSON.stringify(frame);
      const layout=deck.exportLayout();const layoutJson=JSON.stringify(layout);
      if(layoutJson!==lastLayout){store.setViewState(layoutName,layout);lastLayout=layoutJson;}
      if(serialized!==lastFrame){lastFrame=serialized;void lifecycle.present(frame);}
      dataHealthy=true;
    }catch(error){dataHealthy=false;onError(error);}
    syncAllowed();
  }
  function stop():Promise<void>{
    if(stopping)return stopping;
    stopped=true;clearInterval(tick);clearInterval(retry);deck.cancelInput();
    options.signal?.removeEventListener('abort',abort);
    const stopMonitor=async()=>{
      if(monitorStarting){try{monitor=await monitorStarting;}catch{}}
      await monitor?.stop();
    };
    stopping=Promise.allSettled([lifecycle.stop(),stopMonitor()]).then(results=>{
      const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
      if(errors.length)throw new AggregateError(errors,'Display cleanup failed');
    });
    return stopping;
  }
  const abort=()=>{rejectStartup?.(cancelled());void stop().catch(onError);};
  options.signal?.addEventListener('abort',abort,{once:true});
  const cancelledStartup=new Promise<never>((_resolve,reject)=>{rejectStartup=reject;});
  refresh();
  monitorStarting=Promise.resolve().then(async()=>{
    if(stopped)throw cancelled();
    const sessionMonitor=await (options.monitor??(callback=>startSessionMonitor(callback,{cacheDir:join(directory,'native')})))(state=>{
    if(stopped)return;
    if(state.active!==session.active || state.reason!==session.reason)console.log(`[display] ${state.reason}`);
    session=state;
    if(!state.active)deck.cancelInput();else refresh();
    syncAllowed();
    });
    if(stopped || (!options.context && !options.board?.pages.some(page=>page.match)))return sessionMonitor;
    try{
      const contextMonitor=await (options.context??(callback=>startAppContextMonitor(callback,{cacheDir:join(directory,'native')})))(value=>{
        if(stopped)return;
        context=value;
        refresh();
      });
      return{stop:async()=>{
        const results=await Promise.allSettled([Promise.resolve().then(()=>sessionMonitor.stop()),Promise.resolve().then(()=>contextMonitor.stop())]);
        const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
        if(errors.length)throw new AggregateError(errors,'Session/context cleanup failed');
      }};
    }catch(error){
      try{await sessionMonitor.stop();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Context startup and cleanup failed');}
      throw error;
    }
  });
  try{
    monitor=await Promise.race([monitorStarting,cancelledStartup]);
    if(options.signal?.aborted)throw cancelled();
  }catch(error){
    // Disable callbacks immediately, then wait for bounded monitor startup and
    // cleanup so process exit cannot leave a native compiler/helper behind.
    try{await stop();}catch(cleanupError){throw new AggregateError([error,cleanupError],'Display startup and cleanup failed');}
    throw error;
  }
  rejectStartup=undefined;
  tick=setInterval(refresh,options.pollMs??100);
  retry=setInterval(()=>{void lifecycle.retry();},2000);
  function replaceBoard(input:PageConfig,selectedPage?:string,manual?:boolean){
    if(stopped)throw new Error('Display is stopped');
    if(!board)throw new Error('Page editing requires a configured page board');
    const next=validatePageConfig(input),layout=board.exportLayout();
    const current=selectedPage??(next.pages.some(page=>page.id===layout.currentPage)?layout.currentPage:next.defaultPage);
    if(!next.pages.some(page=>page.id===current))throw new Error(`Unknown page: ${current}`);
    const replacement=new PageBoard(next,{...layout,currentPage:current,manual:manual??(selectedPage!==undefined?true:layout.manual)});
    deck.cancelInput();config=next;board=replacement;deck=replacement;lastFrame='';refresh();
  }
  return {
    applyDraft:(input:PageConfig,selectedPage?:string)=>replaceBoard(input,selectedPage),
    selectPage:(pageId:string)=>replaceBoard(config!,pageId,true),
    auto:()=>replaceBoard(config!,undefined,false),
    status:()=>({session:{...session},inputEnabled:lifecycle.inputEnabled,lastError,...(board?{pageId:board.page().viewId,selectionReason:board.selectionReason(),manual:board.exportLayout().manual,context:{...context}}:{})}),
    stop,
  };
}
