import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SystemActionCatalog,compileNativeSystemActionHelper,runBoundedProcess} from './system';
import type {ButtonAction} from '../studio/document';
import type {ActionDefinition} from '../host/src/actions';

const registered:Record<string,ActionDefinition>={build:{exec:['/usr/bin/true','{target}'],args:{target:'[a-z]+'},sources:['demo']}};

test('catalog validates every core action and preserves normalized values',()=>{
  const catalog=new SystemActionCatalog(registered,{runProcess:async()=>({stdout:'',stderr:'',exitCode:0}),runNative:async()=>({ok:true})});
  const actions:ButtonAction[]=[
    {type:'none'},
    {type:'open-app',bundleId:'org.mozilla.firefox'},
    {type:'open-path',path:'/tmp/example file'},
    {type:'open-url',url:'https://example.com'},
    {type:'open-url',url:'https://example.com',browserBundleId:'org.mozilla.firefox'},
    {type:'hotkey',keys:['command','shift','p']},
    {type:'text',text:'hello',mode:'paste'},
    {type:'text',text:'hello',mode:'type'},
    {type:'media',command:'play-pause'},
    {type:'registered',name:'build',args:{target:'main'}},
    {type:'go-to-page',pageId:'home'},
    {type:'previous-page'},{type:'next-page'},{type:'page-indicator'},{type:'resume-auto-page'},
  ];
  for(const action of actions)expect(catalog.validateButtonAction(action)).toEqual(action.type==='open-url'?{...action,url:'https://example.com/'}:action);
  expect(()=>catalog.validateButtonAction({type:'open-path',path:'relative'})).toThrow('absolute');
  expect(()=>catalog.validateButtonAction({type:'hotkey',keys:['command','command']})).toThrow('hotkey');
  expect(()=>catalog.validateButtonAction({type:'hotkey',keys:['k','command']})).toThrow('hotkey order');
  expect(()=>catalog.validateButtonAction({type:'hotkey',keys:['command']})).toThrow('hotkey order');
  expect(()=>catalog.validateButtonAction({type:'media',command:'bad'} as never)).toThrow('media');
  expect(()=>catalog.validateButtonAction({type:'registered',name:'missing',args:{}})).toThrow('Unknown action');
  expect(()=>catalog.validateButtonAction({type:'registered',name:'build',args:{target:'unsafe value'}})).toThrow('arguments');
});

test('app, path and URLs invoke open once with literal argv',async()=>{
  const calls:string[][]=[];
  const catalog=new SystemActionCatalog({}, {runProcess:async request=>{calls.push(request.argv);return{stdout:'',stderr:'',exitCode:0};},runNative:async()=>({ok:true})});
  await catalog.executeButtonAction({type:'open-app',bundleId:'org.mozilla.firefox'});
  await catalog.executeButtonAction({type:'open-path',path:'/tmp/$(literal)'});
  await catalog.executeButtonAction({type:'open-url',url:'https://example.com/?q=$(literal)'});
  await catalog.executeButtonAction({type:'open-url',url:'https://example.com',browserBundleId:'org.mozilla.firefox'});
  expect(calls).toEqual([
    ['/usr/bin/open','-b','org.mozilla.firefox'],
    ['/usr/bin/open','/tmp/$(literal)'],
    ['/usr/bin/open','https://example.com/?q=$(literal)'],
    ['/usr/bin/open','-b','org.mozilla.firefox','https://example.com/'],
  ]);
});

test('hotkey, text and media use one native request and expose stable failures',async()=>{
  const calls:ButtonAction[]=[];
  const catalog=new SystemActionCatalog({}, {runProcess:async()=>({stdout:'',stderr:'',exitCode:0}),runNative:async action=>{calls.push(action);return action.type==='hotkey'?{ok:false,error:'accessibility-permission-required'}:{ok:true};}});
  await expect(catalog.executeButtonAction({type:'hotkey',keys:['command','k']})).rejects.toMatchObject({code:'accessibility-permission-required'});
  await catalog.executeButtonAction({type:'text',text:'hello',mode:'type'});
  await catalog.executeButtonAction({type:'media',command:'mute-toggle'});
  expect(calls).toHaveLength(3);
  expect(calls.map(action=>action.type)).toEqual(['hotkey','text','media']);
});

test('registered execution is delegated once while internal and cancelled actions invoke nothing',async()=>{
  const registeredCalls:unknown[]=[],processCalls:unknown[]=[],nativeCalls:unknown[]=[];
  const catalog=new SystemActionCatalog(registered,{
    runProcess:async request=>{processCalls.push(request);return{stdout:'',stderr:'',exitCode:0};},
    runNative:async action=>{nativeCalls.push(action);return{ok:true};},
    runRegistered:async(registry,press,signal)=>{registeredCalls.push({definition:registry.validate('__deck__',press),press,signal});},
  });
  await catalog.executeButtonAction({type:'registered',name:'build',args:{target:'main'}});
  for(const action of [{type:'none'},{type:'go-to-page',pageId:'home'},{type:'previous-page'},{type:'next-page'},{type:'page-indicator'},{type:'resume-auto-page'}] as ButtonAction[])await catalog.executeButtonAction(action);
  const abort=new AbortController();abort.abort();
  await expect(catalog.executeButtonAction({type:'open-app',bundleId:'org.mozilla.firefox'},abort.signal)).rejects.toMatchObject({code:'cancelled'});
  expect(registeredCalls).toHaveLength(1);expect(processCalls).toHaveLength(0);expect(nativeCalls).toHaveLength(0);
});

test('bounded process enforces cancellation, timeout and combined output cap',async()=>{
  await expect(runBoundedProcess({argv:['/usr/bin/printf','12345'],timeoutMs:1000,maxOutputBytes:4})).rejects.toMatchObject({code:'output-limit'});
  await expect(runBoundedProcess({argv:['/bin/sleep','1'],timeoutMs:10,maxOutputBytes:1024})).rejects.toMatchObject({code:'timeout'});
  const abort=new AbortController();abort.abort();
  await expect(runBoundedProcess({argv:['/usr/bin/true'],timeoutMs:1000,maxOutputBytes:1024},abort.signal)).rejects.toMatchObject({code:'cancelled'});
});

test('native helper source compiles into the source-hashed cache without executing input',async()=>{
  if(process.platform!=='darwin')return;
  const directory=mkdtempSync(join(tmpdir(),'streamhub-system-actions-'));
  try{const binary=await compileNativeSystemActionHelper(directory);expect(binary.startsWith(directory)).toBe(true);expect(binary.split('/').at(-1)).toMatch(/^[a-f0-9]{64}$/);}
  finally{rmSync(directory,{recursive:true,force:true});}
});
