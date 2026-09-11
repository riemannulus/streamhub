import {expect,test} from 'bun:test';
import sharp from 'sharp';
import type {DeckBackendEvents,DeckSurface,PresentationRequest} from '../../presentation/backend';
import {HidDisplay} from '../../streamdeck/hid';
import {startHidBackend} from './hid-backend';

const makeSurface=async(identity:string,color:string):Promise<DeckSurface>=>{const png=await sharp({create:{width:480,height:272,channels:4,background:color}}).png().toBuffer(),key=await sharp({create:{width:72,height:72,channels:4,background:color}}).png().toBuffer();return{identity,png,keyPngs:Array.from({length:15},()=>key)};};
const from=await makeSurface('from','#000000'),to=await makeSurface('to','#ff0000');
const request=(generation='g1',reason:PresentationRequest['reason']='page'):PresentationRequest=>({generation,reason,from,to,transition:{type:'none',durationMs:0},inputEnabled:reason!=='standby'});

test('HID backend prepares without opening USB and presents exact RGB',async()=>{
  const writes:Buffer[][]=[],keys:unknown[]=[];let connects=0,current:Buffer[]=[];
  const events:DeckBackendEvents={key:event=>keys.push(event),ready:()=>{}};
  const backend=await startHidBackend({events,connect:async onKey=>{connects++;return new HidDisplay({fillKeyBuffer:async(index,bytes)=>{current[index]=Buffer.from(bytes);if(index===14){writes.push(current);current=[];}},resetToLogo:async()=>{},close:async()=>{}},()=>{},{});}});
  const prepared=await backend.prepare(request());expect(connects).toBe(0);
  await backend.present(prepared);expect(connects).toBe(1);expect(writes.at(-1)).toHaveLength(15);expect([...writes.at(-1)![0]!.subarray(0,3)]).toEqual([255,0,0]);expect(backend.status()).toMatchObject({mode:'hid',state:'ready',connected:true});
  await backend.stop();
});

test('HID standby keeps the exact Studio surface and device handle while suppressing input',async()=>{
  const order:string[]=[],last:Buffer[]=[],keys:unknown[]=[];let onKey:((index:number,phase:'down'|'up')=>void)|undefined,connects=0;
  const backend=await startHidBackend({events:{key:event=>keys.push(event),ready:()=>{}},connect:async callback=>{connects++;onKey=callback;return new HidDisplay({fillKeyBuffer:async(index,bytes)=>{last[index]=Buffer.from(bytes);if(index===14)order.push('frame');},resetToLogo:async()=>{order.push('logo');},close:async()=>{order.push('close');}});}});
  await backend.present(await backend.prepare(request('g-lock','standby')));
  onKey?.(0,'down');onKey?.(0,'up');
  expect(order).toEqual(['frame']);expect([...last[0]!.subarray(0,3)]).toEqual([255,0,0]);expect(backend.status()).toMatchObject({state:'ready',connected:true});expect(keys).toEqual([]);
  await backend.present(await backend.prepare(request('g-unlock','unlock')));
  expect(connects).toBe(1);expect(order).toEqual(['frame','frame']);
  await backend.stop();
  expect(order).toEqual(['frame','frame','logo','close']);
});

test('HID ownership failure remains selected and exposes only bounded guidance',async()=>{
  const backend=await startHidBackend({events:{key:()=>{},ready:()=>{}},connect:async()=>{throw Object.assign(new Error('secret device path'),{code:'LIBUSB_ERROR_ACCESS'});}});
  await expect(backend.present(await backend.prepare(request()))).resolves.toBeUndefined();
  expect(backend.status()).toEqual({mode:'hid',state:'unavailable',connected:false,message:'Stream Deck 앱을 완전히 종료한 뒤 Runtime을 다시 시작하세요.'});
  await backend.stop();await backend.stop();
});
