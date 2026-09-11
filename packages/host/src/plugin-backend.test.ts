import {expect,test} from 'bun:test';
import sharp from 'sharp';
import type {PluginToRuntimeMessage,RuntimeToPluginMessage} from '../../presentation/protocol';
import type {DeckBackendEvents,DeckSurface,PresentationRequest} from '../../presentation/backend';
import {startPluginBackend,type PluginGatewayFactory,type PluginGatewayHandlers} from './plugin-backend';

const png=await sharp({create:{width:480,height:272,channels:4,background:'#225588'}}).png().toBuffer();
const key=await sharp({create:{width:72,height:72,channels:4,background:'#225588'}}).png().toBuffer();
const surface=(identity:string):DeckSurface=>({identity,png,keyPngs:Array.from({length:15},()=>key)});
const request=(generation:string,reason:PresentationRequest['reason']='page'):PresentationRequest=>({generation,reason,from:surface('from'),to:surface('to'),transition:reason==='unlock'?{type:'crossfade',durationMs:120}:{type:'none',durationMs:0},inputEnabled:reason!=='standby'});
function fixture(fail?:Error){
  const sent:RuntimeToPluginMessage[]=[],keys:unknown[]=[],ready:{count:number}={count:0};let handlers!:PluginGatewayHandlers,stops=0;
  const gatewayFactory:PluginGatewayFactory=next=>{if(fail)throw fail;handlers=next;return{url:new URL('ws://127.0.0.1:31417'),publish:message=>{sent.push(message);},status:()=>({connected:true,deviceId:'deck'}),stop:()=>{stops++;}};};
  const events:DeckBackendEvents={key:event=>keys.push(event),ready:()=>{ready.count++;}};
  return{sent,keys,ready,get handlers(){return handlers;},get stops(){return stops;},start:()=>startPluginBackend({port:31417,token:'x'.repeat(32),events,gatewayFactory})};
}

test('plugin backend prepares silently and presents one exact immediate plan',async()=>{
  const f=fixture(),backend=await f.start(),prepared=await backend.prepare(request('g1'));
  expect(f.sent).toEqual([]);
  await backend.present(prepared);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({type:'presentation',delivery:'immediate',plan:{generation:'g1'},inputEnabled:true});
  expect((f.sent[0] as any).plan.frames.at(-1).keys.every((value:string)=>value.startsWith('data:image/png;base64,'))).toBe(true);
  await backend.stop();await backend.stop();expect(f.stops).toBe(1);
});

test('plugin backend advertises unlock preparation and suppresses reconnect until its final frame',async()=>{
  const f=fixture(),backend=await f.start(),prepared=await backend.prepare(request('g2','unlock'));
  expect(f.sent.at(-1)).toMatchObject({type:'presentation',delivery:'prepare',trigger:'unlock',inputEnabled:false,plan:{generation:'g2'}});
  f.handlers.message({v:1,type:'cells-ready',deviceId:'deck'});expect(f.ready.count).toBe(0);
  await backend.present(prepared);
  const resumed=f.sent.at(-1) as Extract<RuntimeToPluginMessage,{type:'presentation'}>;
  expect(resumed).toMatchObject({delivery:'resume',trigger:'unlock',plan:{generation:'g2'}});
  expect(backend.status().state).toBe('recovering');
  f.handlers.message({v:1,type:'frame-sent',generation:'g2',frame:0});
  expect(backend.status().state).toBe('recovering');
  f.handlers.message({v:1,type:'frame-sent',generation:'g2',frame:resumed.plan.frames.length-1});
  expect(backend.status().state).toBe('ready');
  f.handlers.message({v:1,type:'cells-ready',deviceId:'deck'});expect(f.ready.count).toBe(1);
  f.handlers.message({v:1,type:'key',phase:'down',index:3,generation:'stale'});
  f.handlers.message({v:1,type:'key',phase:'up',index:3,generation:'g2'});
  expect(f.keys).toEqual([{index:3,phase:'up',generation:'g2'}]);
  await backend.stop();
});

test('plugin backend rejects stale and foreign prepared values',async()=>{
  const f=fixture(),backend=await f.start(),first=await backend.prepare(request('g1')),second=await backend.prepare(request('g2'));
  await expect(backend.present(first)).rejects.toThrow('stale');
  await expect(backend.present({...second,backend:'hid'})).rejects.toThrow('different backend');
  await backend.stop();
});

test('plugin gateway startup failure remains selected with a bounded public status',async()=>{
  const f=fixture(Object.assign(new Error('listen EADDRINUSE secret'),{code:'EADDRINUSE'})),backend=await f.start();
  expect(backend.status()).toEqual({mode:'plugin',state:'unavailable',connected:false,message:'Stream Deck 플러그인 연결을 시작하지 못했습니다.'});
  await expect(backend.present(await backend.prepare(request('g1')))).resolves.toBeUndefined();
  await backend.stop();expect(f.stops).toBe(0);
});
