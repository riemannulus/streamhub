import {expect,test} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {singlePressBehavior} from '../../studio/document';import {MemoryButtonStateStore} from './button-state';import {SignalStore} from './store';import {startPresentationService} from './presentation';
test('presentation service publishes, handles lock/unlock and safe key release',async()=>{const dir=mkdtempSync(join(tmpdir(),'streamhub-presentation-')),store=new SignalStore(':memory:'),sent:any[]=[],effects:any[]=[];let service:Awaited<ReturnType<typeof startPresentationService>>|undefined;try{service=await startPresentationService({store,directory:dir,gateway:{publish:m=>sent.push(m),status:()=>({connected:true})},execute:async e=>{effects.push(e)}});expect(sent.at(-1)).toMatchObject({type:'presentation',trigger:'initial'});await service.message({v:1,type:'lock',locked:true});expect(sent.at(-1)).toMatchObject({trigger:'standby'});await service.message({v:1,type:'lock',locked:false});expect(sent.at(-1)).toMatchObject({trigger:'unlock'});const snap=service.snapshot();const doc=structuredClone(snap.document);doc.pages[0].buttons=[{id:'firefox',index:0,behavior:singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'}),appearance:{contentMode:'hidden'}}];await service.apply(doc,snap.version);const generation=service.status().generation!;await service.message({v:1,type:'key',phase:'down',index:0,generation});await service.message({v:1,type:'key',phase:'up',index:0,generation});expect(effects).toEqual([{type:'app',bundleId:'org.mozilla.firefox'}]);}finally{await service?.stop();store.close();rmSync(dir,{recursive:true,force:true});}});

test('presentation records stable system failures and lock cancels pending execution',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-presentation-')),store=new SignalStore(':memory:'),sent:any[]=[];let mode:'fail'|'wait'='fail',received:AbortSignal|undefined,release:()=>void=()=>{};
  const service=await startPresentationService({store,directory:dir,gateway:{publish:message=>sent.push(message),status:()=>({connected:true})},execute:async(_effect,signal)=>{received=signal;if(mode==='fail')throw Object.assign(new Error('permission'),{code:'accessibility-permission-required'});await new Promise<void>(resolve=>{release=resolve;signal?.addEventListener('abort',()=>resolve(),{once:true});});}});
  try{
    const snapshot=service.snapshot(),document=structuredClone(snapshot.document);document.pages[0].buttons=[{id:'hotkey',index:0,behavior:singlePressBehavior({type:'hotkey',keys:['command','k']}),appearance:{contentMode:'hidden'}}];await service.apply(document,snapshot.version);
    let generation=service.status().generation!;await service.message({v:1,type:'key',phase:'down',index:0,generation});await expect(service.message({v:1,type:'key',phase:'up',index:0,generation})).resolves.toBeUndefined();expect(sent.at(-1)).toMatchObject({trigger:'refresh'});
    mode='wait';const next=service.snapshot(),changed=structuredClone(next.document);changed.pages[0].buttons![0].id='hotkey-2';await service.apply(changed,next.version);generation=service.status().generation!;await service.message({v:1,type:'key',phase:'down',index:0,generation});received=undefined;const pending=service.message({v:1,type:'key',phase:'up',index:0,generation});for(let attempt=0;attempt<100&&!received;attempt++)await Bun.sleep(5);expect(received).toBeDefined();await service.message({v:1,type:'lock',locked:true});expect((received as AbortSignal|undefined)?.aborted).toBe(true);release();await expect(pending).resolves.toBeUndefined();
  }finally{await service.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

class GestureClock{
  now=0;private tasks:{at:number;callback:()=>void;cancelled:boolean}[]=[];
  schedule=(delay:number,callback:()=>void)=>{const task={at:this.now+delay,callback,cancelled:false};this.tasks.push(task);return{cancel:()=>{task.cancelled=true;}};};
  advance(milliseconds:number){const target=this.now+milliseconds;for(;;){const task=this.tasks.filter(item=>!item.cancelled&&item.at<=target).sort((a,b)=>a.at-b.at)[0];if(!task)break;task.cancelled=true;this.now=task.at;task.callback();}this.now=target;}
}
const waitFor=async(predicate:()=>boolean)=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await Bun.sleep(5);expect(predicate()).toBe(true);};

test('presentation selects exactly one press, double-press or hold branch and cancels pending gestures',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-gestures-')),store=new SignalStore(':memory:'),sent:any[]=[],effects:any[]=[],clock=new GestureClock();let service:Awaited<ReturnType<typeof startPresentationService>>|undefined;
  try{
    service=await startPresentationService({store,directory:dir,gateway:{publish:message=>sent.push(message),status:()=>({connected:true})},execute:async effect=>{effects.push(effect);},now:()=>clock.now,schedule:clock.schedule});
    const snapshot=service.snapshot(),document=structuredClone(snapshot.document);document.motion.pageChange={type:'none',durationMs:0};document.pages[0].buttons=[{id:'gesture',index:0,behavior:{press:{type:'single',action:{type:'open-url',url:'https://press.example/'}},doublePress:{type:'single',action:{type:'open-url',url:'https://double.example/'}},hold:{type:'single',action:{type:'open-url',url:'https://hold.example/'}},doublePressMs:300,holdMs:500},appearance:{contentMode:'hidden'}}];await service.apply(document,snapshot.version);
    const input=async(phase:'down'|'up')=>service!.message({v:1,type:'key',phase,index:0,generation:service!.status().generation!});
    await input('down');await input('up');clock.advance(301);await waitFor(()=>effects.length===1);expect(effects.at(-1)).toMatchObject({url:'https://press.example/'});
    await input('down');await input('up');clock.advance(100);await input('down');await input('up');await waitFor(()=>effects.length===2);expect(effects.at(-1)).toMatchObject({url:'https://double.example/'});
    await input('down');clock.advance(500);await waitFor(()=>effects.length===3);await input('up');clock.advance(400);expect(effects.at(-1)).toMatchObject({url:'https://hold.example/'});expect(effects).toHaveLength(3);
    await input('down');await input('up');await service.refresh();clock.advance(400);expect(effects).toHaveLength(3);
    await input('down');await input('up');service.disconnect();clock.advance(400);expect(effects).toHaveLength(3);
    await input('down');await input('up');await service.message({v:1,type:'lock',locked:true});clock.advance(400);expect(effects).toHaveLength(3);
  }finally{await service?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('toggle state changes only after success and survives presentation restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-toggle-')),store=new SignalStore(':memory:'),state=new MemoryButtonStateStore(),effects:any[]=[];let fail=false,service:Awaited<ReturnType<typeof startPresentationService>>|undefined;
  const start=()=>startPresentationService({store,directory:dir,gateway:{publish:()=>{},status:()=>({connected:true})},buttonState:state,execute:async effect=>{effects.push(effect);if(fail)throw new Error('failed');}});
  try{
    service=await start();const snapshot=service.snapshot(),document=structuredClone(snapshot.document);document.pages[0].buttons=[{id:'toggle',index:0,behavior:{press:{type:'toggle',initial:'off',offToOn:{mode:'sequential',steps:[{type:'action',action:{type:'open-url',url:'https://on.example/'}}]},onToOff:{mode:'sequential',steps:[{type:'action',action:{type:'open-url',url:'https://off.example/'}}]}},doublePressMs:300,holdMs:500},appearance:{contentMode:'label-only',label:{text:'Power',position:'center',size:'medium',color:'#ffffff'}}}];await service.apply(document,snapshot.version);
    const press=async()=>{const generation=service!.status().generation!;await service!.message({v:1,type:'key',phase:'down',index:0,generation});await service!.message({v:1,type:'key',phase:'up',index:0,generation});};
    await press();expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('on');await service.stop();service=await start();await press();expect(effects.at(-1)).toMatchObject({url:'https://off.example/'});expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('off');fail=true;await press();expect(state.getToggle({documentId:document.id,pageId:'home',buttonId:'toggle'})).toBe('off');
  }finally{await service?.stop();store.close();rmSync(dir,{recursive:true,force:true});}
});
