import {expect,test} from 'bun:test';
import {SimulatorSession,type SimulatorEvent} from './simulator';
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
    expect(pixels.length).toBe(15);
    const key=pixels[0] as Extract<SimulatorEvent,{type:'key'}>;
    expect(Buffer.from(key.rgb,'base64').length).toBe(72*72*3);
    expect(Buffer.from(key.rgb,'base64').some(value=>value!==0)).toBe(true);
    await sim.command({type:'page',pageId:'dev'});
    await waitFor(()=>state().inputEnabled);
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
  await sim.command({type:'page',pageId:'dev'});
  expect(state().inputEnabled).toBe(false);
  await waitFor(()=>state().inputEnabled);
  expect(state().lastFrameMs).toBeGreaterThanOrEqual(120);
  expect(state().frames).toBe(2);expect(state().keysSent).toBe(30);
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
    await waitFor(()=>state().inputEnabled);
    expect(state().pageId).toBe('dev');
    expect(events.some(event=>event.type==='error')).toBe(false);
  }finally{await sim.stop();}
});
