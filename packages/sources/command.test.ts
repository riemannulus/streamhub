import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerCommandSource,runCommandSource} from './command';
import {startHost} from '../host/src/runtime';
import {startServer} from '../host/src/server';
import type {Config} from '../host/src/config';
const config=():Config=>({port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}},display:{mode:'off'}});
const registration={configFile:'/tmp/config.json',cwd:'/tmp',bun:process.execPath,script:'/tmp/run-command-source.ts'};
test('command source registration preserves settings and repeats without duplicating credentials or actions',()=>{
  const initial={...config(),extension:{keep:true}},registered=registerCommandSource(initial,registration);
  expect(registered.adminToken).toBe(initial.adminToken);expect(registered.sources.demo).toEqual(initial.sources.demo);
  expect(registered.display.mode).toBe('off');expect(registered.sources.build.token.length).toBeGreaterThanOrEqual(32);
  expect(registerCommandSource(registered,registration)).toEqual(registered);
  expect((registered as Config&{extension:unknown}).extension).toEqual({keep:true});
  expect(registered.actions?.['run-checks'].exec).not.toContain(registered.sources.build.token);
  expect(registered.actions?.['run-checks'].env).toEqual({STREAMHUB_CONFIG:'/tmp/config.json'});
});
test('registration refuses conflicting user actions and invalid commands',()=>{
  expect(()=>registerCommandSource({...config(),actions:{'run-checks':{exec:['/usr/bin/true'],args:{},sources:['demo']}}},registration)).toThrow('action already exists');
  expect(()=>registerCommandSource(config(),{...registration,argv:[]})).toThrow();
  expect(()=>registerCommandSource(config(),{...registration,source:'bad source'})).toThrow();
});
test('package command registers a runnable source without replacing existing settings',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'streamhub-command-cli-'));
  const file=join(directory,'config.json');
  const repository=new URL('../../',import.meta.url).pathname;
  try{
    const child=Bun.spawn([process.execPath,'run','source:register','--',process.execPath,'-e','process.exit(0)'],{
      cwd:repository,env:{...process.env,STREAMHUB_CONFIG:file},stdout:'pipe',stderr:'ignore',
    });
    const [stdout,exitCode]=await Promise.all([new Response(child.stdout).text(),child.exited]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('run-checks');
    const registered=JSON.parse(readFileSync(file,'utf8')) as Config;
    expect(registered.sources.build.token.length).toBeGreaterThanOrEqual(32);
    expect(registered.actions?.['run-checks'].exec).toEqual([process.execPath,new URL('../../scripts/run-command-source.ts',import.meta.url).pathname,'--source','build','--id','checks','--label','프로젝트 검사','--',process.execPath,'-e','process.exit(0)']);
    expect(registered).not.toHaveProperty('streamdeck');
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('package run command publishes the supplied command result through the real host',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'streamhub-command-run-'));
  const file=join(directory,'config.json'),repository=new URL('../../',import.meta.url).pathname;
  const probe=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()});
  const port=probe.port!;await probe.stop(true);
  const registered=registerCommandSource({...config(),port},{...registration,configFile:file,cwd:repository,script:new URL('../../scripts/run-command-source.ts',import.meta.url).pathname});
  writeFileSync(file,JSON.stringify(registered));
  const host=await startHost(registered,directory);
  try{
    const child=Bun.spawn([process.execPath,'run','source:run','--',process.execPath,'-e','process.exit(0)'],{
      cwd:repository,env:{...process.env,STREAMHUB_CONFIG:file},stdout:'ignore',stderr:'ignore',
    });
    expect(await child.exited).toBe(0);
    const response=await fetch(new URL('/v1/state',host.url),{headers:{authorization:`Bearer ${registered.adminToken}`}});
    const state=await response.json() as {records:Array<{source:string;label:string;level:string}>};
    expect(state.records).toMatchObject([{source:'build',label:'프로젝트 검사 · 통과',level:'info'}]);
  }finally{await host.stop();rmSync(directory,{recursive:true,force:true});}
});
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'streamhub-command-'));
  const initial=registerCommandSource(config(),{...registration,cwd:directory});
  const host=await startHost(initial,directory,{dependencies:{serve:options=>startServer({...options,port:0})}});
  const running={...initial,port:Number(host.url.port)};
  const state=async()=>await (await fetch(new URL('/v1/state',host.url),{headers:{authorization:`Bearer ${running.adminToken}`}})).json() as any;
  return{running,state,directory,stop:async()=>{await host.stop();rmSync(directory,{recursive:true,force:true});}};
}
test('real command lifecycle publishes running and retains success or failure through HTTP/store',async()=>{
  const f=await fixture();
  try{
    const pending=runCommandSource(f.running,{argv:[process.execPath,'-e','await Bun.sleep(150)'],cwd:f.directory});
    const deadline=Date.now()+2000;let records:any[]=[];
    while(!records.length){if(Date.now()>deadline)throw new Error('Running signal missing');records=(await f.state()).records;await Bun.sleep(5);}
    expect(records[0].level).toBe('warn');expect(records[0].label).toContain('실행 중');
    expect((await pending).exitCode).toBe(0);
    records=(await f.state()).records;expect(records).toHaveLength(1);expect(records[0].level).toBe('info');expect(records[0].label).toContain('통과');
    expect((await runCommandSource(f.running,{argv:[process.execPath,'-e','process.exit(7)']})).exitCode).toBe(7);
    records=(await f.state()).records;expect(records).toHaveLength(1);expect(records[0].level).toBe('urgent');expect(records[0].detail).toBe('종료 코드: 7');
  }finally{await f.stop();}
});
test('offline host prevents child execution; cancellation publishes a retained urgent state',async()=>{
  const f=await fixture();const marker=join(f.directory,'should-not-exist');
  try{
    await expect(runCommandSource({...f.running,port:1},{argv:[process.execPath,'-e',`await Bun.write(${JSON.stringify(marker)},'bad')`]})).rejects.toThrow('명령을 시작하지 않았습니다');
    expect(existsSync(marker)).toBe(false);
    const controller=new AbortController();
    const pending=runCommandSource(f.running,{argv:[process.execPath,'-e','setTimeout(()=>{},30000)'],signal:controller.signal});
    await Bun.sleep(40);controller.abort(130);
    expect((await pending).exitCode).toBe(130);
    const records=(await f.state()).records;expect(records[0].level).toBe('urgent');expect(records[0].label).toContain('취소');
  }finally{await f.stop();}
});
