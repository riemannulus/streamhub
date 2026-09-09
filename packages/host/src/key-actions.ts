import {ActionRegistry,type ActionDefinition,type ActionPress} from './actions';
import type {ButtonEffect} from '../../streamdeck';
import type {PageConfig} from '../../streamdeck/pages';
const LOCAL='__deck__';
const trusted=(actions:Record<string,ActionDefinition>)=>Object.fromEntries(Object.entries(actions).map(([name,definition])=>[name,{...definition,sources:[LOCAL]}]));
export function actionCatalog(actions:Record<string,ActionDefinition>={}){return Object.entries(actions).map(([name,definition])=>({name,args:Object.keys(definition.args)}));}
export function validateButtonActions(board:PageConfig,actions:Record<string,ActionDefinition>={}){
  const registry=new ActionRegistry(trusted(actions));
  for(const page of board.pages)for(const button of page.buttons??[])if(button.type==='action')registry.validate(LOCAL,{type:'action',name:button.name,args:button.args});
}
type Run=(registry:ActionRegistry,press:ActionPress,signal?:AbortSignal)=>Promise<unknown>;
/** Locally configured button effects only. Every invocation remains argv-only and bounded. */
export function createKeyActionExecutor(actions:Record<string,ActionDefinition>={},options:{run?:Run}={}){
  const registry=new ActionRegistry(trusted(actions));
  const run=options.run??((registry,press,signal)=>registry.run(LOCAL,press,signal));
  return async(effect:ButtonEffect,signal?:AbortSignal):Promise<void>=>{
    if(signal?.aborted)throw new Error('Button action cancelled');
    if(effect.type==='action'){
      const press:ActionPress={type:'action',name:effect.name,args:effect.args};
      registry.validate(LOCAL,press);await run(registry,press,signal);return;
    }
    let exec:string[],args:Record<string,string>;
    if(effect.type==='open'){
      const url=new URL(effect.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||effect.url.length>2048||effect.url.includes('\0'))throw new Error('Invalid button URL');
      exec=['/usr/bin/open','{value}'];args={value:effect.url};
    }else{
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(effect.bundleId))throw new Error('Invalid application ID');
      exec=['/usr/bin/open','-b','{value}'];args={value:effect.bundleId};
    }
    const opener=new ActionRegistry({open:{exec,args:{value:'[\\s\\S]+'},sources:[LOCAL],timeoutMs:3000,maxOutputBytes:4096}},{maxArgLength:2048});
    const press:ActionPress={type:'action',name:'open',args};opener.validate(LOCAL,press);await run(opener,press,signal);
  };
}
