import {expect,test} from 'bun:test';
import {executeProgram,type ActionResult} from './composite';
import type {ActionProgram,ButtonAction} from '../studio/document';

const ok:ActionResult={ok:true};
const action=(name:string):ButtonAction=>({type:'open-url',url:`https://${name}.example/`});
const sequence=(mode:'sequential'|'parallel',steps:ActionProgram extends never?never:any[]):ActionProgram=>({type:'sequence',sequence:{mode,steps}});

test('sequential programs preserve order, delay and short-circuit failure',async()=>{
  const events:string[]=[],controller=new AbortController();
  const program=sequence('sequential',[{type:'action',action:action('one')},{type:'delay',milliseconds:25},{type:'action',action:action('two')},{type:'action',action:action('three')}]);
  const result=await executeProgram(program,{signal:controller.signal,sleep:async milliseconds=>{events.push(`delay:${milliseconds}`);return true;},run:async leaf=>{const name=(leaf as Extract<ButtonAction,{type:'open-url'}>).url.split('.')[0]!.slice(8);events.push(name);return name==='two'?{ok:false,code:'failed',message:'two failed'}:ok;}});
  expect(events).toEqual(['one','delay:25','two']);
  expect(result).toEqual({ok:false,code:'failed',message:'two failed'});
});

test('parallel programs start once in order, wait for all and return first failure by step order',async()=>{
  const starts:string[]=[],releases:Record<string,()=>void>={},controller=new AbortController();
  const promise=executeProgram(sequence('parallel',['one','two','three'].map(name=>({type:'action',action:action(name)}))),{signal:controller.signal,run:leaf=>new Promise(resolve=>{const name=(leaf as Extract<ButtonAction,{type:'open-url'}>).url.split('.')[0]!.slice(8);starts.push(name);releases[name]=()=>resolve(name==='one'?{ok:false,code:'first',message:'first'}:name==='two'?{ok:false,code:'second',message:'second'}:ok);})});
  await Bun.sleep(0);expect(starts).toEqual(['one','two','three']);
  releases.three!();releases.two!();releases.one!();
  expect(await promise).toEqual({ok:false,code:'first',message:'first'});
  expect(starts).toHaveLength(3);
});

test('cancellation stops delays, reaches actions and prevents later invocation',async()=>{
  const controller=new AbortController(),calls:string[]=[];
  let releaseDelay:(value:boolean)=>void=()=>{};
  const promise=executeProgram(sequence('sequential',[{type:'delay',milliseconds:100},{type:'action',action:action('late')}]),{signal:controller.signal,sleep:()=>new Promise(resolve=>{releaseDelay=resolve;}),run:async leaf=>{calls.push(leaf.type);return ok;}});
  controller.abort();releaseDelay(false);
  expect(await promise).toEqual({ok:false,code:'cancelled',message:'Action cancelled'});expect(calls).toEqual([]);

  const second=new AbortController();let observed=false;
  const running=executeProgram({type:'single',action:action('running')},{signal:second.signal,run:async(_leaf,signal)=>{await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{observed=true;resolve();},{once:true}));return ok;}});
  second.abort();expect(await running).toEqual({ok:false,code:'cancelled',message:'Action cancelled'});expect(observed).toBe(true);
  const preAborted=new AbortController();preAborted.abort();let invoked=0;await executeProgram({type:'single',action:action('never')},{signal:preAborted.signal,run:async()=>{invoked++;return ok;}});expect(invoked).toBe(0);
});

test('toggle uses its declared initial branch without retrying uncertain results',async()=>{
  const calls:string[]=[],controller=new AbortController(),program:ActionProgram={type:'toggle',initial:'on',offToOn:{mode:'sequential',steps:[{type:'action',action:action('on')}]},onToOff:{mode:'sequential',steps:[{type:'action',action:action('off')}]}};
  expect(await executeProgram(program,{signal:controller.signal,run:async leaf=>{calls.push((leaf as any).url);return{ok:false,code:'uncertain',message:'unknown'};}})).toEqual({ok:false,code:'uncertain',message:'unknown'});
  expect(calls).toEqual(['https://off.example/']);
});
