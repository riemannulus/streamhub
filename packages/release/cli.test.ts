import {expect,test} from 'bun:test';
import {main,parsePreviewCommand,sanitizeRuntimeStatus,type PreviewDependencies} from './cli';
import {launchAgentPaths} from './launch-agent';

const dependencies=(options:{daemonStatus?:{enabled:boolean;loaded:boolean;running:boolean;pid?:number;lastExitStatus?:number};guidance?:string}={})=>{const calls:string[]=[];const daemonStatus=options.daemonStatus??{enabled:false,loaded:false,running:false};const deps:PreviewDependencies={
  chooseMode:async()=>{calls.push('choose');return'hid';},
  setup:async mode=>{calls.push(`setup:${mode}`);return{mode,guidance:options.guidance??'ready'};},
  runChild:async(entry,args)=>{calls.push(`child:${entry}:${args.join(',')}`);return 0;},
  status:async()=>({configuredMode:'hid',activeMode:'hid',state:'ready',restartRequired:false}),
  uninstall:async()=>{calls.push('uninstall');return 0;},
  daemon:{
    enable:async()=>{calls.push('daemon:enable');return daemonStatus;},
    disable:async()=>{calls.push('daemon:disable');return daemonStatus;},
    restart:async()=>{calls.push('daemon:restart');return daemonStatus;},
    status:async()=>{calls.push('daemon:status');return daemonStatus;},
    paths:launchAgentPaths({home:'/Users/example',uid:501,bunPath:'/opt/homebrew/bin/bun',packageRoot:'/Users/example/Library/Application Support/Streamhub/app/0.1.0-preview.1'}),
  },
  readDaemonLog:()=>{calls.push('daemon:logs');return 'latest runtime log\n';},
  followDaemonLog:async()=>{calls.push('daemon:follow');return 0;},
  write:value=>{calls.push(`write:${value}`);},runtimeEntry:'runtime.js',studioEntry:'studio.js',version:'0.1.0-preview.1',
};return{calls,deps};};

test('CLI accepts only documented commands and options',()=>{
  expect(parsePreviewCommand(['setup'])).toEqual({type:'setup'});expect(parsePreviewCommand(['setup','hid'])).toEqual({type:'setup',mode:'hid'});expect(parsePreviewCommand(['setup','plugin'])).toEqual({type:'setup',mode:'plugin'});
  expect(parsePreviewCommand(['start'])).toEqual({type:'start'});expect(parsePreviewCommand(['studio'])).toEqual({type:'studio',open:true});expect(parsePreviewCommand(['studio','--no-open'])).toEqual({type:'studio',open:false});
  expect(parsePreviewCommand(['status'])).toEqual({type:'status'});expect(parsePreviewCommand(['version'])).toEqual({type:'version'});expect(parsePreviewCommand(['uninstall'])).toEqual({type:'uninstall'});
  for(const argv of [[],['wat'],['start','extra'],['studio','--bad'],['setup','off']])expect(()=>parsePreviewCommand(argv)).toThrow('Usage');
});

test('CLI accepts the exact daemon grammar and keeps Studio unchanged',()=>{
  expect(parsePreviewCommand(['daemon','enable'])).toEqual({type:'daemon',operation:'enable'});
  expect(parsePreviewCommand(['daemon','disable'])).toEqual({type:'daemon',operation:'disable'});
  expect(parsePreviewCommand(['daemon','restart'])).toEqual({type:'daemon',operation:'restart'});
  expect(parsePreviewCommand(['daemon','status'])).toEqual({type:'daemon',operation:'status'});
  expect(parsePreviewCommand(['daemon','logs'])).toEqual({type:'daemon',operation:'logs',follow:false});
  expect(parsePreviewCommand(['daemon','logs','--follow'])).toEqual({type:'daemon',operation:'logs',follow:true});
  expect(parsePreviewCommand(['studio'])).toEqual({type:'studio',open:true});
  for(const argv of [['daemon'],['daemon','start'],['daemon','logs','--bad'],['studio','stop']])expect(()=>parsePreviewCommand(argv)).toThrow('Usage');
});

test('unknown commands perform no process, browser, config, or uninstall effects',async()=>{
  const h=dependencies();expect(await main(['wat'],h.deps)).toBe(2);expect(h.calls).toEqual([expect.stringContaining('Usage')]);
});

test('CLI routes setup, child processes, status, version, and uninstall once',async()=>{
  for(const [argv,expected] of [
    [['setup'],['choose','setup:hid','daemon:status','write:ready']],
    [['start'],['daemon:status','child:runtime.js:']],
    [['studio','--no-open'],['child:studio.js:--no-open']],
    [['status'],['write:{\n  "configuredMode": "hid",\n  "activeMode": "hid",\n  "state": "ready",\n  "restartRequired": false\n}']],
    [['version'],['write:Streamhub 0.1.0-preview.1 (macos-arm64)']],
    [['uninstall'],['uninstall']],
  ] as const){const h=dependencies();expect(await main([...argv],h.deps)).toBe(0);expect(h.calls).toEqual([...expected]);}
});

test('daemon commands route once, status is bounded, and logs use managed readers',async()=>{
  for(const [argv,expected] of [
    [['daemon','enable'],['daemon:enable','write:Runtime daemon enabled.']],
    [['daemon','disable'],['daemon:disable','write:Runtime daemon disabled.']],
    [['daemon','restart'],['daemon:restart','write:Runtime daemon restarted.']],
    [['daemon','status'],['daemon:status','write:{\n  "daemon": {\n    "enabled": false,\n    "loaded": false,\n    "running": false\n  },\n  "runtime": {\n    "configuredMode": "hid",\n    "activeMode": "hid",\n    "state": "ready",\n    "restartRequired": false\n  }\n}']],
    [['daemon','logs'],['daemon:logs','write:latest runtime log\n']],
    [['daemon','logs','--follow'],['daemon:follow']],
  ] as const){const h=dependencies();expect(await main([...argv],h.deps)).toBe(0);expect(h.calls).toEqual([...expected]);}
});

test('daemon status omits injected fields outside its public boundaries',async()=>{
  const h=dependencies();
  h.deps.daemon.status=async()=>({enabled:true,loaded:true,running:false,pid:123,lastExitStatus:4,token:'secret'} as any);
  h.deps.status=async()=>({configuredMode:'hid',activeMode:'hid',state:'ready',restartRequired:false,message:'ok',token:'private'} as any);
  expect(await main(['daemon','status'],h.deps)).toBe(0);
  expect(h.calls).toEqual(['write:{\n  "daemon": {\n    "enabled": true,\n    "loaded": true,\n    "running": false,\n    "pid": 123,\n    "lastExitStatus": 4\n  },\n  "runtime": {\n    "configuredMode": "hid",\n    "activeMode": "hid",\n    "state": "ready",\n    "restartRequired": false,\n    "message": "ok"\n  }\n}']);
});

test('foreground start refuses before spawning when the service is loaded',async()=>{
  const h=dependencies({daemonStatus:{enabled:true,loaded:true,running:true,pid:123}});
  expect(await main(['start'],h.deps)).toBe(1);
  expect(h.calls).toEqual(['daemon:status','write:Runtime daemon is enabled. Run streamhub daemon disable first.']);
});

test('setup reports daemon restart guidance without changing daemon state',async()=>{
  const h=dependencies({daemonStatus:{enabled:true,loaded:true,running:true}});
  expect(await main(['setup','hid'],h.deps)).toBe(0);
  expect(h.calls).toEqual(['setup:hid','daemon:status','write:ready\nRun streamhub daemon restart to apply the display setting.']);
});

test('runtime status exposes only bounded public fields',()=>{
  expect(sanitizeRuntimeStatus('plugin',{configuredMode:'plugin',activeMode:'plugin',state:'ready',restartRequired:false,token:'secret',message:'ok'})).toEqual({configuredMode:'plugin',activeMode:'plugin',state:'ready',restartRequired:false,message:'ok'});
  expect(sanitizeRuntimeStatus('hid',{activeMode:'wat',state:'secret',message:'x'.repeat(1000)})).toEqual({configuredMode:'hid',activeMode:'off',state:'unavailable',restartRequired:true,message:'Runtime 상태를 확인하지 못했습니다.'});
});
