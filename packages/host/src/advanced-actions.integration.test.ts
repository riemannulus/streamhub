import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ButtonDefinition,StudioDocument} from '../../studio/document';
import type {ButtonEffect} from '../../streamdeck';
import type {DeckBackend,DeckBackendStatus,PreparedPresentation,PresentationRequest} from '../../presentation/backend';
import {FileButtonStateStore} from './button-state';
import {startPresentationCoordinator,type PresentationCoordinator} from './presentation';
import {SignalStore} from './store';

class Clock{
  now=0;private tasks:{at:number;callback:()=>void;cancelled:boolean}[]=[];
  schedule=(delay:number,callback:()=>void)=>{const task={at:this.now+delay,callback,cancelled:false};this.tasks.push(task);return{cancel:()=>{task.cancelled=true;}};};
  sleep=(delay:number,signal:AbortSignal)=>{if(signal.aborted)return Promise.resolve(false);return new Promise<boolean>(resolve=>{const timer=this.schedule(delay,()=>{signal.removeEventListener('abort',abort);resolve(true);});const abort=()=>{timer.cancel();resolve(false);};signal.addEventListener('abort',abort,{once:true});});};
  advance(milliseconds:number){const target=this.now+milliseconds;for(;;){const task=this.tasks.filter(item=>!item.cancelled&&item.at<=target).sort((a,b)=>a.at-b.at)[0];if(!task)break;task.cancelled=true;this.now=task.at;task.callback();}this.now=target;}
}
const hidden={contentMode:'hidden' as const};
const single=(action:any)=>({type:'single' as const,action});
const sequence=(steps:any[],mode:'sequential'|'parallel'='sequential')=>({type:'sequence' as const,sequence:{mode,steps}});
const action=(url:string)=>({type:'action' as const,action:{type:'open-url' as const,url}});
const button=(id:string,index:number,press:any,extra:Partial<ButtonDefinition['behavior']>={}):ButtonDefinition=>({id,index,appearance:hidden,behavior:{press,doublePressMs:300,holdMs:500,...extra}});
const document=():StudioDocument=>({version:3,id:'11111111-1111-4111-8111-111111111111',device:{kind:'streamdeck-classic-5x3'},defaultPageId:'home',pages:[{id:'home',title:'홈',buttons:[
  button('gestures',0,single({type:'open-url',url:'https://press.example/'}),{doublePress:single({type:'open-url',url:'https://double.example/'}),hold:single({type:'open-url',url:'https://hold.example/'})}),
  button('delayed',1,sequence([action('https://sequence-one.example/'),{type:'delay',milliseconds:100},action('https://sequence-two.example/')])),
  button('parallel',2,sequence([action('https://parallel-one.example/'),action('https://parallel-two.example/')],'parallel')),
  button('toggle',3,{type:'toggle',initial:'off',offToOn:{mode:'sequential',steps:[action('https://toggle-on.example/')]},onToOff:{mode:'sequential',steps:[action('https://toggle-off.example/')]} }),
  button('next',4,single({type:'next-page'})),
]},{id:'other',title:'다른 화면',buttons:[button('previous',4,single({type:'previous-page'}))]}],standby:{color:'#000000'},motion:{pageChange:{type:'none',durationMs:0},unlock:{type:'none',durationMs:0},reconnect:{type:'none',durationMs:0}}});

class TestBackend implements DeckBackend{
  state:DeckBackendStatus['state']='ready';private generation='';
  async prepare(request:PresentationRequest){this.generation=request.generation;return{backend:'plugin' as const,generation:request.generation,token:request.generation};}
  async present(_value:PreparedPresentation){}
  status():DeckBackendStatus{return{mode:'plugin',state:this.state,connected:this.state==='ready'};}
  async stop(){}
}
let directory='',store:SignalStore|undefined,service:PresentationCoordinator|undefined,backend:TestBackend|undefined;
afterEach(async()=>{await service?.stop();service=undefined;store?.close();store=undefined;if(directory)rmSync(directory,{recursive:true,force:true});directory='';});
const waitFor=async(predicate:()=>boolean)=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await Bun.sleep(5);expect(predicate()).toBe(true);};

test('advanced gestures execute exactly once, persist toggles and cancel delayed work on every lifecycle boundary',async()=>{
  directory=mkdtempSync(join(tmpdir(),'streamhub-advanced-actions-'));store=new SignalStore(':memory:');const clock=new Clock(),effects:ButtonEffect[]=[];
  const start=()=>startPresentationCoordinator({store:store!,directory:join(directory,'studio'),backend:backend=new TestBackend(),buttonState:new FileButtonStateStore(directory),now:()=>clock.now,schedule:clock.schedule,sleep:clock.sleep,execute:async effect=>{effects.push(effect);}});
  service=await start();const snapshot=service.snapshot();await service.apply(document(),snapshot.version);
  const input=async(index:number,phase:'down'|'up')=>service!.key({phase,index,generation:service!.status().generation!});
  const press=async(index:number)=>{await input(index,'down');await input(index,'up');};
  const urls=()=>effects.flatMap(effect=>effect.type==='open'?[effect.url]:[]);

  await press(0);clock.advance(301);await waitFor(()=>urls().length===1);
  await input(0,'down');await input(0,'up');clock.advance(100);await input(0,'down');await input(0,'up');await waitFor(()=>urls().length===2);
  await input(0,'down');clock.advance(500);await waitFor(()=>urls().length===3);await input(0,'up');clock.advance(400);
  expect(urls()).toEqual(['https://press.example/','https://double.example/','https://hold.example/']);

  const sequential=press(1);await waitFor(()=>urls().includes('https://sequence-one.example/'));clock.advance(100);await sequential;expect(urls().slice(-2)).toEqual(['https://sequence-one.example/','https://sequence-two.example/']);
  await press(2);expect(urls().slice(-2)).toEqual(['https://parallel-one.example/','https://parallel-two.example/']);
  await press(3);expect(urls().at(-1)).toBe('https://toggle-on.example/');await service.stop();service=await start();await press(3);expect(urls().at(-1)).toBe('https://toggle-off.example/');

  const beforePage=urls().length,pageCancelled=press(1);await waitFor(()=>urls().length===beforePage+1);await press(4);clock.advance(200);await pageCancelled;await press(4);
  const pageSlice=urls().slice(beforePage);expect(pageSlice).toEqual(['https://sequence-one.example/']);

  const beforeLock=urls().length,lockCancelled=press(1);await waitFor(()=>urls().length===beforeLock+1);await service.locked(true);clock.advance(200);await lockCancelled;expect(urls().slice(beforeLock)).toEqual(['https://sequence-one.example/']);await service.locked(false);
  const beforeDisconnect=urls().length,disconnectCancelled=press(1);await waitFor(()=>urls().length===beforeDisconnect+1);backend!.state='connecting';await service.backendReady();clock.advance(200);await disconnectCancelled;expect(urls().slice(beforeDisconnect)).toEqual(['https://sequence-one.example/']);

  const counts=urls().reduce<Record<string,number>>((result,url)=>({...result,[url]:(result[url]??0)+1}),{});expect(counts['https://press.example/']).toBe(1);expect(counts['https://double.example/']).toBe(1);expect(counts['https://hold.example/']).toBe(1);expect(counts['https://sequence-one.example/']).toBe(4);expect(counts['https://sequence-two.example/']).toBe(1);expect(counts['https://parallel-one.example/']).toBe(1);expect(counts['https://parallel-two.example/']).toBe(1);expect(counts['https://toggle-on.example/']).toBe(1);expect(counts['https://toggle-off.example/']).toBe(1);
});
