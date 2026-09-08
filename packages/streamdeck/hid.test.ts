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
