import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node';
import type { DeckPage } from './index';
import { renderKey } from './render';

type Hardware={fillKeyBuffer(index:number,bytes:Uint8Array,options?:{format:'rgb'}):Promise<void>; resetToLogo():Promise<void>;close():Promise<void>};
export const pageIdentity=(page:DeckPage):string=>JSON.stringify([page.viewId ?? 'legacy',page.index]);
type PlaybackOptions={now?:()=>number; wait?:(ms:number,signal:AbortSignal)=>Promise<void>;render?:typeof renderKey};
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{
  if(signal.aborted){resolve();return;}
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
});
/** An owned HID handle; only DisplayLifecycle schedules operations on it. */
export class HidDisplay {
  private closed=false;
  private readonly cache=new Map<string,Buffer>();
  private sent:(Buffer|undefined)[]=Array(15).fill(undefined);
  private identity?:string;
  constructor(private readonly hardware:Hardware,private readonly onClosing:()=>void=()=>{},private readonly playback:PlaybackOptions={}){}
  async write(frame:DeckPage,signal:AbortSignal){
    if(this.closed)throw new Error('HID display is closed');
    if(frame.keys.length!==15)throw new Error('Expected a full 15-key frame');
    const canceled=()=>signal.aborted || this.closed;
    const target:Buffer[]=[];
    for(let index=0;index<15;index++){
      if(canceled())return;
      const key=frame.keys[index];
      const hash=JSON.stringify([key,frame.index,frame.pageCount]);
      let bytes=this.cache.get(hash);
      if(!bytes){
        bytes=await (this.playback.render ?? renderKey)(key,frame);
        this.cache.set(hash,bytes);
        if(this.cache.size>64)this.cache.delete(this.cache.keys().next().value!);
      }
      target.push(bytes);
    }
    if(canceled())return;
    const identity=pageIdentity(frame);
    const animate=this.identity!==undefined && this.identity!==identity && this.sent.every(Boolean) && frame.transition?.type==='fade';
    const from=this.sent.slice() as Buffer[];
    const send=async(buffers:Buffer[])=>{
      for(let index=0;index<15;index++){
        if(canceled())return;
        await this.hardware.fillKeyBuffer(index,buffers[index],{format:'rgb'});
        this.sent[index]=buffers[index];
        this.identity=identity;
      }
    };
    if(animate){
      const duration=frame.transition!.durationMs;
      if(!Number.isFinite(duration) || duration<1 || duration>500)throw new Error('Invalid transition duration');
      const now=this.playback.now ?? (()=>performance.now());
      const started=now();
      // Four intermediate deadlines, never a queue of stale frames. Hardware time
      // counts toward duration; the final exact target still needs one full write.
      for(let step=1;step<5;step++){
        const deadline=duration*step/5;
        if(now()-started>deadline)continue;
        await (this.playback.wait ?? wait)(Math.max(0,deadline-(now()-started)),signal);
        if(canceled())return;
        const progress=Math.min(1,(now()-started)/duration);
        if(progress>=1)break;
        const buffers=(progress<0.5?from:target).map(bytes=>{
          const gain=progress<0.5?1-progress*2:progress*2-1;
          return Buffer.from(bytes.map(value=>Math.round(value*gain)));
        });
        await send(buffers);
        if(canceled())return;
      }
      await (this.playback.wait ?? wait)(Math.max(0,duration-(now()-started)),signal);
    }
    if(canceled())return;
    await send(target);
    if(!canceled())this.identity=identity;
  }
  async standby(){if(!this.closed){await this.hardware.resetToLogo();this.sent=Array(15).fill(undefined);this.identity=undefined;}}
  async close(){if(this.closed)return;this.closed=true;this.onClosing();this.cache.clear();this.sent=[];await this.hardware.close();}
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
