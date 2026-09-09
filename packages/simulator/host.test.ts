import { expect, test } from 'bun:test';
import { renderKey } from '../streamdeck/render';
import { startSimulation, type SimulationHost } from './host';
async function ready(sim:SimulationHost,label?:string){
  const end=Date.now()+4000;
  while(Date.now()<end){if((await sim.state()).display.inputEnabled && sim.snapshot().pixels.every(Boolean) && (!label||sim.snapshot().frame?.keys.some(key=>key.type==='signal'&&key.record.label===label)))return;await Bun.sleep(10);}
  throw new Error('Simulator did not become ready');
}
test('real HTTP stores signals, survives restart and preserves manual page layout',async()=>{
  const sim=await startSimulation({board:{defaultPage:'home',transition:'none',pages:[
    {id:'home',title:'Home',signals:{},buttons:[{index:12,type:'page',pageId:'terminal'}]},
    {id:'terminal',title:'Terminal',signals:{},buttons:[{index:12,type:'page',pageId:'home'}]},
  ]}});
  try{
    await sim.upsert({id:'one',label:'Persisted signal'});await ready(sim,'Persisted signal');
    const painted=sim.snapshot();
    for(const key of painted.frame!.keys)expect(painted.pixels[key.index]!.equals(await renderKey(key,painted.frame!))).toBe(true);
    expect((await sim.state()).records[0].label).toBe('Persisted signal');
    sim.key(12,'down');sim.key(12,'up');await ready(sim);
    expect((await sim.state()).display.pageId).toBe('terminal');
    await sim.restart();await ready(sim);
    expect((await sim.state()).records[0].id).toBe('one');
    expect((await sim.state()).display.pageId).toBe('terminal');
    expect((await sim.state()).display.manual).toBe(true);
    expect(sim.events.some(event=>event.type==='frame')).toBe(true);
    await sim.remove('one');expect((await sim.state()).records).toHaveLength(0);
  }finally{await sim.stop();}
});
test('locked updates remain stored and unlock sends the newest actual RGB frame',async()=>{
  const sim=await startSimulation();
  try{
    await sim.upsert({id:'one',label:'Before'});await ready(sim,'Before');
    const before=Buffer.concat(sim.snapshot().pixels as Buffer[]);
    sim.setSession(false);await Bun.sleep(50);
    expect(sim.snapshot().standby).toBe(true);
    expect((await sim.state()).display.inputEnabled).toBe(false);
    await sim.upsert({id:'one',label:'After',level:'urgent'});await Bun.sleep(50);
    expect(sim.snapshot().standby).toBe(true);
    sim.setSession(true);await ready(sim,'After');
    const painted=sim.snapshot();
    for(const key of painted.frame!.keys)expect(painted.pixels[key.index]!.equals(await renderKey(key,painted.frame!))).toBe(true);
    expect((await sim.state()).records[0].label).toBe('After');
    expect(Buffer.concat(sim.snapshot().pixels as Buffer[]).equals(before)).toBe(false);
    expect(sim.snapshot().standby).toBe(false);
  }finally{await sim.stop();}
});
