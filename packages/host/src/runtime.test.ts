import { expect, test } from 'bun:test';
import { startHost, type HostDependencies } from './runtime';
import { SignalStore } from './store';
import type { Config } from './config';

const config:Config={port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}},display:{mode:'off'}};
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
function resources(){
  const calls:string[]=[];
  let store!:SignalStore;
  const dependencies:Partial<HostDependencies>={
    openStore:()=>{calls.push('store-open');store=new SignalStore(':memory:');const close=store.close.bind(store);store.close=()=>{calls.push('store-close');close();};return store;},
    serve:()=>{calls.push('server-open');return{url:new URL('http://127.0.0.1:31415'),stop:async()=>{calls.push('server-stop');}};},
    display:async()=>{calls.push('display-open');return{status:()=>({}),stop:async()=>{calls.push('display-stop');}};},
  };
  return{calls,dependencies,get store(){return store;}};
}

test('runtime validates supplied configuration before acquiring any resources',async()=>{
  const r=resources();
  await expect(startHost({...config,adminToken:'short'},'/unused',{dependencies:r.dependencies})).rejects.toThrow();
  expect(r.calls).toEqual([]);
});
test('runtime rollback closes store when server startup fails',async()=>{
  const r=resources();r.dependencies.serve=()=>{throw new Error('bind failed');};
  await expect(startHost(config,'/unused',{dependencies:r.dependencies})).rejects.toThrow('bind failed');
  expect(r.calls).toEqual(['store-open','store-close']);
});
test('display startup failure rolls back server and store',async()=>{
  const r=resources();r.dependencies.display=async()=>{throw new Error('monitor failed');};
  await expect(startHost({...config,streamdeck:{enabled:true}},'/unused',{dependencies:r.dependencies})).rejects.toThrow('monitor failed');
  expect(r.calls).toEqual(['store-open','server-open','server-stop','store-close']);
});
test('stop shares one promise and attempts all cleanup even if a step fails',async()=>{
  const r=resources();
  r.dependencies.display=async()=>({status:()=>({}),stop:async()=>{r.calls.push('display-stop');throw new Error('display close failed');}});
  r.dependencies.serve=()=>({url:new URL('http://127.0.0.1:31415'),stop:async()=>{r.calls.push('server-stop');throw new Error('server close failed');}});
  const host=await startHost({...config,streamdeck:{enabled:true}},'/unused',{dependencies:r.dependencies});
  const first=host.stop(),second=host.stop();
  expect(second).toBe(first);
  await expect(first).rejects.toBeInstanceOf(AggregateError);
  expect(r.calls.filter(call=>call==='display-stop')).toHaveLength(1);
  expect(r.calls.filter(call=>call==='server-stop')).toHaveLength(1);
  expect(r.calls.at(-1)).toBe('store-close');
});
test('abort during display startup prevents readiness and cleans up a late display',async()=>{
  const r=resources();const controller=new AbortController();
  const started=deferred<void>();const gate=deferred<{status():unknown;stop():Promise<void>}>();
  let displaySignal:AbortSignal|undefined;
  r.dependencies.display=async(_store,_directory,options)=>{displaySignal=options.signal;started.resolve();return gate.promise;};
  const starting=startHost({...config,streamdeck:{enabled:true}},'/unused',{dependencies:r.dependencies,signal:controller.signal});
  await started.promise;
  controller.abort();
  await Bun.sleep(0);
  expect(displaySignal?.aborted).toBe(true);
  expect(r.calls).not.toContain('store-close');
  gate.resolve({status:()=>({}),stop:async()=>{r.calls.push('late-display-stop');}});
  await expect(starting).rejects.toMatchObject({name:'AbortError'});
  expect(r.calls).toContain('late-display-stop');
  expect(r.calls.at(-1)).toBe('store-close');
});
test('shutdown drains an in-flight collector before closing its store',async()=>{
  const r=resources();const started=deferred<void>();const gate=deferred<{ids:string[];discoveries:[]}>();
  r.dependencies.collect=async()=>{started.resolve();return gate.promise;};
  const host=await startHost({...config,collectors:[{source:'demo',exec:['/usr/bin/true'],intervalMs:1000}]},'/unused',{dependencies:r.dependencies});
  await started.promise;
  const stopping=host.stop();await Bun.sleep(0);
  expect(r.calls).not.toContain('store-close');
  gate.resolve({ids:[],discoveries:[]});
  await stopping;
  expect(r.calls.at(-1)).toBe('store-close');
});

test('abort preserves pending display cleanup failure and still closes server and store',async()=>{
  const r=resources();const controller=new AbortController();const started=deferred<void>();
  const gate=deferred<{status():unknown;stop():Promise<void>}>();
  r.dependencies.display=async()=>{started.resolve();return gate.promise;};
  const starting=startHost({...config,streamdeck:{enabled:true}},'/unused',{dependencies:r.dependencies,signal:controller.signal});
  await started.promise;controller.abort();await Bun.sleep(0);
  gate.reject(new AggregateError([new DOMException('Cancelled','AbortError'),new Error('monitor cleanup failed')],'Display startup and cleanup failed'));
  await expect(starting).rejects.toBeInstanceOf(AggregateError);
  expect(r.calls).toContain('server-stop');
  expect(r.calls.at(-1)).toBe('store-close');
});
