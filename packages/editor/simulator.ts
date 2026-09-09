import { validatePageConfig, type PageConfig } from '../streamdeck/pages';
import {startSimulation, type SimulationHost, type SimulationEvent} from '../simulator/host';

export type SimulatorEvent =
  | { type:'key'; index:number; rgb:string }
  | { type:'standby' }
  | { type:'state'; pageId:string; manual:boolean; locked:boolean; inputEnabled:boolean; latencyMs:number; frames:number; keysSent:number; lastFrameMs:number; selectionReason?:string }
  | { type:'error'; message:string };

export function validateSimulatorBoard(raw:unknown,sources:readonly string[]):PageConfig {
  const board=validatePageConfig(raw);
  for(const page of board.pages)if(page.signals?.source && !sources.includes(page.signals.source))throw new Error(`Unknown signal source: ${page.signals.source}`);
  return board;
}
const object=(raw:unknown):Record<string,unknown>=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Expected simulator command');
  return raw as Record<string,unknown>;
};
const integer=(value:unknown,min:number,max:number)=>{
  if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new Error(`Expected integer ${min}–${max}`);
  return value;
};
const labels=['권한 확인 대기','코드 리뷰 진행','테스트 통과','배포 준비','문서 작성','빌드 실패','작업 완료','입력 대기'];

export function sampleSignals(count:number,sources:readonly string[]) {
  if(!sources.length)return [];
  return Array.from({length:count},(_,index)=>({source:sources[index%sources.length],id:`sample-${index+1}`,
    level:index%8===5?'urgent' as const:index%8===0?'warn' as const:'info' as const,label:`${labels[index%labels.length]} ${index+1}`}));
}

/** Browser protocol adapter over the same real HTTP/store/display runtime used by headless checks. */
export class SimulatorSession {
  private host?:SimulationHost;
  private readonly ready:Promise<void>;
  private tail:Promise<void>=Promise.resolve();
  private tick?:ReturnType<typeof setInterval>;
  private stopped=false;
  private stopping?:Promise<void>;
  private locked=false;
  private latencyMs=0;
  private frames=0;
  private keysSent=0;
  private lastFrameMs=0;
  private frameStarted=0;
  private lastState='';
  private polling=false;
  constructor(board:PageConfig,private readonly sources:string[],private readonly emit:(event:SimulatorEvent)=>void){
    const config=validateSimulatorBoard(board,sources);
    this.ready=(async()=>{
      this.host=await startSimulation({retainEvents:false,board:config,sources:sources.length?sources:['demo'],onEvent:event=>this.event(event)});
      if(this.stopped){await this.host.stop();return;}
      await this.host.replaceSignals(sampleSignals(16,sources));
      if(this.stopped)return;
      this.tick=setInterval(()=>{void this.state();},50);
      await this.state();
    })().catch(async error=>{await this.host?.stop();throw error;});
    void this.ready.catch(()=>this.send({type:'error',message:'Could not start simulator'}));
  }
  private send(event:SimulatorEvent){if(!this.stopped){try{this.emit(event);}catch{}}}
  private event(event:SimulationEvent){
    if(event.type==='key'){
      if(event.index===0)this.frameStarted=event.at;
      this.keysSent++;this.send({type:'key',index:event.index,rgb:event.rgb.toString('base64')});
    }else if(event.type==='frame'){
      this.frames++;this.lastFrameMs=Math.round(event.at-this.frameStarted);
    }else if(event.type==='standby')this.send({type:'standby'});
  }
  private async state(){
    if(this.stopped||!this.host||this.polling)return;
    this.polling=true;
    try{
      const {display}=await this.host.state();
      const event:SimulatorEvent={type:'state',pageId:display.pageId??'',manual:display.manual??false,locked:this.locked,inputEnabled:display.inputEnabled,
        latencyMs:this.latencyMs,frames:this.frames,keysSent:this.keysSent,lastFrameMs:this.lastFrameMs,selectionReason:display.selectionReason};
      const serialized=JSON.stringify(event);
      if(serialized!==this.lastState){this.lastState=serialized;this.send(event);}
    }catch{if(!this.stopped)this.send({type:'error',message:'Could not read simulator state'});}
    finally{this.polling=false;}
  }
  command(raw:unknown):Promise<void>{
    if(this.stopped)return Promise.reject(new Error('Simulator is stopped'));
    const operation=this.tail.then(async()=>{
      await this.ready;
      if(this.stopped)throw new Error('Simulator is stopped');
      const command=object(raw),host=this.host!;
      switch(command.type){
        case 'draft':{
          const board=validateSimulatorBoard(command.board,this.sources);
          if(command.selectedPage!==undefined&&typeof command.selectedPage!=='string')throw new Error('Invalid selected page');
          await host.applyDraft(board,command.selectedPage as string|undefined);break;
        }
        case 'page':if(typeof command.pageId!=='string')throw new Error('Invalid page ID');await host.selectPage(command.pageId);break;
        case 'auto':await host.auto();break;
        case 'context':
          if(typeof command.available!=='boolean'||(command.appBundleId!==null&&(typeof command.appBundleId!=='string'||command.appBundleId.length>255)))throw new Error('Invalid application context');
          for(const field of ['windowTitle','displayId'])if(command[field]!==undefined&&command[field]!==null&&(typeof command[field]!=='string'||(command[field] as string).length>512))throw new Error('Invalid window context');host.setContext(command.appBundleId as string|null,command.available,{windowTitle:command.windowTitle as string|null|undefined,displayId:command.displayId as string|null|undefined});break;
        case 'lock':
          if(typeof command.locked!=='boolean')throw new Error('Invalid lock state');
          this.locked=command.locked;host.setSession(!this.locked);break;
        case 'latency':this.latencyMs=integer(command.ms,0,100);host.setLatency(this.latencyMs);break;
        case 'signals':await host.replaceSignals(sampleSignals(integer(command.count,0,48),this.sources));break;
        case 'key':{
          const index=integer(command.index,0,14);
          if(command.edge!=='down'&&command.edge!=='up')throw new Error('Invalid key edge');
          host.key(index,command.edge);break;
        }
        default:throw new Error('Unknown simulator command');
      }
      await this.state();
    });
    this.tail=operation.catch(()=>{});
    return operation;
  }
  stop():Promise<void>{
    if(this.stopping)return this.stopping;
    this.stopped=true;clearInterval(this.tick);
    this.stopping=(async()=>{try{await this.ready;}catch{}await this.tail;await this.host?.stop();})();
    return this.stopping;
  }
}
