import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {DeckBackend,DeckBackendEvents,DeckBackendStatus,DeckSurface,PreparedPresentation,PresentationRequest} from '../../presentation/backend';
import {HidDisplay,openHidDisplay,type HidPresentation} from '../../streamdeck/hid';
import {DisplayLifecycle,type DisplayDevice} from '../../streamdeck/lifecycle';

type Connector=(onKey:(index:number,phase:'down'|'up')=>void,onError:(error:unknown)=>void)=>Promise<HidDisplay>;
type Stored={request:PresentationRequest;work:HidPresentation};
const publicFailure=(error:unknown)=>{
  const code=typeof error==='object'&&error&&'code' in error?String((error as {code:unknown}).code):'',message=error instanceof Error?error.message:'';
  if(code==='LIBUSB_ERROR_ACCESS'||code==='LIBUSB_ERROR_BUSY'||/LIBUSB_ERROR_(?:ACCESS|BUSY)/.test(message))return 'Stream Deck 앱을 완전히 종료한 뒤 Runtime을 다시 시작하세요.';
  if(/found 0|찾지 못/.test(message))return 'Stream Deck을 찾지 못했습니다.';
  if(/15-key|15-key, 72x72|supports 15-key/.test(message))return '5×3 Stream Deck만 지원합니다.';
  return 'Stream Deck 직접 연결을 시작하지 못했습니다.';
};

export async function startHidBackend(options:{events:DeckBackendEvents;connect?:Connector;onError?:(error:unknown)=>void}):Promise<DeckBackend>{
  const connect=options.connect??openHidDisplay,cache=new Map<string,readonly Buffer[]>();let lifecycle!:DisplayLifecycle<HidPresentation>,current:Stored|undefined,currentToken:string|undefined,activeGeneration:string|undefined,state:DeckBackendStatus['state']='connecting',connected=false,closed=false,stopping:Promise<void>|undefined,message:string|undefined;
  const report=(error:unknown)=>{state='unavailable';connected=false;message=publicFailure(error);try{options.onError?.(error);}catch{}};
  const rgb=async(surface:DeckSurface)=>{
    const found=cache.get(surface.identity);if(found)return found;
    if(surface.keyPngs.length!==15)throw new Error('Expected fifteen key images');
    const keys=await Promise.all(surface.keyPngs.map(async image=>{const result=await sharp(image).removeAlpha().raw().toBuffer({resolveWithObject:true});if(result.info.width!==72||result.info.height!==72||result.info.channels!==3)throw new Error('Expected 72x72 RGB key image');return result.data;}));
    cache.set(surface.identity,keys);if(cache.size>8)cache.delete(cache.keys().next().value!);return keys;
  };
  lifecycle=new DisplayLifecycle<HidPresentation>(async()=>{
    state='connecting';
    try{
      const display=await connect((index,phase)=>{if(lifecycle.noteKey(index,phase)&&activeGeneration)options.events.key({index,phase,generation:activeGeneration});},error=>{report(error);void lifecycle.disconnected();});
      connected=true;message=undefined;
      const device:DisplayDevice<HidPresentation>={write:(work,signal)=>display.write(work,signal),standby:()=>display.standby(),close:async()=>{connected=false;await display.close();}};
      return device;
    }catch(error){report(error);throw error;}
  },{identity:work=>work.identity,releaseAfter:work=>work.releaseAfter===true,onError:report});
  await lifecycle.setAllowed(true);
  const backend:DeckBackend={
    async prepare(request){
      if(closed)throw new Error('HID backend is stopped');
      const [to,from]=await Promise.all([rgb(request.to),request.from?rgb(request.from):Promise.resolve(undefined)]),token=randomUUID().replaceAll('-','');
      currentToken=token;current={request,work:{identity:request.to.identity,generation:request.generation,to,transition:request.transition,...(from?{from}:{}),...(request.reason==='standby'?{releaseAfter:true}:{})}};
      return{backend:'hid',generation:request.generation,token};
    },
    async present(prepared:PreparedPresentation){
      if(prepared.backend!=='hid')throw new Error('Prepared presentation belongs to a different backend');
      if(!current||prepared.token!==currentToken||prepared.generation!==current.request.generation)throw new Error('Prepared presentation is stale');
      const stored=current;current=undefined;currentToken=undefined;state=stored.request.reason==='unlock'||stored.request.reason==='reconnect'?'recovering':'connecting';
      await lifecycle.setAllowed(true);await lifecycle.present(stored.work);
      if(message)return;
      activeGeneration=stored.request.generation;
      if(stored.work.releaseAfter){connected=false;state='connecting';return;}
      state='ready';
    },
    status():DeckBackendStatus{return{mode:'hid',state,connected,...(message?{message}:{})};},
    stop(){if(stopping)return stopping;closed=true;current=undefined;currentToken=undefined;activeGeneration=undefined;cache.clear();stopping=lifecycle.stop();return stopping;},
  };
  return backend;
}
