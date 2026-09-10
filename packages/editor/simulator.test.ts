import {expect,test} from 'bun:test';
import {SimulatorSession,sampleSignals,type SimulatorEvent} from './simulator';
import {startSimulation} from '../simulator/host';
import type {PageConfig} from '../streamdeck/pages';
const config:PageConfig={defaultPage:'home',transition:'none',pages:[
  {id:'home',title:'홈',signals:{},buttons:[{index:0,type:'page',pageId:'dev'}]},
  {id:'dev',title:'개발',match:{appBundleId:'com.test.Editor'},signals:{source:'demo'}},
]};
const waitFor=async(predicate:()=>boolean)=>{
  const deadline=Date.now()+4000;
  while(!predicate()){if(Date.now()>deadline)throw new Error('Simulator condition timed out');await Bun.sleep(10);}
};
function fixture(){
  const events:SimulatorEvent[]=[];
  const sim=new SimulatorSession(config,['demo'],event=>events.push(event));
  const state=()=>events.filter((event):event is Extract<SimulatorEvent,{type:'state'}>=>event.type==='state').at(-1)!;
  return{sim,events,state};
}
test('simulator uses actual RGB renderer and shared manual/auto page selection',async()=>{
  const {sim,events,state}=fixture();
  try{
    await waitFor(()=>state()?.inputEnabled);
    const pixels=events.filter(event=>event.type==='key');
    expect(pixels.length).toBeGreaterThanOrEqual(15);
    const key=pixels[0] as Extract<SimulatorEvent,{type:'key'}>;
    expect(Buffer.from(key.rgb,'base64').length).toBe(72*72*3);
    expect(Buffer.from(key.rgb,'base64').some(value=>value!==0)).toBe(true);
    await sim.command({type:'page',pageId:'dev'});
    await waitFor(()=>state().pageId==='dev'&&state().inputEnabled);
    expect(state().pageId).toBe('dev');expect(state().manual).toBe(true);
    await sim.command({type:'context',available:true,appBundleId:null});
    await Bun.sleep(350);expect(state().pageId).toBe('dev');
    await sim.command({type:'auto'});
    await waitFor(()=>state().pageId==='home'&&state().inputEnabled);
    await sim.command({type:'context',available:true,appBundleId:'com.test.Editor'});
    await waitFor(()=>state().pageId==='dev'&&state().inputEnabled);
    expect(state().manual).toBe(false);
  }finally{await sim.stop();}
});
test('lock cancels held input and resumes only after release',async()=>{
  const {sim,events,state}=fixture();
  try{
    await waitFor(()=>state()?.inputEnabled);
    await sim.command({type:'key',index:0,edge:'down'});
    await sim.command({type:'lock',locked:true});
    await waitFor(()=>events.some(event=>event.type==='standby'));
    expect(state().locked).toBe(true);expect(state().inputEnabled).toBe(false);
    await sim.command({type:'lock',locked:false});
    await sim.command({type:'key',index:0,edge:'up'});
    await waitFor(()=>state().inputEnabled);
    expect(state().pageId).toBe('home');
    await sim.command({type:'key',index:0,edge:'down'});
    await sim.command({type:'key',index:0,edge:'up'});
    await waitFor(()=>state().pageId==='dev'&&state().inputEnabled);
  }finally{await sim.stop();}
});
test('invalid drafts and commands leave selected board unchanged',async()=>{
  const {sim,state}=fixture();
  try{
    await waitFor(()=>state()?.inputEnabled);
    await expect(sim.command({type:'draft',board:{...config,pages:[{id:'other',title:'bad',signals:{source:'unknown'}}],defaultPage:'other'}})).rejects.toThrow('Unknown signal source');
    await expect(sim.command({type:'page',pageId:'missing'})).rejects.toThrow('Unknown page');
    await expect(sim.command({type:'latency',ms:101})).rejects.toThrow();
    expect(state().pageId).toBe('home');
    await sim.command({type:'draft',board:config,selectedPage:'dev'});
    await waitFor(()=>state().pageId==='dev'&&state().inputEnabled);
  }finally{await sim.stop();}
});
test('slow transport records completed frames and stop silences all callbacks',async()=>{
  const {sim,events,state}=fixture();
  await waitFor(()=>state()?.inputEnabled);
  await sim.command({type:'latency',ms:10});
  const framesBefore=state().frames;
  await sim.command({type:'page',pageId:'dev'});
  expect(state().inputEnabled).toBe(false);
  await waitFor(()=>state().inputEnabled);
  expect(state().lastFrameMs).toBeGreaterThanOrEqual(120);
  expect(state().frames).toBeGreaterThan(framesBefore);expect(state().keysSent).toBe(state().frames*15);
  await sim.command({type:'latency',ms:100});
  await sim.command({type:'page',pageId:'home'});
  await sim.stop();
  const count=events.length;
  await Bun.sleep(150);expect(events.length).toBe(count);
  await expect(sim.command({type:'auto'})).rejects.toThrow('stopped');
});
test('fade uses intermediate RGB frames and rapid destinations settle at the latest page',async()=>{
  const events:SimulatorEvent[]=[];
  const sim=new SimulatorSession({...config,transition:'fade',durationMs:100},['demo'],event=>events.push(event));
  const state=()=>events.filter((event):event is Extract<SimulatorEvent,{type:'state'}>=>event.type==='state').at(-1)!;
  try{
    await waitFor(()=>state()?.inputEnabled);
    await sim.command({type:'page',pageId:'dev'});
    await waitFor(()=>state().inputEnabled);
    expect(state().frames).toBeGreaterThan(2);
    await sim.command({type:'page',pageId:'home'});
    await Bun.sleep(30);
    await sim.command({type:'page',pageId:'dev'});
    await waitFor(()=>state().pageId==='dev'&&state().inputEnabled);
    expect(state().pageId).toBe('dev');
    expect(events.some(event=>event.type==='error')).toBe(false);
  }finally{await sim.stop();}
});

test('browser adapter and headless host produce identical final RGB through shared runtime',async()=>{
  const board:PageConfig={defaultPage:'home',transition:'none',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'text',label:'HOME'}]},{id:'work',title:'Work',signals:{source:'demo'},buttons:[{index:13,type:'auto',label:'Auto'}]}]};
  const events:SimulatorEvent[]=[];
  const browser=new SimulatorSession(board,['demo'],event=>events.push(event));
  const headless=await startSimulation({board,sources:['demo']});
  const state=()=>events.filter((event):event is Extract<SimulatorEvent,{type:'state'}>=>event.type==='state').at(-1);
  try{
    await browser.command({type:'signals',count:1});
    await headless.replaceSignals(sampleSignals(1,['demo']));
    await browser.command({type:'page',pageId:'work'});
    await headless.selectPage('work');
    await waitFor(()=>state()?.pageId==='work'&&!!state()?.inputEnabled);
    const deadline=Date.now()+4000;
    while(!(await headless.state()).display.inputEnabled){if(Date.now()>deadline)throw new Error('Headless display did not settle');await Bun.sleep(10);}
    const rgb:(string|null)[]=Array(15).fill(null);
    for(const event of events)if(event.type==='key')rgb[event.index]=event.rgb;
    expect(rgb).toEqual(headless.snapshot().pixels.map(pixel=>pixel?.toString('base64')??null));
    expect((await headless.state()).records).toHaveLength(1);
  }finally{await Promise.all([browser.stop(),headless.stop()]);}
});
test('immediate stop and queued commands cannot leak a host or callbacks',async()=>{
  const events:SimulatorEvent[]=[];
  const session=new SimulatorSession(config,['demo'],event=>events.push(event));
  const pending=session.command({type:'signals',count:48}).then(()=>null,error=>error);
  const first=session.stop();expect(session.stop()).toBe(first);
  await first;expect((await pending)?.message).toContain('stopped');
  const count=events.length;await Bun.sleep(80);expect(events).toHaveLength(count);
});
test('signal editor commands use source-scoped lifecycle state',async()=>{
  const {sim,state}=fixture();
  const records=()=>state()?.records as Array<{source:string;id:string;label:string;level:string;freshness:string}>|undefined;
  try{
    await waitFor(()=>state()?.inputEnabled);
    await sim.command({type:'signal-upsert',source:'demo',id:'manual',label:'직접 추가',level:'urgent'});
    expect(records()?.find(record=>record.id==='manual')).toMatchObject({source:'demo',label:'직접 추가',level:'urgent',freshness:'fresh'});
    await sim.command({type:'source-stale',source:'demo'});
    expect(records()?.find(record=>record.id==='manual')?.freshness).toBe('stale');
    await expect(sim.command({type:'signal-upsert',source:'missing',id:'manual',label:'잘못된 소스',level:'info'})).rejects.toThrow('Unknown signal source');
    expect(records()?.some(record=>record.label==='잘못된 소스')).toBe(false);
    await sim.command({type:'signal-remove',source:'demo',id:'manual'});
    expect(records()?.some(record=>record.id==='manual')).toBe(false);
  }finally{await sim.stop();}
});
