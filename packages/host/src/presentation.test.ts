import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {singlePressBehavior} from '../../studio/document';
import type {DeckBackend,DeckBackendStatus,PreparedPresentation,PresentationRequest} from '../../presentation/backend';
import {MemoryButtonStateStore} from './button-state';
import {SignalStore} from './store';
import {startPresentationCoordinator,type PresentationCoordinator} from './presentation';

class TestBackend implements DeckBackend{
  requests:PresentationRequest[]=[];presented:PreparedPresentation[]=[];state:DeckBackendStatus['state']='ready';
  async prepare(request:PresentationRequest){this.requests.push(request);return{backend:'plugin' as const,generation:request.generation,token:`token-${request.generation}`};}
  async present(value:PreparedPresentation){this.presented.push(value);}
  status():DeckBackendStatus{return{mode:'plugin',state:this.state,connected:this.state==='ready'||this.state==='recovering'};}
  async stop(){}
}

test('coordinator prepares unlock once, reconnects through the backend, and executes a current key',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-coordinator-')),store=new SignalStore(':memory:'),backend=new TestBackend(),effects:unknown[]=[];let coordinator:PresentationCoordinator|undefined;
  try{
    coordinator=await startPresentationCoordinator({store,directory:dir,backend,execute:async effect=>{effects.push(effect);}});
    expect(backend.requests.at(-1)).toMatchObject({reason:'initial',inputEnabled:true});
    await coordinator.locked(true);
    expect(backend.requests.slice(-2).map(item=>item.reason)).toEqual(['standby','unlock']);
    expect(backend.presented.at(-1)?.generation).toBe(backend.requests.at(-2)?.generation);
    const preparedCount=backend.requests.length;
    await coordinator.locked(false);
    expect(backend.requests).toHaveLength(preparedCount);
    expect(backend.presented.at(-1)?.generation).toBe(backend.requests.at(-1)?.generation);
    await coordinator.backendReady();expect(backend.requests.at(-1)?.reason).toBe('reconnect');
    const snap=coordinator.snapshot(),document=structuredClone(snap.document);document.pages[0].buttons=[{id:'firefox',index:0,behavior:singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'}),appearance:{contentMode:'hidden'}}];
    await coordinator.apply(document,snap.version);const generation=coordinator.status().generation!;
    await coordinator.key({index:0,phase:'down',generation});await coordinator.key({index:0,phase:'up',generation});
    expect(effects).toEqual([{type:'app',bundleId:'org.mozilla.firefox'}]);
  }finally{await coordinator?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('coordinator records stable system failures and lock cancels pending execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-presentation-')),store=new SignalStore(':memory:'),backend=new TestBackend();let mode:'fail'|'wait'='fail',received:AbortSignal|undefined,release=()=>{},coordinator:PresentationCoordinator|undefined;
  try{
    coordinator=await startPresentationCoordinator({store,directory:dir,backend,execute:async(_effect,signal)=>{received=signal;if(mode==='fail')throw Object.assign(new Error('permission'),{code:'accessibility-permission-required'});await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>resolve(),{once:true});});}});
    const snapshot=coordinator.snapshot(),document=structuredClone(snapshot.document);document.pages[0].buttons=[{id:'hotkey',index:0,behavior:singlePressBehavior({type:'hotkey',keys:['command','k']}),appearance:{contentMode:'hidden'}}];await coordinator.apply(document,snapshot.version);
    let generation=coordinator.status().generation!;await coordinator.key({index:0,phase:'down',generation});await coordinator.key({index:0,phase:'up',generation});expect(backend.requests.at(-1)?.reason).toBe('refresh');
    mode='wait';const next=coordinator.snapshot(),changed=structuredClone(next.document);changed.pages[0].buttons![0].id='hotkey-2';await coordinator.apply(changed,next.version);generation=coordinator.status().generation!;await coordinator.key({index:0,phase:'down',generation});received=undefined;const pending=coordinator.key({index:0,phase:'up',generation});for(let attempt=0;attempt<100&&!received;attempt++)await Bun.sleep(5);expect(received).toBeDefined();await coordinator.locked(true);expect((received as AbortSignal|undefined)?.aborted).toBe(true);release();await pending;
  }finally{await coordinator?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

class GestureClock{
  now=0;private tasks:{at:number;callback:()=>void;cancelled:boolean}[]=[];
  schedule=(delay:number,callback:()=>void)=>{const task={at:this.now+delay,callback,cancelled:false};this.tasks.push(task);return{cancel:()=>{task.cancelled=true;}};};
  advance(milliseconds:number){const target=this.now+milliseconds;for(;;){const task=this.tasks.filter(item=>!item.cancelled&&item.at<=target).sort((a,b)=>a.at-b.at)[0];if(!task)break;task.cancelled=true;this.now=task.at;task.callback();}this.now=target;}
}
const waitFor=async(predicate:()=>boolean)=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await Bun.sleep(5);expect(predicate()).toBe(true);};

test('coordinator selects exactly one press, double-press or hold branch and cancels pending gestures',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-gestures-')),store=new SignalStore(':memory:'),backend=new TestBackend(),effects:unknown[]=[],clock=new GestureClock();let coordinator:PresentationCoordinator|undefined;
  try{
    coordinator=await startPresentationCoordinator({store,directory:dir,backend,execute:async effect=>{effects.push(effect);},now:()=>clock.now,schedule:clock.schedule});
    const snapshot=coordinator.snapshot(),document=structuredClone(snapshot.document);document.motion.pageChange={type:'none',durationMs:0};document.pages[0].buttons=[{id:'gesture',index:0,behavior:{press:{type:'single',action:{type:'open-url',url:'https://press.example/'}},doublePress:{type:'single',action:{type:'open-url',url:'https://double.example/'}},hold:{type:'single',action:{type:'open-url',url:'https://hold.example/'}},doublePressMs:300,holdMs:500},appearance:{contentMode:'hidden'}}];await coordinator.apply(document,snapshot.version);
    const input=async(phase:'down'|'up')=>coordinator!.key({phase,index:0,generation:coordinator!.status().generation!});
    await input('down');await input('up');clock.advance(301);await waitFor(()=>effects.length===1);
    await input('down');await input('up');clock.advance(100);await input('down');await input('up');await waitFor(()=>effects.length===2);
    await input('down');clock.advance(500);await waitFor(()=>effects.length===3);await input('up');clock.advance(400);expect(effects).toHaveLength(3);
    await input('down');await input('up');await coordinator.refresh();clock.advance(400);expect(effects).toHaveLength(3);
    await input('down');await input('up');backend.state='connecting';await coordinator.backendReady();clock.advance(400);expect(effects).toHaveLength(3);
    backend.state='ready';await coordinator.locked(true);clock.advance(400);expect(effects).toHaveLength(3);
  }finally{await coordinator?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('toggle state changes only after success and survives coordinator restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-toggle-')),store=new SignalStore(':memory:'),state=new MemoryButtonStateStore(),effects:unknown[]=[];let fail=false,coordinator:PresentationCoordinator|undefined;
  const start=()=>startPresentationCoordinator({store,directory:dir,backend:new TestBackend(),buttonState:state,execute:async effect=>{effects.push(effect);if(fail)throw new Error('failed');}});
  try{
    coordinator=await start();const snapshot=coordinator.snapshot(),document=structuredClone(snapshot.document);document.pages[0].buttons=[{id:'toggle',index:0,behavior:{press:{type:'toggle',initial:'off',offToOn:{mode:'sequential',steps:[{type:'action',action:{type:'open-url',url:'https://on.example/'}}]},onToOff:{mode:'sequential',steps:[{type:'action',action:{type:'open-url',url:'https://off.example/'}}]}},doublePressMs:300,holdMs:500},appearance:{contentMode:'label-only',label:{text:'Power',position:'center',size:'medium',color:'#ffffff'}}}];await coordinator.apply(document,snapshot.version);
    const press=async()=>{const generation=coordinator!.status().generation!;await coordinator!.key({index:0,phase:'down',generation});await coordinator!.key({index:0,phase:'up',generation});};
    await press();expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('on');await coordinator.stop();coordinator=await start();await press();expect(effects.at(-1)).toMatchObject({url:'https://off.example/'});expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('off');fail=true;await press();expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('off');
  }finally{await coordinator?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});
