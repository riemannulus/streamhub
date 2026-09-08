import { expect,test } from 'bun:test';
import { SignalStore } from './store';
import { startDisplay } from './display';
import type { SessionState } from './session-monitor';
import { SessionDeck, type DeckPage } from '../../streamdeck';

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
