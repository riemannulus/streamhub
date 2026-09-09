import { expect, test } from 'bun:test';
import { SessionDeck } from './index';
import { HidDisplay } from './hid';

test('a suspended frame stops after the current key before standby and release',async()=>{
  const commands:string[]=[];let release!:()=>void;
  const hardware={fillKeyBuffer:async(index:number,bytes:Uint8Array)=>{expect(bytes.length).toBe(72*72*3);commands.push(`write:${index}`);await new Promise<void>(resolve=>{release=resolve;});}, resetToLogo:async()=>{commands.push('logo');},close:async()=>{commands.push('close');}};
  const display=new HidDisplay(hardware);const abort=new AbortController();
  const work=display.write(new SessionDeck().page(),abort.signal);
  while(!release) await Bun.sleep(1);
  abort.abort();release();await work;
  await display.standby();await display.close();
  expect(commands).toEqual(['write:0','logo','close']);
});

test('complete frames write all physical positions and close is idempotent',async()=>{
  const keys:number[]=[];let closed=0;
  const display=new HidDisplay({fillKeyBuffer:async(index:number)=>{keys.push(index);},resetToLogo:async()=>{},close:async()=>{closed++;}});
  await display.write(new SessionDeck().page(),new AbortController().signal);
  expect(keys).toEqual([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14]);
  await display.close();await display.close();expect(closed).toBe(1);
  await expect(display.write(new SessionDeck().page(),new AbortController().signal)).rejects.toThrow();
});

function animationHarness(cost=0){
  let time=0;const sent:{index:number;value:number}[]=[];let afterWrite:()=>void=()=>{};
  const display=new HidDisplay({fillKeyBuffer:async(index,bytes)=>{sent.push({index,value:bytes[0]});time+=cost;afterWrite();},resetToLogo:async()=>{},close:async()=>{}},()=>{},{now:()=>time,wait:async(ms)=>{time+=ms;},render:async(key)=>Buffer.alloc(72*72*3,key.type==='tile'?Number(key.label):0)});
  const page=(id:string,value:number)=>({...new SessionDeck().page(),viewId:id,transition:{type:'fade' as const,durationMs:250},keys:Array.from({length:15},(_,index)=>({type:'tile' as const,index,label:String(value)}))});
  return {display,sent,page,setAfterWrite:(fn:()=>void)=>{afterWrite=fn;}};
}

test('first and same-page frames are immediate, changed pages fade and finish exact',async()=>{
  const h=animationHarness();const signal=new AbortController().signal;
  await h.display.write(h.page('a',100),signal);expect(h.sent.length).toBe(15);
  await h.display.write(h.page('a',120),signal);expect(h.sent.length).toBe(30);
  h.sent.length=0;await h.display.write(h.page('b',200),signal);
  expect(h.sent.filter(item=>item.index===0).map(item=>item.value)).toEqual([72,24,40,120,200]);
  expect(h.sent.slice(-15).every(item=>item.value===200)).toBe(true);
});

test('slow transport skips intermediate deadlines rather than accumulating stale frames',async()=>{
  const h=animationHarness(20);const signal=new AbortController().signal;
  await h.display.write(h.page('a',100),signal);h.sent.length=0;
  await h.display.write(h.page('b',200),signal);
  expect(h.sent.length).toBe(30);expect(h.sent.slice(-15).every(item=>item.value===200)).toBe(true);
});

test('retargeting an interrupted fade starts with each key actually sent, including return to original page',async()=>{
  const h=animationHarness();await h.display.write(h.page('a',100),new AbortController().signal);
  const cancel=new AbortController();h.sent.length=0;
  h.setAfterWrite(()=>{if(h.sent.length===3)cancel.abort();});
  await h.display.write(h.page('b',200),cancel.signal);expect(h.sent.length).toBe(3);
  h.setAfterWrite(()=>{});h.sent.length=0;
  await h.display.write(h.page('a',100),new AbortController().signal);
  expect(h.sent.slice(0,4).map(item=>item.value)).toEqual([36,36,36,60]);
  expect(h.sent.slice(-15).every(item=>item.value===100)).toBe(true);
});

test('an interrupted initial frame does not animate unknown physical keys',async()=>{
  const h=animationHarness();const cancel=new AbortController();
  h.setAfterWrite(()=>cancel.abort());await h.display.write(h.page('a',100),cancel.signal);
  h.setAfterWrite(()=>{});h.sent.length=0;
  await h.display.write(h.page('b',200),new AbortController().signal);
  expect(h.sent.length).toBe(15);expect(h.sent.every(item=>item.value===200)).toBe(true);
});

test('canceling during a timed wait returns promptly without sending another key',async()=>{
  let writes=0;const display=new HidDisplay({fillKeyBuffer:async()=>{writes++;},resetToLogo:async()=>{},close:async()=>{}},()=>{},{render:async()=>Buffer.alloc(72*72*3)});
  const page={...new SessionDeck().page(),viewId:'a',transition:{type:'fade' as const,durationMs:500}};
  await display.write(page,new AbortController().signal);
  const cancel=new AbortController();const work=display.write({...page,viewId:'b'},cancel.signal);
  await Bun.sleep(5);cancel.abort();
  await Promise.race([work,Bun.sleep(100).then(()=>{throw new Error('Abort did not interrupt animation wait');})]);
  expect(writes).toBe(15);
});
