import { mkdirSync, writeFileSync } from 'node:fs';
import { SignalStore } from '../packages/host/src/store';
import {startLegacySimulationDisplay} from '../packages/simulator/legacy-display';
import { openHidDisplay } from '../packages/streamdeck/hid';
import type { ApplicationContext } from '../packages/host/src/app-context';

if(process.argv.length>2)throw new Error('Usage: bun run hid:pages-check');
console.log('Stop any running Streamhub host and Elgato app before this diagnostic.');
const store=new SignalStore(':memory:');
const events:Array<{at:string;event:string;elapsedMs?:number}>=[];
const log=(event:string,elapsedMs?:number)=>{events.push({at:new Date().toISOString(),event,...(elapsedMs===undefined?{}:{elapsedMs})});console.log(event,elapsedMs===undefined?'':`${elapsedMs.toFixed(1)}ms`);};
for(const [source,label] of [['home','HOME'],['work','WORK']] as const){
  for(let i=0;i<8;i++)store.apply({op:'upsert',source,deliveryId:`${source}-${i}`,signal:{kind:'live',id:String(i),label:`${label} ${i+1}`,level:source==='home'?'info':'warn'}});
}
let context!:(context:ApplicationContext)=>void;
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());
process.once('SIGTERM',()=>controller.abort());
let display:Awaited<ReturnType<typeof startLegacySimulationDisplay>>|undefined;
try{
  display=await startLegacySimulationDisplay(store,'.streamhub',{
    signal:controller.signal,
    board:{defaultPage:'home',transition:'fade',durationMs:250,pages:[
      {id:'home',title:'Home',signals:{source:'home'}},
      {id:'work',title:'Work',match:{appBundleId:'streamhub.demo.work'},signals:{source:'work'}},
    ]},
    context:async(callback)=>{context=callback;callback({available:true,appBundleId:null});return{stop:async()=>{}};},
    connect:async(onKey,onError)=>{
      const device=await openHidDisplay(onKey,onError);
      return{
        write:async(frame,signal)=>{const started=performance.now();await device.write(frame,signal);if(!signal.aborted)log(`frame: ${frame.viewId}`,performance.now()-started);},
        standby:async()=>{await device.standby();log('standby');},
        close:async()=>{await device.close();log('closed');},
      };
    },
  });
  for(const pageId of ['home','work','home','work','home']){
    if(controller.signal.aborted)break;
    context({available:true,appBundleId:pageId==='work'?'streamhub.demo.work':null});
    const deadline=performance.now()+10000;
    while(!controller.signal.aborted && !(display.status().pageId===pageId && display.status().inputEnabled)){
      if(performance.now()>deadline)throw new Error('Page did not become ready; check device connection and unlock the Mac.');
      await Bun.sleep(25);
    }
    const until=performance.now()+1500;
    while(!controller.signal.aborted && performance.now()<until)await Bun.sleep(50);
  }
}finally{
  try{await display?.stop();}finally{store.close();}
  mkdirSync('.streamhub',{recursive:true,mode:0o700});
  writeFileSync('.streamhub/hid-pages-check.json',JSON.stringify({events,interrupted:controller.signal.aborted},null,2)+'\n',{mode:0o600});
}
console.log(controller.signal.aborted?'Stopped; device cleanup completed.':'PASS: page transitions completed; device returned to standby.');
