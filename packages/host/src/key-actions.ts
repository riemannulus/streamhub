import {ActionRegistry,type ActionDefinition,type ActionPress} from './actions';
import {SystemActionCatalog,type ProcessRequest,type ProcessResult,type NativeResult} from '../../actions/system';
import type {ButtonEffect} from '../../streamdeck';
import type {PageConfig} from '../../streamdeck/pages';
import type {ButtonAction,KeyCode,MediaCommand} from '../../studio/document';
const LOCAL='__deck__';
const trusted=(actions:Record<string,ActionDefinition>)=>Object.fromEntries(Object.entries(actions).map(([name,definition])=>[name,{...definition,sources:[LOCAL]}]));
export function actionCatalog(actions:Record<string,ActionDefinition>={}){return Object.entries(actions).map(([name,definition])=>({name,args:Object.keys(definition.args)}));}
export function validateButtonActions(board:PageConfig,actions:Record<string,ActionDefinition>={}){
  const registry=new ActionRegistry(trusted(actions));
  for(const page of board.pages)for(const button of page.buttons??[])if(button.type==='action')registry.validate(LOCAL,{type:'action',name:button.name,args:button.args});
}
type Run=(registry:ActionRegistry,press:ActionPress,signal?:AbortSignal)=>Promise<unknown>;
/** Locally configured button effects only. Every invocation remains argv-only and bounded. */
export function createKeyActionExecutor(actions:Record<string,ActionDefinition>={},options:{run?:Run;runProcess?:(request:ProcessRequest,signal?:AbortSignal)=>Promise<ProcessResult>;runNative?:(action:Extract<ButtonAction,{type:'hotkey'|'text'|'media'}>,signal?:AbortSignal)=>Promise<NativeResult>;cacheDir?:string}={}){
  const catalog=new SystemActionCatalog(actions,{...(options.run?{runRegistered:options.run}:{}),...(options.runProcess?{runProcess:options.runProcess}:{}),...(options.runNative?{runNative:options.runNative}:{}),...(options.cacheDir?{cacheDir:options.cacheDir}:{})});
  return async(effect:ButtonEffect,signal?:AbortSignal):Promise<void>=>{
    const action:ButtonAction=effect.type==='app'?{type:'open-app',bundleId:effect.bundleId}:effect.type==='open'?{type:'open-url',url:effect.url,...(effect.browserBundleId?{browserBundleId:effect.browserBundleId}:{})}:effect.type==='path'?{type:'open-path',path:effect.path}:effect.type==='hotkey'?{type:'hotkey',keys:effect.keys as KeyCode[]}:effect.type==='text'?effect:effect.type==='media'?{type:'media',command:effect.command as MediaCommand}:{type:'registered',name:effect.name,args:effect.args};
    await catalog.executeButtonAction(action,signal);
  };
}
