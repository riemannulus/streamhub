import {expect,test} from 'bun:test';
import {createKeyActionExecutor,validateButtonActions,actionCatalog} from './key-actions';
import type {PageConfig} from '../../streamdeck/pages';
const actions={build:{exec:['/usr/bin/true','{target}'],args:{target:'[a-z]+'},sources:['demo']}};
test('fixed button executor passes literal argv through registered bounded execution',async()=>{
  const calls:unknown[]=[];
  const execute=createKeyActionExecutor(actions,{run:async(registry,press)=>{
    const definition=registry.validate('__deck__',press);calls.push({exec:definition.exec,args:press.args,timeout:definition.timeoutMs});
  }});
  await execute({type:'open',url:'https://example.com/?q=$(echo%20literal)'});
  await execute({type:'app',bundleId:'com.apple.Terminal'});
  await execute({type:'action',name:'build',args:{target:'main'}});
  expect(calls).toEqual([
    {exec:['/usr/bin/open','{value}'],args:{value:'https://example.com/?q=$(echo%20literal)'},timeout:3000},
    {exec:['/usr/bin/open','-b','{value}'],args:{value:'com.apple.Terminal'},timeout:3000},
    {exec:['/usr/bin/true','{target}'],args:{target:'main'},timeout:undefined},
  ]);
  expect(actions.build.sources).toEqual(['demo']);
  await expect(execute({type:'open',url:'file:///tmp/test'})).rejects.toThrow();
  await expect(execute({type:'app',bundleId:'-bad'})).rejects.toThrow();
  await expect(execute({type:'action',name:'build',args:{target:'unsafe;'}})).rejects.toThrow();
  await expect(execute({type:'action',name:'missing',args:{}})).rejects.toThrow();
  const abort=new AbortController();abort.abort();await expect(execute({type:'app',bundleId:'com.apple.Terminal'},abort.signal)).rejects.toThrow('cancelled');
  expect(calls).toHaveLength(3);
});
test('action catalog contains only names and argument keys; configured actions require validated args',()=>{
  expect(actionCatalog(actions)).toEqual([{name:'build',args:['target']}]);
  const board:PageConfig={defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'action',label:'Build',name:'build',args:{target:'main'}}]}]};
  expect(()=>validateButtonActions(board,actions)).not.toThrow();
  expect(()=>validateButtonActions(board,{})).toThrow();
  const bad=structuredClone(board);(bad.pages[0].buttons![0] as {args:Record<string,string>}).args={target:'bad value'};
  expect(()=>validateButtonActions(bad,actions)).toThrow();
});

test('long HTTP URLs use a scoped argument limit and URL credentials are rejected',async()=>{
  let calls=0;
  const execute=createKeyActionExecutor({}, {run:async(registry,press)=>{registry.validate('__deck__',press);calls++;}});
  await execute({type:'open',url:'https://example.com/?q='+'x'.repeat(1500)});expect(calls).toBe(1);
  await expect(execute({type:'open',url:'https://user:password@example.com'})).rejects.toThrow();
});
