import {validateStudioDocument,type ButtonDefinition,type StudioDocument,type TransitionSpec} from '../../studio/document';
import * as editing from '../editing';

export class StudioModel{
  private past:{document:StudioDocument;selectedPageId:string}[]=[];
  private future:{document:StudioDocument;selectedPageId:string}[]=[];
  private applied:string;
  document:StudioDocument;
  selectedPageId:string;
  selectedKey=0;
  constructor(document:StudioDocument){this.document=validateStudioDocument(document);this.selectedPageId=this.document.defaultPageId;this.applied=JSON.stringify(this.document);}
  get dirty(){return JSON.stringify(this.document)!==this.applied;}
  private replace(next:StudioDocument){this.past.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId});if(this.past.length>100)this.past.shift();this.future=[];this.document=validateStudioDocument(next);}
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
  setButton(button:ButtonDefinition){this.change(document=>{const page=document.pages.find(page=>page.id===this.selectedPageId)!;page.buttons=[...(page.buttons??[]).filter(item=>item.index!==button.index),button];});}
  removeButton(index:number){this.change(document=>{const page=document.pages.find(page=>page.id===this.selectedPageId)!;page.buttons=page.buttons?.filter(button=>button.index!==index);});}
  setMotion(trigger:keyof StudioDocument['motion'],spec:TransitionSpec){this.change(document=>{document.motion[trigger]=spec;});}
  undo(){const previous=this.past.pop();if(previous){this.future.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId});this.document=previous.document;this.selectedPageId=previous.selectedPageId;}}
  redo(){const next=this.future.pop();if(next){this.past.push({document:structuredClone(this.document),selectedPageId:this.selectedPageId});this.document=next.document;this.selectedPageId=next.selectedPageId;}}
  markApplied(){this.applied=JSON.stringify(this.document);}
}
