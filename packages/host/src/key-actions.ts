import {ActionRegistry,type ActionDefinition,type ActionPress} from './actions';
import {SystemActionCatalog,type ProcessRequest,type ProcessResult,type NativeResult} from '../../actions/system';
import type {ButtonEffect} from '../../streamdeck';
import type {PageConfig} from '../../streamdeck/pages';
import type {ButtonAction,KeyCode,MediaCommand} from '../../studio/document';
import {executeProgram,type ActionResult} from '../../actions/composite';
import type {ActionProgram} from '../../studio/document';
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

/** Advanced programs can invoke only M1 leaf actions; navigation stays in presentation. */
export function createKeyActionProgramExecutor(actions:Record<string,ActionDefinition>={},options:Parameters<typeof createKeyActionExecutor>[1]={}){
  const effectExecutor=createKeyActionExecutor(actions,options);
  const effect=(action:ButtonAction):ButtonEffect|undefined=>action.type==='open-app'?{type:'app',bundleId:action.bundleId}:action.type==='open-path'?{type:'path',path:action.path}:action.type==='open-url'?{type:'open',url:action.url,...(action.browserBundleId?{browserBundleId:action.browserBundleId}:{})}:action.type==='hotkey'?{type:'hotkey',keys:action.keys}:action.type==='text'?action:action.type==='media'?action:action.type==='registered'?{type:'action',name:action.name,args:action.args}:undefined;
  return(program:ActionProgram,signal:AbortSignal):Promise<ActionResult>=>executeProgram(program,{signal,run:async(action,leafSignal)=>{
    const mapped=effect(action);if(!mapped)return{ok:false,code:'presentation-action',message:'Navigation actions must be handled by presentation'};
    try{await effectExecutor(mapped,leafSignal);return{ok:true};}catch(error){return{ok:false,code:typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'execution-failed',message:error instanceof Error?error.message:'Action failed'};}
  }});
}
