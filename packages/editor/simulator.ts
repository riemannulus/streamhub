import { PageBoard, validatePageConfig, type PageConfig, type PageContext } from '../streamdeck/pages';
import { DisplayLifecycle } from '../streamdeck/lifecycle';
import { HidDisplay } from '../streamdeck/hid';
import type { SessionRecord } from '../streamdeck';

export type SimulatorEvent =
  | { type:'key'; index:number; rgb:string }
  | { type:'standby' }
  | { type:'state'; pageId:string; manual:boolean; locked:boolean; inputEnabled:boolean; latencyMs:number; frames:number; keysSent:number; lastFrameMs:number }
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

/** Private synthetic data and fake transport; never opens HID or native monitors. */
export class SimulatorSession {
  private config:PageConfig;
  private board:PageBoard;
  private readonly lifecycle:DisplayLifecycle;
  private readonly tick:ReturnType<typeof setInterval>;
  private context:PageContext={available:true,appBundleId:null};
  private records:SessionRecord[]=[];
  private locked=false;
  private latencyMs=0;
  private frames=0;
  private keysSent=0;
  private lastFrameMs=0;
  private lastFrame='';
  private lastState='';
  private stopped=false;
  private stopping?:Promise<void>;
  constructor(board:PageConfig,private readonly sources:string[],private readonly emit:(event:SimulatorEvent)=>void){
    this.config=validateSimulatorBoard(board,sources);
    this.board=new PageBoard(this.config);
    this.seed(16);
    this.lifecycle=new DisplayLifecycle(async()=>{
      let closed=false,frameStarted=performance.now();
      return new HidDisplay({
        fillKeyBuffer:async(index,bytes)=>{
          if(index===0)frameStarted=performance.now();
          if(this.latencyMs)await new Promise(resolve=>setTimeout(resolve,this.latencyMs));
          if(closed||this.stopped)return;
          this.keysSent++;
          this.send({type:'key',index,rgb:Buffer.from(bytes).toString('base64')});
          if(index===14){this.frames++;this.lastFrameMs=Math.round(performance.now()-frameStarted);this.state();}
        },
        resetToLogo:async()=>{if(!closed)this.send({type:'standby'});},
        close:async()=>{closed=true;},
      });
    },{timeoutMs:5000,onError:error=>this.send({type:'error',message:String(error)})});
    this.refresh();
    void this.lifecycle.setAllowed(true);
    this.tick=setInterval(()=>this.refresh(),50);
    this.state();
  }
  private send(event:SimulatorEvent){if(!this.stopped){try{this.emit(event);}catch{/* Disconnected consumers cannot break cleanup. */}}}
  private seed(count:number){
    const sources=this.sources.length?this.sources:['demo'];
    this.records=Array.from({length:count},(_,index)=>({source:sources[index%sources.length],id:`sample-${index+1}`,kind:'live',
      level:index%8===5?'urgent':index%8===0?'warn':'info',label:`${labels[index%labels.length]} ${index+1}`,
      revision:1,createdAt:index,updatedAt:index,freshness:index%11===10?'stale':'fresh'}));
  }
  private state(){
    const layout=this.board.exportLayout();
    const event:SimulatorEvent={type:'state',pageId:layout.currentPage,manual:layout.manual,locked:this.locked,inputEnabled:this.lifecycle.inputEnabled,
      latencyMs:this.latencyMs,frames:this.frames,keysSent:this.keysSent,lastFrameMs:this.lastFrameMs};
    const serialized=JSON.stringify(event);
    if(serialized!==this.lastState){this.lastState=serialized;this.send(event);}
  }
  private refresh(){
    if(this.stopped)return;
    this.board.update(this.records);
    if(!this.locked)this.board.context(this.context,performance.now());
    const frame=this.board.page(),serialized=JSON.stringify(frame);
    if(serialized!==this.lastFrame){this.lastFrame=serialized;void this.lifecycle.present(frame);}
    this.state();
  }
  private rebuild(config:PageConfig,pageId:string,manual:boolean){
    if(!config.pages.some(page=>page.id===pageId))throw new Error(`Unknown page: ${pageId}`);
    const layout=this.board.exportLayout();
    // Construct first: invalid drafts must leave the running simulator untouched.
    const board=new PageBoard(config,{...layout,currentPage:pageId,manual});
    this.board.cancelInput();
    this.config=config;this.board=board;this.lastFrame='';
  }
  async command(raw:unknown):Promise<void>{
    if(this.stopped)throw new Error('Simulator is stopped');
    const command=object(raw);
    switch(command.type){
      case 'draft':{
        const config=validateSimulatorBoard(command.board,this.sources);
        if(command.selectedPage!==undefined&&typeof command.selectedPage!=='string')throw new Error('Invalid selected page');
        const layout=this.board.exportLayout();
        const pageId=command.selectedPage as string|undefined ?? (config.pages.some(page=>page.id===layout.currentPage)?layout.currentPage:config.defaultPage);
        this.rebuild(config,pageId,command.selectedPage!==undefined?true:layout.manual);break;
      }
      case 'page':{
        if(typeof command.pageId!=='string')throw new Error('Invalid page ID');
        this.rebuild(this.config,command.pageId,true);break;
      }
      case 'auto':this.rebuild(this.config,this.board.exportLayout().currentPage,false);break;
      case 'context':{
        if(typeof command.available!=='boolean'||(command.appBundleId!==null&&(typeof command.appBundleId!=='string'||command.appBundleId.length>255)))throw new Error('Invalid application context');
        this.context={available:command.available,appBundleId:command.appBundleId as string|null};break;
      }
      case 'lock':{
        if(typeof command.locked!=='boolean')throw new Error('Invalid lock state');
        this.locked=command.locked;
        if(this.locked)this.board.cancelInput();
        void this.lifecycle.setAllowed(!this.locked);break;
      }
      case 'latency':this.latencyMs=integer(command.ms,0,100);break;
      case 'signals':this.seed(integer(command.count,0,48));break;
      case 'key':{
        const index=integer(command.index,0,14);
        if(command.edge!=='down'&&command.edge!=='up')throw new Error('Invalid key edge');
        if(this.lifecycle.noteKey(index,command.edge)){
          if(command.edge==='down')this.board.down(index);else this.board.up(index);
        }else if(command.edge==='up')this.board.cancelInput(index);
        break;
      }
      default:throw new Error('Unknown simulator command');
    }
    this.refresh();
  }
  stop():Promise<void>{
    if(this.stopping)return this.stopping;
    this.stopped=true;clearInterval(this.tick);this.board.cancelInput();
    this.stopping=this.lifecycle.stop();
    return this.stopping;
  }
}
