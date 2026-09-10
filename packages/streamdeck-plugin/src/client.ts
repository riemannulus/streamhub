import {createRequire} from 'node:module';import {parseRuntimeMessage,type PluginToRuntimeMessage,type RuntimeToPluginMessage} from '../../presentation/protocol';
const NodeWebSocket=createRequire(import.meta.url)('ws') as any;
export class RuntimeClient{private socket?:any;private stopped=false;private retry?:ReturnType<typeof setTimeout>;private delay=250;constructor(private options:{url:string;token:string;onMessage(message:RuntimeToPluginMessage):void;onStatus?(connected:boolean):void}){}
  start(){this.stopped=false;this.connect();}
  private connect(){if(this.stopped)return;const socket=this.socket=new NodeWebSocket(this.options.url,{headers:{authorization:`Bearer ${this.options.token}`}});socket.on('open',()=>{this.delay=250;this.options.onStatus?.(true);});socket.on('message',(data:unknown)=>{try{this.options.onMessage(parseRuntimeMessage(JSON.parse(String(data))));}catch{socket.close(1008,'invalid runtime message');}});socket.on('close',()=>{this.options.onStatus?.(false);if(!this.stopped){this.retry=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(5000,this.delay*2);}});socket.on('error',()=>socket.close());}
  send(message:PluginToRuntimeMessage){if(this.socket?.readyState===NodeWebSocket.OPEN)this.socket.send(JSON.stringify(message));}
  stop(){this.stopped=true;clearTimeout(this.retry);this.socket?.close(1000,'shutdown');}
}
