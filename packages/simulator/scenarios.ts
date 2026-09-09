import { startSimulation,defaultSimulationBoard,type SimulationHost,type SimulationState } from './host';
import { ArtifactRecorder } from './artifacts';
import { renderKey } from '../streamdeck/render';
import type { DeckPage } from '../streamdeck';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
export async function until(description:string,predicate:()=>boolean|Promise<boolean>,timeoutMs=6000):Promise<void>{
  const deadline=performance.now()+timeoutMs;
  while(performance.now()<deadline){if(await predicate())return;await Bun.sleep(10);}
  throw new Error(`Timed out: ${description}`);
}
const label=(frame:DeckPage,text:string)=>frame.keys.some(key=>(key.type==='signal'||key.type==='pin')&&key.record?.label===text);

/** Require both expected semantics and the final exact RGB at every physical key. */
async function painted(sim:SimulationHost,description:string,predicate:(frame:DeckPage,state:SimulationState)=>boolean,inputEnabled=true){
  await until(description,async()=>{
    const state=await sim.state(),snapshot=sim.snapshot(),frame=snapshot.frame;
    if(!frame||frame.viewId!==state.display.pageId||snapshot.standby||state.display.inputEnabled!==inputEnabled||!predicate(frame,state))return false;
    const expected=await Promise.all(frame.keys.map(key=>renderKey(key,frame)));
    return expected.every((bytes,index)=>snapshot.pixels[index]?.equals(bytes));
  });
}
function tap(sim:SimulationHost,index:number){sim.key(index,'down');sim.key(index,'up');}
async function standby(sim:SimulationHost){await until('standby command and disabled input',async()=>sim.snapshot().standby&&!(await sim.state()).display.inputEnabled);}
type Scenario={name:string;description:string;latencyMs?:number;run(sim:SimulationHost,artifacts:ArtifactRecorder):Promise<void>};
export const scenarios:Scenario[]=[
  {name:'persistence',description:'HTTP 신호 저장, 수동 페이지와 SQLite 재시작 복원',async run(sim,artifacts){
    await sim.upsert({id:'build',label:'빌드 완료'});
    await sim.upsert({id:'review',label:'리뷰 대기',level:'warn'});
    await painted(sim,'received records displayed',frame=>label(frame,'빌드 완료')&&label(frame,'리뷰 대기'));
    await artifacts.screenshot('received');
    tap(sim,12);
    await painted(sim,'manual Terminal page',(_frame,state)=>state.display.pageId==='terminal'&&state.display.manual===true);
    const before=(await sim.state()).records;
    await sim.restart();
    await painted(sim,'saved page and records restored', (frame,state)=>state.display.pageId==='terminal'&&state.display.manual===true&&label(frame,'빌드 완료')&&label(frame,'리뷰 대기'));
    check((await sim.state()).records.length===before.length,'Restart lost persisted records');
    await artifacts.screenshot('restored');
    await sim.remove('build');
    await painted(sim,'HTTP removal reflected',frame=>!label(frame,'빌드 완료')&&label(frame,'리뷰 대기'));
  }},
  {name:'locked-update',description:'잠긴 동안 저장된 최신 신호를 해제 후 출력',async run(sim,artifacts){
    await sim.upsert({id:'job',label:'작업 진행'});
    await painted(sim,'initial job',frame=>label(frame,'작업 진행'));
    sim.setSession(false);await standby(sim);await artifacts.screenshot('locked');
    const afterStandby=sim.events.length;
    await sim.upsert({id:'job',label:'승인 대기',level:'urgent'});
    check((await sim.state()).records.some(record=>record.label==='승인 대기'),'Locked HTTP update was not stored');
    await Bun.sleep(100);
    check(!sim.events.slice(afterStandby).some(event=>event.type==='key'),'Pixels were written while suspended');
    sim.setSession(true);
    await painted(sim,'latest locked update restored',frame=>label(frame,'승인 대기')&&!label(frame,'작업 진행'));
    await artifacts.screenshot('unlocked-latest');
  }},
  {name:'held-key',description:'잠금을 가로지른 키 누름이 이전 동작을 실행하지 않음',async run(sim,artifacts){
    await painted(sim,'initial home',(_frame,state)=>state.display.pageId==='home');
    sim.key(12,'down');sim.setSession(false);await standby(sim);
    sim.setSession(true);
    await painted(sim,'redraw while held input remains gated',(_frame,state)=>state.display.pageId==='home',false);
    sim.key(12,'up');
    await painted(sim,'old key release does not navigate',(_frame,state)=>state.display.pageId==='home');
    await artifacts.screenshot('released-home');
    tap(sim,12);await painted(sim,'fresh key press navigates',(_frame,state)=>state.display.pageId==='terminal');
  }},
  {name:'app-routing',description:'앱 자동 선택, 수동 고정과 자동 모드 복귀',async run(sim,artifacts){
    await painted(sim,'initial home',(_frame,state)=>state.display.pageId==='home');
    sim.setContext('com.apple.Terminal');
    await painted(sim,'app routes Terminal',(_frame,state)=>state.display.pageId==='terminal'&&!state.display.manual);
    tap(sim,12);await painted(sim,'manual Home',(_frame,state)=>state.display.pageId==='home'&&state.display.manual===true);
    await Bun.sleep(350);
    check((await sim.state()).display.pageId==='home','App context overrode manual page');
    tap(sim,13);await painted(sim,'auto resumes Terminal',(_frame,state)=>state.display.pageId==='terminal'&&!state.display.manual);
    sim.setContext(null,false);await Bun.sleep(350);
    check((await sim.state()).display.pageId==='terminal','Unavailable context unexpectedly switched pages');
    await artifacts.screenshot('automatic-terminal');
  }},
  {name:'interrupted-transition',description:'전환 도중 잠금 및 연속 목적지 변경 후 최종 RGB 수렴',latencyMs:4,async run(sim,artifacts){
    await painted(sim,'initial home',(_frame,state)=>state.display.pageId==='home');
    let cursor=sim.events.length;
    sim.setContext('com.apple.Terminal');
    await until('transition has emitted partial RGB',()=>sim.snapshot().frame?.viewId==='terminal'&&sim.events.slice(cursor).some(event=>event.type==='key'));
    await artifacts.screenshot('partial-transition');
    sim.setSession(false);await standby(sim);
    const suspended=sim.events.length;await Bun.sleep(100);
    check(!sim.events.slice(suspended).some(event=>event.type==='key'),'Cancelled transition wrote after standby');
    sim.setSession(true);await painted(sim,'resume Terminal',(_frame,state)=>state.display.pageId==='terminal');
    cursor=sim.events.length;sim.setContext(null);
    await until('Home transition started',()=>sim.snapshot().frame?.viewId==='home'&&sim.events.slice(cursor).some(event=>event.type==='key'));
    sim.setContext('com.apple.Terminal');
    await painted(sim,'latest destination fully rendered',(_frame,state)=>state.display.pageId==='terminal');
    await artifacts.screenshot('latest-destination');
  }},
];

export type ScenarioResult={name:string;description:string;passed:boolean;durationMs:number;events:number;keyWrites:number;error?:string};
export async function runScenario(scenario:Scenario,directory:string,signal?:AbortSignal):Promise<ScenarioResult>{
  const started=performance.now(),artifacts=new ArtifactRecorder(directory);
  let sim:SimulationHost|undefined,error:string|undefined;
  const abort=()=>{void sim?.stop().catch(()=>{});};
  try{
    if(signal?.aborted)throw new Error('Simulation cancelled');
    sim=await startSimulation({board:{...defaultSimulationBoard,durationMs:500},latencyMs:scenario.latencyMs,onEvent:event=>artifacts.record(event)});
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)throw new Error('Simulation cancelled');
    await scenario.run(sim,artifacts);
    await artifacts.screenshot('final-active');
  }catch(cause){error=cause instanceof Error?cause.message:String(cause);await artifacts.screenshot('failure').catch(()=>{});}
  finally{
    signal?.removeEventListener('abort',abort);
    try{
      await sim?.stop();
      if(sim){check(sim.snapshot().standby,'Shutdown did not issue standby');check(sim.events.at(-1)?.type==='close','Shutdown did not close the virtual handle');}
    }catch(cause){error=[error,`Cleanup: ${String(cause)}`].filter(Boolean).join('; ');}
  }
  const result:ScenarioResult={name:scenario.name,description:scenario.description,passed:!error,durationMs:Math.round(performance.now()-started),events:sim?.events.length??0,keyWrites:sim?.events.filter(event=>event.type==='key').length??0,...(error?{error}:{})};
  try{await artifacts.finish(result);}catch(cause){
    result.passed=false;result.error=[result.error,`Artifacts: ${String(cause)}`].filter(Boolean).join('; ');
    await writeFile(join(directory,'summary.json'),JSON.stringify({result},null,2)+'\n').catch(()=>{});
  }
  return result;
}
