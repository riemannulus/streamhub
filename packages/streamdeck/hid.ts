import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import type { DeckPage } from './index';
import { renderKey } from './render';

type Hardware={fillKeyBuffer(index:number,bytes:Uint8Array,options?:{format:'rgb'}):Promise<void>; resetToLogo():Promise<void>;close():Promise<void>};
/** An owned HID handle; only DisplayLifecycle schedules operations on it. */
export class HidDisplay {
  private closed=false;
  private readonly cache=new Map<string,Buffer>();
  constructor(private readonly hardware:Hardware,private readonly onClosing:()=>void=()=>{}){}
  async write(frame:DeckPage,signal:AbortSignal){
    if(this.closed)throw new Error('HID display is closed');
    if(frame.keys.length!==15)throw new Error('Expected a full 15-key frame');
    for(let index=0;index<15;index++){
      if(signal.aborted || this.closed)return;
      const key=frame.keys[index];
      const hash=JSON.stringify([key,frame.index,frame.pageCount]);
      let bytes=this.cache.get(hash);
      if(!bytes){
        bytes=await renderKey(key,frame);
        this.cache.set(hash,bytes);
        if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
      }
      if(signal.aborted || this.closed)return;
      await this.hardware.fillKeyBuffer(index,bytes,{format:'rgb'});
    }
  }
  async standby(){if(!this.closed)await this.hardware.resetToLogo();}
  async close(){if(this.closed)return;this.closed=true;this.onClosing();this.cache.clear();await this.hardware.close();}
}

export async function openHidDisplay(onKey:(index:number,edge:'down'|'up')=>void,onError:(error:unknown)=>void):Promise<HidDisplay>{
  const devices=await listStreamDecks();
  if(devices.length!==1)throw new Error(`Expected exactly one Stream Deck, found ${devices.length}`);
  const deck=await openStreamDeck(devices[0].path,{resetToLogoOnClose:false});
  let forwarding=true;
  deck.on('error',error=>{if(forwarding)onError(error);});
  const controls=deck.CONTROLS.filter(control=>control.type==='button' && control.feedbackType==='lcd');
  if(controls.length!==15 || controls.some(control=>!('pixelSize' in control) || control.pixelSize.width!==72 || control.pixelSize.height!==72)){
    await deck.close();throw new Error('Streamhub supports 15-key, 72x72 Stream Decks');
  }
  for(const edge of ['down','up'] as const)deck.on(edge,control=>{if(forwarding && control.type==='button')onKey(control.index,edge);});
  return new HidDisplay(deck,()=>{forwarding=false;});
}
