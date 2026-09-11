import {randomUUID} from 'node:crypto';
import type {DeckBackend,DeckBackendEvents,DeckBackendStatus,PreparedPresentation,PresentationRequest} from '../../presentation/backend';
import type {FramePlan} from '../../presentation/playback';
import type {PluginToRuntimeMessage,RuntimeToPluginMessage} from '../../presentation/protocol';
import {TransitionCompiler} from '../../presentation/transitions';
import {startPluginGateway,type PluginGateway} from './plugin-gateway';

export type PluginGatewayHandlers={message(message:PluginToRuntimeMessage):void;connection(connected:boolean):void};
export type PluginGatewayFactory=(handlers:PluginGatewayHandlers)=>PluginGateway;
type Stored={request:PresentationRequest;plan:FramePlan;startKeys:readonly string[];advertised:boolean};
const uri=(bytes:Buffer)=>`data:image/png;base64,${bytes.toString('base64')}`;

export async function startPluginBackend(options:{
  port:number;
  token:string;
  events:DeckBackendEvents;
  gatewayFactory?:PluginGatewayFactory;
  compiler?:TransitionCompiler;
  onError?:(error:unknown)=>void;
}):Promise<DeckBackend>{
  const compiler=options.compiler??new TransitionCompiler();
  let gateway:PluginGateway|undefined,current:Stored|undefined,currentToken:string|undefined,activeGeneration:string|undefined,recoveringGeneration:string|undefined,recoveringFinal=-1,connected=false,closed=false,stopping:Promise<void>|undefined,unavailable:string|undefined;
  const report=(error:unknown)=>{try{options.onError?.(error);}catch{}}
  const handlers:PluginGatewayHandlers={
    message(message){
      if(closed)return;
      if(message.type==='cells-ready'){
        connected=true;
        if(!current?.advertised&&!recoveringGeneration)options.events.ready();
        return;
      }
      if(message.type==='frame-sent'){
        if(message.generation===recoveringGeneration&&message.frame===recoveringFinal){recoveringGeneration=undefined;recoveringFinal=-1;}
        return;
      }
      if(message.type==='key'&&message.generation===activeGeneration&&!recoveringGeneration)options.events.key({index:message.index,phase:message.phase,generation:message.generation});
    },
    connection(value){connected=value;if(!value)activeGeneration=undefined;},
  };
  try{
    gateway=(options.gatewayFactory??(callbacks=>startPluginGateway({port:options.port,token:options.token,onMessage:callbacks.message,onConnection:callbacks.connection})))(handlers);
    connected=gateway.status().connected;
  }catch(error){unavailable='Stream Deck 플러그인 연결을 시작하지 못했습니다.';report(error);}

  const backend:DeckBackend={
    async prepare(request){
      if(closed)throw new Error('Plugin backend is stopped');
      const from=request.from?.png??request.to.png,plan=await compiler.compile(from,request.to.png,request.transition,request.generation),token=randomUUID().replaceAll('-','');
      currentToken=token;
      current={request,plan,startKeys:(request.from??request.to).keyPngs.map(uri),advertised:request.reason==='unlock'};
      if(current.advertised&&gateway)gateway.publish({v:1,type:'presentation',trigger:'unlock',delivery:'prepare',plan,startKeys:current.startKeys,inputEnabled:false});
      return{backend:'plugin',generation:request.generation,token};
    },
    async present(prepared){
      if(prepared.backend!=='plugin')throw new Error('Prepared presentation belongs to a different backend');
      if(!current||prepared.token!==currentToken||prepared.generation!==current.request.generation)throw new Error('Prepared presentation is stale');
      const stored=current;current=undefined;currentToken=undefined;activeGeneration=stored.request.generation;
      if(!gateway)return;
      const delivery=stored.advertised?'resume':'immediate';
      if(stored.request.reason==='unlock'||stored.request.reason==='reconnect'){recoveringGeneration=stored.request.generation;recoveringFinal=stored.plan.frames.length-1;}
      const message:RuntimeToPluginMessage={v:1,type:'presentation',trigger:stored.request.reason,delivery,plan:stored.plan,inputEnabled:stored.request.inputEnabled,...(delivery==='resume'?{startKeys:stored.startKeys}:{})};
      try{gateway.publish(message);}catch(error){unavailable='Stream Deck 플러그인에 화면을 전송하지 못했습니다.';connected=false;recoveringGeneration=undefined;recoveringFinal=-1;report(error);}
    },
    status():DeckBackendStatus{
      if(unavailable)return{mode:'plugin',state:'unavailable',connected:false,message:unavailable};
      const live=connected||gateway?.status().connected===true;
      return{mode:'plugin',state:recoveringGeneration?'recovering':live?'ready':'connecting',connected:live};
    },
    stop(){
      if(stopping)return stopping;
      closed=true;current=undefined;currentToken=undefined;activeGeneration=undefined;recoveringGeneration=undefined;recoveringFinal=-1;
      stopping=Promise.resolve().then(()=>gateway?.stop());
      return stopping;
    },
  };
  return backend;
}
