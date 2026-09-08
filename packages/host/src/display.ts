import { join } from 'node:path';
import { SessionDeck, type DeckLayout } from '../../streamdeck';
import { DisplayLifecycle, type DisplayDevice } from '../../streamdeck/lifecycle';
import { openHidDisplay } from '../../streamdeck/hid';
import { startSessionMonitor, type SessionState } from './session-monitor';
import type { SignalStore } from './store';

type DisplayOptions={
  connect?:(onKey:(index:number,edge:'down'|'up')=>void,onError:(error:unknown)=>void)=>Promise<DisplayDevice>;
  monitor?:(callback:(state:SessionState)=>void)=>Promise<{stop():Promise<void>}>;
  pollMs?:number;
};
const layoutName='streamdeck-v1-15x72';
export async function startDisplay(store:SignalStore,directory:string,options:DisplayOptions={}){
  const deck=new SessionDeck(store.getViewState(layoutName) as DeckLayout|undefined);
  let session:SessionState={active:false,reason:'monitor-unavailable'};
  let stopped=false,lastFrame='',lastLayout='',lastError:string|undefined;
  let dataHealthy=false,requestedAllowed:boolean|undefined;
  let generation=0;
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
      const frame=deck.page();const serialized=JSON.stringify(frame);
      const layout=deck.exportLayout();const layoutJson=JSON.stringify(layout);
      if(layoutJson!==lastLayout){store.setViewState(layoutName,layout);lastLayout=layoutJson;}
      if(serialized!==lastFrame){lastFrame=serialized;void lifecycle.present(frame);}
      dataHealthy=true;
    }catch(error){dataHealthy=false;onError(error);}
    syncAllowed();
  }
  refresh();
  const monitor=await (options.monitor??(callback=>startSessionMonitor(callback,{cacheDir:join(directory,'native')})))(state=>{
    if(stopped)return;
    if(state.active!==session.active || state.reason!==session.reason)console.log(`[display] ${state.reason}`);
    session=state;
    if(!state.active)deck.cancelInput();else refresh();
    syncAllowed();
  });
  const tick=setInterval(refresh,options.pollMs??100);
  const retry=setInterval(()=>{void lifecycle.retry();},2000);
  let stopping:Promise<void>|undefined;
  return {
    status:()=>({session:{...session},inputEnabled:lifecycle.inputEnabled,lastError}),
    stop:()=>{
      if(stopping)return stopping;
      stopped=true;clearInterval(tick);clearInterval(retry);deck.cancelInput();
      stopping=Promise.all([lifecycle.stop(),monitor.stop()]).then(()=>{});
      return stopping;
    },
  };
}
