import {validateKeyBehavior,validateStudioDocument,type ButtonDefinition,type KeyBehavior,type StudioDocument,type TransitionSpec} from '../../studio/document';
import * as editing from '../editing';
import * as buttonEditing from './clipboard';

export class StudioModel{
  private past:{document:StudioDocument;selectedPageId:string;selectedKey:number}[]=[];
  private future:{document:StudioDocument;selectedPageId:string;selectedKey:number}[]=[];
  private clipboard?:buttonEditing.ButtonClipboard;
  private applied:string;
  document:StudioDocument;
  selectedPageId:string;
  selectedKey=0;
  constructor(document:StudioDocument){this.document=validateStudioDocument(document);this.selectedPageId=this.document.defaultPageId;this.applied=JSON.stringify(this.document);}
  get dirty(){return JSON.stringify(this.document)!==this.applied;}
  private replace(next:StudioDocument){const validated=validateStudioDocument(next);if(JSON.stringify(validated)===JSON.stringify(this.document))return false;this.past.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId,selectedKey:this.selectedKey});if(this.past.length>100)this.past.shift();this.future=[];this.document=validated;return true;}
  private change(mutator:(draft:StudioDocument)=>void){const draft=structuredClone(this.document);mutator(draft);this.replace(draft);}
  selectPage(id:string){if(this.document.pages.some(page=>page.id===id))this.selectedPageId=id;}
  selectKey(index:number){if(Number.isInteger(index)&&index>=0&&index<15)this.selectedKey=index;}
  addPage(){const existing=new Set(this.document.pages.map(page=>page.id)),next=editing.addPage(this.document);this.replace(next);this.selectedPageId=next.pages.find(page=>!existing.has(page.id))!.id;}
  renamePage(pageId:string,title:string){this.replace(editing.renamePage(this.document,pageId,title));this.selectedPageId=pageId;}
  duplicatePage(pageId:string){const existing=new Set(this.document.pages.map(page=>page.id)),next=editing.duplicatePage(this.document,pageId);this.replace(next);this.selectedPageId=next.pages.find(page=>!existing.has(page.id))!.id;}
  movePage(pageId:string,offset:-1|1){this.replace(editing.movePage(this.document,pageId,offset));this.selectedPageId=pageId;}
  setDefaultPage(pageId:string){this.replace(editing.setDefaultPage(this.document,pageId));}
  deletePage(pageId:string,replacementPageId?:string){const index=this.document.pages.findIndex(page=>page.id===pageId),next=editing.deletePage(this.document,pageId,replacementPageId);this.replace(next);if(this.selectedPageId===pageId)this.selectedPageId=next.pages[Math.min(index,next.pages.length-1)]!.id;}
  setBackground(target:'page'|'standby',assetId:string,fit:'cover'|'contain'|'stretch'='cover'){this.change(document=>{const appearance=target==='standby'?document.standby:(document.pages.find(page=>page.id===this.selectedPageId)!.appearance??={});appearance.background={assetId,fit};});}
  setSurfaceColor(target:'page'|'standby',color:string){this.change(document=>{const appearance=target==='standby'?document.standby:(document.pages.find(page=>page.id===this.selectedPageId)!.appearance??={});appearance.color=color;});}
  setButton(button:ButtonDefinition){this.change(document=>{const page=document.pages.find(page=>page.id===this.selectedPageId)!;page.buttons=[...(page.buttons??[]).filter(item=>item.index!==button.index),button];});}
  setSelectedButtonBehavior(behavior:KeyBehavior){this.change(document=>{const button=document.pages.find(page=>page.id===this.selectedPageId)?.buttons?.find(button=>button.index===this.selectedKey);if(!button)throw new Error('선택한 버튼이 없습니다.');button.behavior=validateKeyBehavior(behavior);});}
  copyButton(){this.clipboard=buttonEditing.copyButton(this.document,this.selectedPageId,this.selectedKey);}
  pasteButton(){if(!this.clipboard)throw new Error('복사한 버튼이 없습니다.');return this.replace(buttonEditing.pasteButton(this.document,this.selectedPageId,this.selectedKey,this.clipboard));}
  duplicateButton(targetIndex?:number){const page=this.document.pages.find(page=>page.id===this.selectedPageId)!,target=targetIndex??Array.from({length:15},(_,index)=>index).find(index=>!page.buttons?.some(button=>button.index===index));if(target===undefined)throw new Error('빈 키가 없습니다.');const changed=this.replace(buttonEditing.duplicateButton(this.document,this.selectedPageId,this.selectedKey,target));this.selectedKey=target;return changed;}
  moveButton(from:{pageId:string;index:number},to:{pageId:string;index:number},swap=false){const changed=this.replace(buttonEditing.moveButton(this.document,from,to,{swap}));this.selectedPageId=to.pageId;this.selectedKey=to.index;return changed;}
  removeButton(index=this.selectedKey){const changed=this.replace(buttonEditing.removeButton(this.document,this.selectedPageId,index));this.selectedKey=index;return changed;}
  setMotion(trigger:keyof StudioDocument['motion'],spec:TransitionSpec){this.change(document=>{document.motion[trigger]=spec;});}
  undo(){const previous=this.past.pop();if(!previous)return false;this.future.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId,selectedKey:this.selectedKey});this.document=previous.document;this.selectedPageId=previous.selectedPageId;this.selectedKey=previous.selectedKey;return true;}
  redo(){const next=this.future.pop();if(!next)return false;this.past.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId,selectedKey:this.selectedKey});this.document=next.document;this.selectedPageId=next.selectedPageId;this.selectedKey=next.selectedKey;return true;}
  markApplied(){this.applied=JSON.stringify(this.document);}
}
