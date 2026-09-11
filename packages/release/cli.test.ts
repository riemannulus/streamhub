import {expect,test} from 'bun:test';
import {main,parsePreviewCommand,sanitizeRuntimeStatus,type PreviewDependencies} from './cli';

const dependencies=()=>{const calls:string[]=[];const deps:PreviewDependencies={
  chooseMode:async()=>{calls.push('choose');return'hid';},
  setup:async mode=>{calls.push(`setup:${mode}`);return{mode,guidance:'ready'};},
  runChild:async(entry,args)=>{calls.push(`child:${entry}:${args.join(',')}`);return 0;},
  status:async()=>({configuredMode:'hid',activeMode:'hid',state:'ready',restartRequired:false}),
  uninstall:async()=>{calls.push('uninstall');return 0;},
  write:value=>{calls.push(`write:${value}`);},runtimeEntry:'runtime.js',studioEntry:'studio.js',version:'0.1.0-preview.1',
};return{calls,deps};};

test('CLI accepts only documented commands and options',()=>{
  expect(parsePreviewCommand(['setup'])).toEqual({type:'setup'});expect(parsePreviewCommand(['setup','hid'])).toEqual({type:'setup',mode:'hid'});expect(parsePreviewCommand(['setup','plugin'])).toEqual({type:'setup',mode:'plugin'});
  expect(parsePreviewCommand(['start'])).toEqual({type:'start'});expect(parsePreviewCommand(['studio'])).toEqual({type:'studio',open:true});expect(parsePreviewCommand(['studio','--no-open'])).toEqual({type:'studio',open:false});
  expect(parsePreviewCommand(['status'])).toEqual({type:'status'});expect(parsePreviewCommand(['version'])).toEqual({type:'version'});expect(parsePreviewCommand(['uninstall'])).toEqual({type:'uninstall'});
  for(const argv of [[],['wat'],['start','extra'],['studio','--bad'],['setup','off']])expect(()=>parsePreviewCommand(argv)).toThrow('Usage');
});

test('unknown commands perform no process, browser, config, or uninstall effects',async()=>{
  const h=dependencies();expect(await main(['wat'],h.deps)).toBe(2);expect(h.calls).toEqual([expect.stringContaining('Usage')]);
});

test('CLI routes setup, child processes, status, version, and uninstall once',async()=>{
  for(const [argv,expected] of [
    [['setup'],['choose','setup:hid','write:ready']],
    [['start'],['child:runtime.js:']],
    [['studio','--no-open'],['child:studio.js:--no-open']],
    [['status'],['write:{\n  "configuredMode": "hid",\n  "activeMode": "hid",\n  "state": "ready",\n  "restartRequired": false\n}']],
    [['version'],['write:Streamhub 0.1.0-preview.1 (macos-arm64)']],
    [['uninstall'],['uninstall']],
  ] as const){const h=dependencies();expect(await main([...argv],h.deps)).toBe(0);expect(h.calls).toEqual([...expected]);}
});

test('runtime status exposes only bounded public fields',()=>{
  expect(sanitizeRuntimeStatus('plugin',{configuredMode:'plugin',activeMode:'plugin',state:'ready',restartRequired:false,token:'secret',message:'ok'})).toEqual({configuredMode:'plugin',activeMode:'plugin',state:'ready',restartRequired:false,message:'ok'});
  expect(sanitizeRuntimeStatus('hid',{activeMode:'wat',state:'secret',message:'x'.repeat(1000)})).toEqual({configuredMode:'hid',activeMode:'off',state:'unavailable',restartRequired:true,message:'Runtime 상태를 확인하지 못했습니다.'});
});
