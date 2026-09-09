import { expect,test } from 'bun:test';
import { SignalStore } from './store';
import { startDisplay } from './display';
import type { SessionState } from './session-monitor';
import { SessionDeck, type DeckPage } from '../../streamdeck';
import type { ApplicationContext } from './app-context';

test('configured pages route by app while manual selection holds until auto is pressed',async()=>{
  const store=new SignalStore(':memory:');
  let key!:(index:number,edge:'down'|'up')=>void;
  let context!:(value:ApplicationContext)=>void;
  let frame:DeckPage|undefined;
  const display=await startDisplay(store,'/private/tmp',{
    board:{defaultPage:'home',transition:'fade',durationMs:250,pages:[
      {id:'home',title:'Home',signals:{},buttons:[{index:12,type:'page',pageId:'dev'}]},
      {id:'dev',title:'Dev',match:{appBundleId:'test.editor'},buttons:[{index:12,type:'page',pageId:'home'},{index:13,type:'auto'}]},
    ]},pollMs:5,
    connect:async(callback)=>{key=callback;return{write:async(value)=>{frame=value;},standby:async()=>{},close:async()=>{}};},
    monitor:async(callback)=>{callback({active:true,reason:'active'});return{stop:async()=>{}};},
    context:async(callback)=>{context=callback;return{stop:async()=>{}};},
  });
  try{
    await waitFor(()=>display.status().inputEnabled && frame?.viewId==='home');
    key(12,'down');key(12,'up');
    await waitFor(()=>display.status().inputEnabled && frame?.viewId==='dev');
    context({available:true,appBundleId:'other.app'});
    await Bun.sleep(300);
    expect(frame?.viewId).toBe('dev');
    key(13,'down');key(13,'up');
    await waitFor(()=>frame?.viewId==='home');
    context({available:true,appBundleId:'test.editor'});
    await waitFor(()=>frame?.viewId==='dev');
    context({available:false,appBundleId:null});
    await Bun.sleep(300);
    expect(frame?.viewId).toBe('dev');
  }finally{await display.stop();store.close();}
});

test('monitor startup failure cleans an already-acquired display',async()=>{
  const store=new SignalStore(':memory:');const calls:string[]=[];
  try{
    await expect(startDisplay(store,'/unused',{
      connect:async()=>({write:async()=>{},standby:async()=>{calls.push('standby');},close:async()=>{calls.push('close');}}),
      monitor:async()=>{await Bun.sleep(0);throw new Error('monitor startup failed');},
    })).rejects.toThrow('monitor startup failed');
    expect(calls).toEqual(['standby','close']);
  }finally{store.close();}
});

test('cancelled monitor startup ignores late active callbacks and disposes its late handle',async()=>{
  const store=new SignalStore(':memory:');const calls:string[]=[];
  const controller=new AbortController();let callback!:(state:SessionState)=>void;
  let finish!:(handle:{stop():Promise<void>})=>void;
  const starting=startDisplay(store,'/unused',{
    signal:controller.signal,
    connect:async()=>({write:async()=>{calls.push('write');},standby:async()=>{},close:async()=>{calls.push('close');}}),
    monitor:async(onState)=>{callback=onState;return new Promise(resolve=>{finish=resolve;});},
  });
  await Bun.sleep(0);controller.abort();
  callback({active:true,reason:'active'});
  finish({stop:async()=>{calls.push('late-monitor-stop');}});
  await expect(starting).rejects.toMatchObject({name:'AbortError'});
  store.close();
  expect(calls).not.toContain('write');
  expect(calls.at(-1)).toBe('late-monitor-stop');
});

test('display stop shares one promise and attempts hardware cleanup after monitor stop rejection',async()=>{
  const store=new SignalStore(':memory:');const calls:string[]=[];
  const display=await startDisplay(store,'/unused',{
    connect:async()=>({write:async()=>{},standby:async()=>{calls.push('standby');},close:async()=>{calls.push('close');}}),
    monitor:async(callback)=>{callback({active:true,reason:'active'});return{stop:async()=>{calls.push('monitor-stop');throw new Error('monitor close failed');}};},
  });
  await waitFor(()=>display.status().inputEnabled);
  calls.length=0;
  const one=display.stop(),two=display.stop();
  expect(two).toBe(one);
  await expect(one).rejects.toBeInstanceOf(AggregateError);
  expect(calls).toContain('standby');expect(calls).toContain('close');expect(calls).toContain('monitor-stop');
  store.close();
});

test('canceling one logical release preserves the remaining hold and page barrier',()=>{
  const deck=new SessionDeck();
  deck.update(Array.from({length:13},(_,i)=>({source:'a',id:String(i),kind:'live' as const,label:String(i),level:'info' as const,revision:i+1,createdAt:1,updatedAt:1,freshness:'fresh' as const})));
  deck.down(0);deck.down(1);deck.page(1);
  deck.cancelInput(0);
  deck.down(10);
  expect(deck.up(10)).toBeUndefined();
  expect(deck.page().index).toBe(1);
  deck.cancelInput(1);
  deck.down(10);
  expect(deck.up(10)).toMatchObject({type:'navigate',page:0});
});

async function waitFor(predicate:()=>boolean){
  const deadline=Date.now()+1000;
  while(!predicate()){
    if(Date.now()>=deadline)throw new Error('Display condition timed out');
    await Bun.sleep(5);
  }
}

test('rejected key up after a normal redraw releases its logical hold for later navigation',async()=>{
  const store=new SignalStore(':memory:');
  for(let i=0;i<13;i++)store.apply({op:'upsert',source:'a',signal:{kind:'live',id:String(i),label:String(i),level:'info'},deliveryId:String(i)});
  let key!:(index:number,edge:'down'|'up')=>void;
  let frame:DeckPage|undefined;
  const display=await startDisplay(store,'/private/tmp',{
    pollMs:5,
    connect:async(callback)=>{key=callback;return{write:async(value)=>{frame=value;},standby:async()=>{},close:async()=>{}};},
    monitor:async(callback)=>{callback({active:true,reason:'active'});return{stop:async()=>{}};},
  });
  try{
    await waitFor(()=>display.status().inputEnabled);
    key(0,'down');
    store.apply({op:'upsert',source:'a',signal:{kind:'live',id:'0',label:'changed',level:'info'},deliveryId:'change'});
    await waitFor(()=>frame?.keys[0]?.type==='signal' && frame.keys[0].record.label==='changed');
    key(0,'up');
    key(14,'down');key(14,'up');
    await waitFor(()=>frame?.index===1 && display.status().inputEnabled);
    key(10,'down');key(10,'up');
    await waitFor(()=>frame?.index===0 && display.status().inputEnabled);
    expect(frame?.index).toBe(0);
  }finally{await display.stop();store.close();}
});

test('active notifications cannot override refresh failure and healthy data resumes latest frame',async()=>{
  const store=new SignalStore(':memory:');
  store.apply({op:'upsert',source:'a',signal:{kind:'live',id:'s',label:'old',level:'info'},deliveryId:'1'});
  let state!:(value:SessionState)=>void;
  let writes=0;let frame:DeckPage|undefined;
  const display=await startDisplay(store,'/private/tmp',{
    pollMs:10,
    connect:async()=>({write:async(value)=>{frame=value;writes++;},standby:async()=>{},close:async()=>{}}),
    monitor:async(callback)=>{state=callback;callback({active:true,reason:'active'});return{stop:async()=>{}};},
  });
const records=store.records.bind(store);
  try{
    await waitFor(()=>display.status().inputEnabled);
    state({active:false,reason:'locked'});
    await Bun.sleep(20);
    store.records=()=>{throw new Error('Test read unavailable');};
    const before=writes;
    state({active:true,reason:'active'});
    await Bun.sleep(30);
    expect(display.status().inputEnabled).toBe(false);
    expect(writes).toBe(before);
    state({active:true,reason:'active'});
    await Bun.sleep(20);
    expect(display.status().inputEnabled).toBe(false);
    expect(writes).toBe(before);
    store.apply({op:'upsert',source:'a',signal:{kind:'live',id:'s',label:'recovered',level:'info'},deliveryId:'2'});
    store.records=records;
    await waitFor(()=>display.status().inputEnabled && frame?.keys[0]?.type==='signal' && frame.keys[0].record.label==='recovered');
    expect(writes).toBe(before+1);
  }finally{store.records=records;await display.stop();store.close();}
});

test('host session suspension returns to standby and resume uses latest stored state',async()=>{
  const store=new SignalStore(':memory:');const writes:DeckPage[]=[];const calls:string[]=[];
  let state!:(value:SessionState)=>void;
  const display=await startDisplay(store, '/private/tmp', {
    connect:async()=>({write:async(frame)=>{writes.push(frame);calls.push('write');},standby:async()=>{calls.push('standby');},close:async()=>{calls.push('close');}}),
    monitor:async(callback)=>{state=callback;callback({active:false,reason:'locked'});return{stop:async()=>{calls.push('monitor-stop');}};},
    pollMs:10,
  });
  try {
    await Bun.sleep(30);
    expect(calls).toEqual(['standby','close']);
    store.apply({op:'upsert',source:'a',signal:{kind:'live',id:'s',label:'newest',level:'urgent'},deliveryId:'1'});
    await Bun.sleep(30);expect(writes).toHaveLength(0);
    state({active:true,reason:'active'});await Bun.sleep(30);
    expect(writes.at(-1)?.keys[0]).toMatchObject({type:'signal',record:{label:'newest'}});
    state({active:false,reason:'locked'});await Bun.sleep(30);
    expect(calls.slice(-2)).toEqual(['standby','close']);
  } finally {await display.stop();store.close();}
  expect(calls).toContain('monitor-stop');
});

test('fixed button effects run once, render results, and discard late completion after draft replacement',async()=>{
  const store=new SignalStore(':memory:');let key!:(index:number,edge:'down'|'up')=>void;
  let frame:DeckPage|undefined,calls=0,finish!:()=>void,signal:AbortSignal|undefined;
  const board={defaultPage:'home',transition:'none' as const,pages:[{id:'home',title:'Home',buttons:[{index:0,type:'open' as const,label:'Open',url:'https://example.com'}]}]};
  const display=await startDisplay(store,'/unused',{board,pollMs:5,
    connect:async callback=>{key=callback;return{write:async value=>{frame=value;},standby:async()=>{},close:async()=>{}};},
    monitor:async callback=>{callback({active:true,reason:'active'});return{stop:async()=>{}};},
    execute:async(_effect,abort)=>{calls++;signal=abort;await new Promise<void>(resolve=>{finish=resolve;});},
  });
  try{
    await waitFor(()=>display.status().inputEnabled);key(0,'down');key(0,'up');
    await waitFor(()=>calls===1&&display.status().inputEnabled);
    key(0,'down');key(0,'up');await Bun.sleep(10);expect(calls).toBe(1);
    finish();await waitFor(()=>JSON.stringify(frame).includes('완료'));
    await waitFor(()=>display.status().inputEnabled);key(0,'down');key(0,'up');await waitFor(()=>calls===2);
    display.applyDraft({...board,pages:[{id:'home',title:'New',buttons:[{index:0,type:'text',label:'Replacement'}]}]});
    expect(signal?.aborted).toBe(true);finish();await Bun.sleep(20);
    expect(JSON.stringify(frame)).toContain('Replacement');expect(JSON.stringify(frame)).not.toContain('완료');
  }finally{await display.stop();store.close();}
});
test('missing executor fails closed and pending execution is aborted on shutdown',async()=>{
  const store=new SignalStore(':memory:');let key!:(index:number,edge:'down'|'up')=>void;let frame:DeckPage|undefined;
  const board={defaultPage:'home',transition:'none' as const,pages:[{id:'home',title:'Home',buttons:[{index:0,type:'app' as const,label:'App',bundleId:'com.apple.Terminal'}]}]};
  const common={board,pollMs:5,connect:async(callback:(index:number,edge:'down'|'up')=>void)=>{key=callback;return{write:async(value:DeckPage)=>{frame=value;},standby:async()=>{},close:async()=>{}};},monitor:async(callback:(state:SessionState)=>void)=>{callback({active:true,reason:'active'});return{stop:async()=>{}};}};
  const closed=await startDisplay(store,'/unused',common);
  await waitFor(()=>closed.status().inputEnabled);key(0,'down');key(0,'up');await waitFor(()=>JSON.stringify(frame).includes('실행 실패'));await closed.stop();
  let aborted=false;
  const display=await startDisplay(store,'/unused',{...common,execute:async(_effect,signal)=>new Promise<void>(resolve=>{signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});})});
  await waitFor(()=>display.status().inputEnabled);key(0,'down');key(0,'up');await Bun.sleep(10);await display.stop();expect(aborted).toBe(true);store.close();
});

test('locking between key release and scheduled execution prevents a new action',async()=>{
  const store=new SignalStore(':memory:');let key!:(index:number,edge:'down'|'up')=>void,session!:(state:SessionState)=>void,calls=0;
  const display=await startDisplay(store,'/unused',{board:{defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'open',label:'Open',url:'https://example.com'}]}]},pollMs:5,
    connect:async callback=>{key=callback;return{write:async()=>{},standby:async()=>{},close:async()=>{}};},
    monitor:async callback=>{session=callback;callback({active:true,reason:'active'});return{stop:async()=>{}};},execute:async()=>{calls++;},
  });
  try{await waitFor(()=>display.status().inputEnabled);key(0,'down');key(0,'up');session({active:false,reason:'locked'});await Bun.sleep(20);expect(calls).toBe(0);}
  finally{await display.stop();store.close();}
});
