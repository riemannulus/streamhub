import {validateButtonAppearance,validateKeyBehavior,validateStudioDocument,type ButtonDefinition,type StudioDocument} from '../../studio/document';

export type ButtonClipboard={version:1;button:Omit<ButtonDefinition,'id'|'index'>};
export type ButtonLocation={pageId:string;index:number};
export type EditorShortcut='copy'|'paste'|'duplicate'|'remove'|'undo'|'redo';

const documentClone=(input:StudioDocument)=>validateStudioDocument(input);
const page=(document:StudioDocument,pageId:string)=>{const value=document.pages.find(item=>item.id===pageId);if(!value)throw new Error(`Unknown page: ${pageId}`);return value;};
const position=(index:number)=>{if(!Number.isInteger(index)||index<0||index>14)throw new Error('Invalid button position');return index;};
const find=(document:StudioDocument,location:ButtonLocation)=>page(document,location.pageId).buttons?.find(button=>button.index===position(location.index));

export function copyButton(input:StudioDocument,pageId:string,index:number):ButtonClipboard|undefined{
  const document=documentClone(input),button=find(document,{pageId,index});if(!button)return;
  return{version:1,button:structuredClone({behavior:button.behavior,appearance:button.appearance})};
}

function validateClipboard(raw:ButtonClipboard):ButtonClipboard{
  if(!raw||raw.version!==1||!raw.button||typeof raw.button!=='object'||Array.isArray(raw.button)||Object.keys(raw.button).some(key=>!['behavior','appearance'].includes(key)))throw new Error('Invalid button clipboard');
  return{version:1,button:{behavior:validateKeyBehavior(raw.button.behavior),appearance:validateButtonAppearance(raw.button.appearance)}};
}

export function pasteButton(input:StudioDocument,pageId:string,index:number,raw:ButtonClipboard):StudioDocument{
  const document=documentClone(input),target=page(document,pageId),targetIndex=position(index),clipboard=validateClipboard(raw);
  if(target.buttons?.some(button=>button.index===targetIndex))throw new Error('Target button is occupied');
  target.buttons=[...(target.buttons??[]),{id:crypto.randomUUID(),index:targetIndex,...structuredClone(clipboard.button)}];
  return validateStudioDocument(document);
}

export function duplicateButton(input:StudioDocument,pageId:string,index:number,targetIndex:number):StudioDocument{
  const clipboard=copyButton(input,pageId,index);if(!clipboard)throw new Error('Unknown source button');return pasteButton(input,pageId,targetIndex,clipboard);
}

export function removeButton(input:StudioDocument,pageId:string,index:number):StudioDocument{
  const document=documentClone(input),target=page(document,pageId),targetIndex=position(index);target.buttons=target.buttons?.filter(button=>button.index!==targetIndex);if(!target.buttons?.length)delete target.buttons;return validateStudioDocument(document);
}

export function moveButton(input:StudioDocument,from:ButtonLocation,to:ButtonLocation,options:{swap?:boolean}={}):StudioDocument{
  const document=documentClone(input),sourcePage=page(document,from.pageId),targetPage=page(document,to.pageId),sourceIndex=position(from.index),targetIndex=position(to.index),source=find(document,from);if(!source)throw new Error('Unknown source button');
  if(from.pageId===to.pageId&&sourceIndex===targetIndex)return document;
  const target=find(document,to);if(target&&!options.swap)throw new Error('Occupied target requires swap confirmation');
  sourcePage.buttons=sourcePage.buttons?.filter(button=>button.id!==source.id);if(!sourcePage.buttons?.length)delete sourcePage.buttons;
  if(target){targetPage.buttons=targetPage.buttons?.filter(button=>button.id!==target.id);target.index=sourceIndex;sourcePage.buttons=[...(sourcePage.buttons??[]),target];}
  source.index=targetIndex;targetPage.buttons=[...(targetPage.buttons??[]),source];
  return validateStudioDocument(document);
}

export function shortcutFor(event:{key:string;metaKey:boolean;shiftKey:boolean;target?:unknown}):EditorShortcut|undefined{
  const target=event.target as {tagName?:string;isContentEditable?:boolean}|null|undefined,tag=target?.tagName?.toUpperCase();if(target?.isContentEditable||tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;
  const key=event.key.toLowerCase();if(!event.metaKey&&(key==='delete'||key==='backspace'))return'remove';if(!event.metaKey)return;
  if(key==='c')return'copy';if(key==='v')return'paste';if(key==='d')return'duplicate';if(key==='z')return event.shiftKey?'redo':'undo';
}
