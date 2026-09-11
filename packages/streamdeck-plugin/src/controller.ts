import {playFramePlan} from '../../presentation/playback';
import {parseRuntimeMessage,type PluginToRuntimeMessage} from '../../presentation/protocol';
import type {PresentationMessage} from './cache';

const HardwareAndSoftware=0,Hardware=1;
type Cell={setImage(image:string,options?:{target?:number}):Promise<unknown>};
type Cache={save(message:PresentationMessage):void;load():PresentationMessage|undefined};

export class CanvasController{
  private cells=new Map<number,Cell>();
  private painted=new Set<number>();
  private generation='offline';
  private input=false;
  private online=false;
  private announced=false;
  private playback?:AbortController;
  private pending?:PresentationMessage;

  constructor(private options:{send(message:PluginToRuntimeMessage):void;cache:Cache;deviceId?:string}){}

  private async ready(){
    if(!this.online||this.cells.size<15||this.painted.size<15)return;
    if(!this.announced){this.announced=true;this.options.send({v:1,type:'cells-ready',deviceId:this.options.deviceId??'streamdeck-classic'});}
    await this.playPending();
  }

  private async playPending(){
    const message=this.pending;
    if(!message||!this.online||this.cells.size<15||this.painted.size<15)return;
    this.pending=undefined;
    this.playback?.abort();
    const controller=this.playback=new AbortController();
    await playFramePlan(message.plan,async frame=>{
      const final=frame.index===message.plan.frames.length-1,target=final?HardwareAndSoftware:Hardware;
      await Promise.all(Array.from({length:15},(_,index)=>this.cells.get(index)!.setImage(frame.keys[index]!,{target})));
      this.options.send({v:1,type:'frame-sent',generation:message.plan.generation,frame:frame.index});
    },{signal:controller.signal});
    if(!controller.signal.aborted)this.input=message.inputEnabled;
  }

  connection(connected:boolean){
    if(this.online===connected)return;
    this.online=connected;
    if(!connected){this.announced=false;this.input=false;this.playback?.abort();return;}
    void this.ready();
  }

  async appear(index:number,cell:Cell){
    if(!Number.isInteger(index)||index<0||index>14)return;
    this.cells.set(index,cell);this.painted.delete(index);
    const cached=this.options.cache.load();
    if(cached){
      const prepared=cached.delivery!=='immediate'&&cached.startKeys;
      await cell.setImage(prepared?cached.startKeys![index]!:cached.plan.frames.at(-1)!.keys[index]!,{target:Hardware});
      if(cached.delivery==='resume')this.pending=cached;
    }
    if(this.cells.get(index)!==cell)return;
    this.painted.add(index);
    await this.ready();
  }

  disappear(index:number,cell:unknown){
    if(this.cells.get(index)!==cell)return;
    this.cells.delete(index);this.painted.delete(index);
    if(this.cells.size===0){this.announced=false;this.input=false;this.playback?.abort();}
  }

  async receive(raw:unknown){
    const message=parseRuntimeMessage(raw);
    if(message.type==='ping'){this.options.send({v:1,type:'pong'});return;}
    if(message.type==='input'){this.input=message.enabled;return;}
    this.options.cache.save(message);
    this.playback?.abort();this.generation=message.plan.generation;this.input=false;
    if(message.delivery==='prepare'){this.pending=undefined;return;}
    this.pending=message;
    await this.playPending();
  }

  key(index:number,phase:'down'|'up'){
    if(this.input&&this.cells.has(index))this.options.send({v:1,type:'key',phase,index,generation:this.generation});
  }
}
