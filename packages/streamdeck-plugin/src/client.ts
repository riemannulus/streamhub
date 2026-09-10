import {parseRuntimeMessage,type PluginToRuntimeMessage,type RuntimeToPluginMessage} from '../../presentation/protocol';
export class RuntimeClient{private socket?:WebSocket;private stopped=false;private retry?:ReturnType<typeof setTimeout>;private delay=250;constructor(private options:{url:string;token:string;onMessage(message:RuntimeToPluginMessage):void;onStatus?(connected:boolean):void}){}
  start(){this.stopped=false;this.connect();}
  private connect(){if(this.stopped)return;const socket=this.socket=new (WebSocket as any)(this.options.url,{headers:{authorization:`Bearer ${this.options.token}`}});socket.onopen=()=>{this.delay=250;this.options.onStatus?.(true);};socket.onmessage=(event:MessageEvent)=>{try{this.options.onMessage(parseRuntimeMessage(JSON.parse(String(event.data))));}catch{socket.close(1008,'invalid runtime message');}};socket.onclose=()=>{this.options.onStatus?.(false);if(!this.stopped){this.retry=setTimeout(()=>this.connect(),this.delay);this.delay=Math.min(5000,this.delay*2);}};socket.onerror=()=>socket.close();}
  send(message:PluginToRuntimeMessage){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(message));}
  stop(){this.stopped=true;clearTimeout(this.retry);this.socket?.close(1000,'shutdown');}
}
