import { mkdirSync, writeFileSync } from 'node:fs';
import { SessionDeck } from '../packages/streamdeck';
import { DisplayLifecycle } from '../packages/streamdeck/lifecycle';
import { openHidDisplay } from '../packages/streamdeck/hid';
import { startSessionMonitor } from '../packages/host/src/session-monitor';

const sessionMode=process.argv.includes('--session');
if(process.argv.slice(2).some(arg=>arg!=='--session'))throw new Error('Usage: bun run hid:lifecycle-check [--session]');
if(sessionMode)console.log('Runtime 단위의 재시작/복구 합격 판정에는 bun run display:check --mode hid를 사용하세요.');
const events:Array<{at:string;event:string}>=[];
const log=(event:string)=>{events.push({at:new Date().toISOString(),event});console.log(event);};
const errors:string[]=[];
let lifecycle:DisplayLifecycle;
lifecycle=new DisplayLifecycle(async()=>{
  const device=await openHidDisplay((index,edge)=>{lifecycle.noteKey(index,edge);},error=>{errors.push(String(error));void lifecycle.disconnected();});
  log('HID opened');
  return {
    write:async(frame,signal)=>{await device.write(frame,signal);if(!signal.aborted)log('full frame written');},
    standby:async()=>{await device.standby();log('standby command sent');},
    close:async()=>{await device.close();log('HID closed');},
  };
},{onError:error=>{errors.push(String(error));log(`ERROR: ${String(error)}`);}});
const deck=new SessionDeck();
const records=(label:string)=>[{source:'check',id:'check',kind:'live' as const,level:'info' as const,label,revision:Date.now(),createdAt:1,updatedAt:Date.now(),freshness:'fresh' as const}];
let monitor:Awaited<ReturnType<typeof startSessionMonitor>>|undefined;
let interrupted=false;
let suspended=false,resumed=false;
process.once('SIGINT',()=>{interrupted=true;void lifecycle.stop();});
process.once('SIGTERM',()=>{interrupted=true;void lifecycle.stop();});
try {
  deck.update(records('ACTIVE'));await lifecycle.present(deck.page());
  if(sessionMode){
    monitor=await startSessionMonitor(state=>{log(`session: ${state.reason}`);if(!state.active && state.reason!=='monitor-unavailable')suspended=true;if(state.active && suspended)resumed=true;void lifecycle.setAllowed(state.active);},{cacheDir:'.streamhub/native'});
    log('Observing actual lock/unlock for 300 seconds; no actions are attached.');
    const until=performance.now()+300000;
    while(!interrupted && performance.now()<until)await Bun.sleep(200);
  }else{
    await lifecycle.setAllowed(false);
    await lifecycle.setAllowed(true);await Bun.sleep(700);
    await lifecycle.setAllowed(false);await Bun.sleep(700);
    deck.update(records('RESTORED'));await lifecycle.present(deck.page());
    await lifecycle.setAllowed(true);await Bun.sleep(700);
  }
}finally{
  await lifecycle.stop();await monitor?.stop();
  mkdirSync('.streamhub',{recursive:true,mode:0o700});
  writeFileSync('.streamhub/hid-lifecycle-check.json',JSON.stringify({checkedAt:new Date().toISOString(),mode:sessionMode?'native-session':'lifecycle-transitions',events,errors,transitionObserved:sessionMode ? suspended && resumed : true},null,2)+'\n',{mode:0o600});
}
if(errors.length)throw new Error('HID lifecycle check encountered errors');
if(sessionMode && !(suspended && resumed)){console.log('INCOMPLETE: native suspend/resume was not observed; device returned to standby.');process.exitCode=2;}
else console.log('PASS: lifecycle operations completed; device returned to standby.');
