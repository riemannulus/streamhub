import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {PageDefinition} from '../streamdeck/pages';

export type AssetPlacement={assetId:string;fit:'cover'|'contain'|'stretch'};
export type StudioAppearance={background?:AssetPlacement;color?:string};
export type ButtonContentMode='icon-and-label'|'icon-only'|'label-only'|'hidden';
export type ButtonAppearance={
  contentMode:ButtonContentMode;
  icon?:{assetId:string;fit:'contain'|'cover'};
  label?:{text:string;position:'top'|'center'|'bottom';size:'small'|'medium'|'large';color:string};
  background?:{color?:string;assetId?:string;opacity:number};
};
export const MEDIA_COMMANDS=['play-pause','previous-track','next-track','volume-up','volume-down','mute-toggle'] as const;
export type MediaCommand=typeof MEDIA_COMMANDS[number];
export const KEY_CODES=['command','option','control','shift','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','0','1','2','3','4','5','6','7','8','9','enter','escape','tab','space','left','right','up','down','f1','f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12'] as const;
export type KeyCode=typeof KEY_CODES[number];
export type ButtonAction=
  |{type:'none'}
  |{type:'open-app';bundleId:string}
  |{type:'open-path';path:string}
  |{type:'open-url';url:string;browserBundleId?:string}
  |{type:'hotkey';keys:KeyCode[]}
  |{type:'text';text:string;mode:'paste'|'type'}
  |{type:'media';command:MediaCommand}
  |{type:'registered';name:string;args:Record<string,string>}
  |{type:'go-to-page';pageId:string}
  |{type:'previous-page'}
  |{type:'next-page'}
  |{type:'page-indicator'}
  |{type:'resume-auto-page'};
export type ActionStep={type:'action';action:ButtonAction}|{type:'delay';milliseconds:number};
export type ActionSequence={mode:'sequential'|'parallel';steps:ActionStep[]};
export type ActionProgram=
  |{type:'single';action:ButtonAction}
  |{type:'sequence';sequence:ActionSequence}
  |{type:'toggle';initial:'off'|'on';offToOn:ActionSequence;onToOff:ActionSequence};
export type KeyBehavior={press?:ActionProgram;doublePress?:ActionProgram;hold?:ActionProgram;doublePressMs:number;holdMs:number};
export type ButtonDefinition={id:string;index:number;behavior:KeyBehavior;appearance:ButtonAppearance};
export type StudioPage={id:string;title:string;match?:PageDefinition['match'];priority?:number;appearance?:StudioAppearance;buttons?:ButtonDefinition[]};
export type TransitionSpec={type:'none'|'crossfade'|'fade-through-black';durationMs:number};
export type StudioDocument={version:3;id:string;device:{kind:'streamdeck-classic-5x3'};defaultPageId:string;pages:StudioPage[];standby:StudioAppearance;motion:{pageChange:TransitionSpec;unlock:TransitionSpec;reconnect:TransitionSpec}};
export type StudioValidationContext={sources?:readonly string[];actions?:Record<string,{args?:Record<string,unknown>}>;assets?:readonly string[]};

const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected object');return value as Record<string,unknown>;};
const exact=(value:Record<string,unknown>,keys:readonly string[])=>{const unknown=Object.keys(value).find(key=>!keys.includes(key));if(unknown)throw new Error(`Unknown field: ${unknown}`);};
const text=(value:unknown,max=128)=>{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Invalid string');return value;};
const bodyText=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max||value.includes('\0'))throw new Error('Invalid text');return value;};
const identifier=(value:unknown,label='ID')=>{const result=text(value,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))throw new Error(`Invalid ${label}`);return result;};
const bundleId=(value:unknown)=>{const result=text(value,255);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result))throw new Error('Invalid bundle ID');return result;};
const color=(value:unknown)=>{if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw new Error('Invalid color');return value;};
const assetId=(value:unknown,context:StudioValidationContext)=>{const result=text(value,64);if(!/^[a-f0-9]{64}$/.test(result))throw new Error('Invalid asset ID');if(context.assets&&!context.assets.includes(result))throw new Error(`Unknown asset: ${result}`);return result;};
const documentId=(value:unknown)=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))throw new Error('Invalid document ID');return value;};

function studioAppearance(raw:unknown,context:StudioValidationContext):StudioAppearance{
  const value=object(raw);exact(value,['background','color']);const result:StudioAppearance={};
  if(value.color!==undefined)result.color=color(value.color);
  if(value.background!==undefined){const background=object(value.background);exact(background,['assetId','fit']);if(!['cover','contain','stretch'].includes(background.fit as string))throw new Error('Invalid asset fit');result.background={assetId:assetId(background.assetId,context),fit:background.fit as AssetPlacement['fit']};}
  return result;
}

export function validateButtonAppearance(raw:unknown,context:StudioValidationContext={}):ButtonAppearance{
  const value=object(raw);exact(value,['contentMode','icon','label','background']);
  if(!['icon-and-label','icon-only','label-only','hidden'].includes(value.contentMode as string))throw new Error('Invalid content mode');
  const result:ButtonAppearance={contentMode:value.contentMode as ButtonContentMode};
  if(value.icon!==undefined){const icon=object(value.icon);exact(icon,['assetId','fit']);if(icon.fit!=='contain'&&icon.fit!=='cover')throw new Error('Invalid icon fit');result.icon={assetId:assetId(icon.assetId,context),fit:icon.fit};}
  if(value.label!==undefined){const label=object(value.label);exact(label,['text','position','size','color']);if(!['top','center','bottom'].includes(label.position as string))throw new Error('Invalid label position');if(!['small','medium','large'].includes(label.size as string))throw new Error('Invalid label size');result.label={text:text(label.text,80),position:label.position as ButtonAppearance['label'] extends infer T?T extends {position:infer P}?P:never:never,size:label.size as 'small'|'medium'|'large',color:color(label.color)};}
  if(value.background!==undefined){const background=object(value.background);exact(background,['color','assetId','opacity']);if(background.color===undefined&&background.assetId===undefined)throw new Error('Button background needs color or asset');if(typeof background.opacity!=='number'||!Number.isFinite(background.opacity)||background.opacity<0||background.opacity>1)throw new Error('Invalid opacity');result.background={...(background.color===undefined?{}:{color:color(background.color)}),...(background.assetId===undefined?{}:{assetId:assetId(background.assetId,context)}),opacity:background.opacity};}
  if((result.contentMode==='icon-only'||result.contentMode==='icon-and-label')&&!result.icon)throw new Error('Selected content mode requires an icon');
  if((result.contentMode==='label-only'||result.contentMode==='icon-and-label')&&!result.label)throw new Error('Selected content mode requires a label');
  return result;
}

export function validateButtonAction(raw:unknown,context:StudioValidationContext={}):ButtonAction{
  const value=object(raw),type=value.type;
  if(typeof type!=='string')throw new Error('Invalid button action');
  const fields:Record<string,string[]>={
    'none':[],'open-app':['bundleId'],'open-path':['path'],'open-url':['url','browserBundleId'],'hotkey':['keys'],'text':['text','mode'],'media':['command'],'registered':['name','args'],'go-to-page':['pageId'],'previous-page':[],'next-page':[],'page-indicator':[],'resume-auto-page':[],
  };
  if(!Object.hasOwn(fields,type))throw new Error('Invalid button action');exact(value,['type',...fields[type]]);
  if(type==='none'||type==='previous-page'||type==='next-page'||type==='page-indicator'||type==='resume-auto-page')return{type} as ButtonAction;
  if(type==='open-app')return{type,bundleId:bundleId(value.bundleId)};
  if(type==='open-path'){const path=bodyText(value.path,4096);if(!isAbsolute(path))throw new Error('Path must be absolute');return{type,path};}
  if(type==='open-url'){const url=new URL(text(value.url,2048));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid URL');return{type,url:url.href,...(value.browserBundleId===undefined?{}:{browserBundleId:bundleId(value.browserBundleId)})};}
  if(type==='hotkey'){if(!Array.isArray(value.keys)||value.keys.length<1||value.keys.length>8||new Set(value.keys).size!==value.keys.length||value.keys.some(key=>!KEY_CODES.includes(key as KeyCode)))throw new Error('Invalid hotkey');return{type,keys:[...value.keys] as KeyCode[]};}
  if(type==='text'){if(value.mode!=='paste'&&value.mode!=='type')throw new Error('Invalid text mode');return{type,text:bodyText(value.text,4096),mode:value.mode};}
  if(type==='media'){if(!MEDIA_COMMANDS.includes(value.command as MediaCommand))throw new Error('Invalid media command');return{type,command:value.command as MediaCommand};}
  if(type==='go-to-page')return{type,pageId:identifier(value.pageId,'target page')};
  const name=text(value.name,128),args=object(value.args);if(Object.keys(args).length>32)throw new Error('Too many action arguments');if(context.actions&&!Object.hasOwn(context.actions,name))throw new Error(`Unknown action: ${name}`);
  const definition=context.actions?.[name]?.args;if(definition){const extra=Object.keys(args).find(key=>!Object.hasOwn(definition,key));if(extra)throw new Error(`Unknown action argument: ${extra}`);const missing=Object.keys(definition).find(key=>!Object.hasOwn(args,key));if(missing)throw new Error(`Missing action argument: ${missing}`);}
  return{type:'registered',name,args:Object.fromEntries(Object.entries(args).map(([key,item])=>[text(key,128),bodyText(item,512)]))};
}

const navigation=(action:ButtonAction)=>['go-to-page','previous-page','next-page','resume-auto-page'].includes(action.type);
function validateActionSequence(raw:unknown,context:StudioValidationContext):ActionSequence{
  const value=object(raw);exact(value,['mode','steps']);
  if(value.mode!=='sequential'&&value.mode!=='parallel')throw new Error('Invalid sequence mode');
  if(!Array.isArray(value.steps)||value.steps.length<1||value.steps.length>16)throw new Error('Action sequence requires 1–16 steps');
  const rawSteps=value.steps as unknown[];
  const steps=rawSteps.map((rawStep,index):ActionStep=>{
    const step=object(rawStep);
    if(step.type==='delay'){
      exact(step,['type','milliseconds']);
      if(value.mode==='parallel')throw new Error('Parallel sequences cannot contain delays');
      if(!Number.isInteger(step.milliseconds)||(step.milliseconds as number)<10||(step.milliseconds as number)>30_000)throw new Error('Delay must be 10–30000 ms');
      return{type:'delay',milliseconds:step.milliseconds as number};
    }
    if(step.type!=='action')throw new Error('Invalid action step');
    exact(step,['type','action']);const action=validateButtonAction(step.action,context);
    if(action.type==='none'||action.type==='page-indicator')throw new Error('Sequence requires executable actions');
    if(navigation(action)&&(value.mode==='parallel'||index!==rawSteps.length-1))throw new Error('Navigation must be the final sequential action');
    return{type:'action',action};
  });
  return{mode:value.mode,steps};
}
function validateActionProgram(raw:unknown,context:StudioValidationContext):ActionProgram{
  const value=object(raw);
  if(value.type==='single'){exact(value,['type','action']);return{type:'single',action:validateButtonAction(value.action,context)};}
  if(value.type==='sequence'){exact(value,['type','sequence']);return{type:'sequence',sequence:validateActionSequence(value.sequence,context)};}
  if(value.type==='toggle'){
    exact(value,['type','initial','offToOn','onToOff']);if(value.initial!=='off'&&value.initial!=='on')throw new Error('Invalid toggle initial state');
    const offToOn=validateActionSequence(value.offToOn,context),onToOff=validateActionSequence(value.onToOff,context);
    return{type:'toggle',initial:value.initial,offToOn,onToOff};
  }
  throw new Error('Invalid action program');
}
export function validateKeyBehavior(raw:unknown,context:StudioValidationContext={}):KeyBehavior{
  const value=object(raw);exact(value,['press','doublePress','hold','doublePressMs','holdMs']);
  if(value.press===undefined&&value.doublePress===undefined&&value.hold===undefined)throw new Error('Key behavior requires at least one branch');
  if(!Number.isInteger(value.doublePressMs)||(value.doublePressMs as number)<150||(value.doublePressMs as number)>750)throw new Error('doublePressMs must be 150–750 ms');
  if(!Number.isInteger(value.holdMs)||(value.holdMs as number)<300||(value.holdMs as number)>2_000)throw new Error('holdMs must be 300–2000 ms');
  if((value.holdMs as number)<=(value.doublePressMs as number))throw new Error('holdMs must be greater than doublePressMs');
  return{...(value.press===undefined?{}:{press:validateActionProgram(value.press,context)}),...(value.doublePress===undefined?{}:{doublePress:validateActionProgram(value.doublePress,context)}),...(value.hold===undefined?{}:{hold:validateActionProgram(value.hold,context)}),doublePressMs:value.doublePressMs as number,holdMs:value.holdMs as number};
}
export const singlePressBehavior=(action:ButtonAction):KeyBehavior=>({press:{type:'single',action},doublePressMs:300,holdMs:500});
export const primaryButtonAction=(button:Pick<ButtonDefinition,'behavior'>):ButtonAction=>button.behavior.press?.type==='single'?button.behavior.press.action:{type:'none'};
export function actionsInBehavior(behavior:KeyBehavior):ButtonAction[]{
  const sequence=(value:ActionSequence)=>value.steps.flatMap(step=>step.type==='action'?[step.action]:[]);
  const program=(value:ActionProgram)=>value.type==='single'?[value.action]:value.type==='sequence'?sequence(value.sequence):[...sequence(value.offToOn),...sequence(value.onToOff)];
  return[behavior.press,behavior.doublePress,behavior.hold].flatMap(value=>value?program(value):[]);
}

function transition(raw:unknown):TransitionSpec{const value=object(raw);exact(value,['type','durationMs']);if(!['none','crossfade','fade-through-black'].includes(value.type as string))throw new Error('Invalid transition');if(!Number.isInteger(value.durationMs)||(value.durationMs as number)<0||(value.durationMs as number)>500)throw new Error('Transition duration must be 0–500 ms');return{type:value.type as TransitionSpec['type'],durationMs:value.durationMs as number};}

export function defaultStudioDocument(options:{id?:string}={}):StudioDocument{return{version:3,id:options.id??randomUUID(),device:{kind:'streamdeck-classic-5x3'},defaultPageId:'home',pages:[{id:'home',title:'홈'}],standby:{color:'#000000'},motion:{pageChange:{type:'crossfade',durationMs:280},unlock:{type:'crossfade',durationMs:480},reconnect:{type:'crossfade',durationMs:360}}};}

export function validateStudioDocument(raw:unknown,context:StudioValidationContext={}):StudioDocument{
  const value=object(raw);exact(value,['version','id','device','defaultPageId','pages','standby','motion']);if(value.version!==3)throw new Error('StudioDocument version 3 required');
  const id=documentId(value.id),device=object(value.device);exact(device,['kind']);if(device.kind!=='streamdeck-classic-5x3')throw new Error('Unsupported device');
  if(!Array.isArray(value.pages)||value.pages.length<1||value.pages.length>32)throw new Error('Expected 1–32 pages');
  const pageIds=new Set<string>(),buttonIds=new Set<string>();
  const pages:StudioPage[]=value.pages.map(rawPage=>{
    const input=object(rawPage);exact(input,['id','title','match','priority','appearance','buttons']);
    const pageId=identifier(input.id,'page ID');if(pageIds.has(pageId))throw new Error('Duplicate page ID');pageIds.add(pageId);
    const page:StudioPage={id:pageId,title:text(input.title,80)};
    if(input.priority!==undefined){if(!Number.isInteger(input.priority)||(input.priority as number)<-1000||(input.priority as number)>1000)throw new Error('Invalid priority');page.priority=input.priority as number;}
    if(input.match!==undefined){const match=object(input.match);exact(match,['appBundleId','windowTitle','displayId']);if(!Object.keys(match).length)throw new Error('Expected a page condition');const normalized:NonNullable<StudioPage['match']>={};if(match.appBundleId!==undefined)normalized.appBundleId=bundleId(match.appBundleId);if(match.windowTitle!==undefined){const title=object(match.windowTitle);exact(title,['mode','value']);if(title.mode!=='equals'&&title.mode!=='contains')throw new Error('Invalid title condition');normalized.windowTitle={mode:title.mode,value:text(title.value,512)};}if(match.displayId!==undefined)normalized.displayId=text(match.displayId,128);page.match=normalized;}
    if(input.appearance!==undefined)page.appearance=studioAppearance(input.appearance,context);
    if(input.buttons!==undefined){if(!Array.isArray(input.buttons)||input.buttons.length>15)throw new Error('Expected at most 15 buttons');const indices=new Set<number>();page.buttons=input.buttons.map(rawButton=>{const button=object(rawButton);exact(button,['id','index','behavior','appearance']);const buttonId=identifier(button.id,'button ID');if(buttonIds.has(buttonId))throw new Error('Duplicate button ID');buttonIds.add(buttonId);if(!Number.isInteger(button.index)||(button.index as number)<0||(button.index as number)>14||indices.has(button.index as number))throw new Error('Invalid or duplicate button index');indices.add(button.index as number);return{id:buttonId,index:button.index as number,behavior:validateKeyBehavior(button.behavior,context),appearance:validateButtonAppearance(button.appearance,context)};});}
    return page;
  });
  const defaultPageId=identifier(value.defaultPageId,'default page');if(!pageIds.has(defaultPageId))throw new Error('Unknown default page');
  for(const page of pages)for(const button of page.buttons??[])for(const action of actionsInBehavior(button.behavior))if(action.type==='go-to-page'&&!pageIds.has(action.pageId))throw new Error('Unknown target page');
  const motion=object(value.motion);exact(motion,['pageChange','unlock','reconnect']);
  return{version:3,id,device:{kind:'streamdeck-classic-5x3'},defaultPageId,pages,standby:studioAppearance(value.standby,context),motion:{pageChange:transition(motion.pageChange),unlock:transition(motion.unlock),reconnect:transition(motion.reconnect)}};
}
