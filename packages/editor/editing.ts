import {validateStudioDocument,type StudioDocument,type StudioPage} from '../studio/document';

export type PageReference={pageId:string;buttonId:string};

function clone(input:StudioDocument):StudioDocument{return validateStudioDocument(input);}
function page(document:StudioDocument,pageId:string):StudioPage{
  const result=document.pages.find(item=>item.id===pageId);
  if(!result)throw new Error(`Unknown page: ${pageId}`);
  return result;
}
function uniqueId(used:ReadonlySet<string>,base:string):string{
  let result=base.slice(0,64),number=2;
  while(used.has(result)){
    const suffix=`-${number++}`;
    result=base.slice(0,64-suffix.length)+suffix;
  }
  return result;
}
function titleForCopy(document:StudioDocument,title:string):string{
  let suffix=' (복사)',number=2,result=title.slice(0,80-suffix.length)+suffix;
  while(document.pages.some(item=>item.title===result)){
    suffix=` (복사 ${number++})`;
    result=title.slice(0,80-suffix.length)+suffix;
  }
  return result;
}

export function addPage(input:StudioDocument):StudioDocument{
  const document=clone(input);
  if(document.pages.length>=32)throw new Error('Studio supports at most 32 pages');
  const used=new Set(document.pages.map(item=>item.id));
  let number=document.pages.length+1;
  while(used.has(`page-${number}`))number++;
  document.pages.push({id:`page-${number}`,title:`페이지 ${number}`});
  return validateStudioDocument(document);
}

export function renamePage(input:StudioDocument,pageId:string,title:string):StudioDocument{
  const document=clone(input);page(document,pageId).title=title;
  return validateStudioDocument(document);
}

export function duplicatePage(input:StudioDocument,pageId:string):StudioDocument{
  const document=clone(input);
  if(document.pages.length>=32)throw new Error('Studio supports at most 32 pages');
  const original=page(document,pageId),pageIds=new Set(document.pages.map(item=>item.id));
  const copy=structuredClone(original),copyId=uniqueId(pageIds,`${original.id.slice(0,59)}-copy`);
  copy.id=copyId;copy.title=titleForCopy(document,original.title);
  const buttonIds=new Set(document.pages.flatMap(item=>(item.buttons??[]).map(button=>button.id)));
  for(const button of copy.buttons??[]){
    button.id=uniqueId(buttonIds,`${button.id.slice(0,59)}-copy`);buttonIds.add(button.id);
    if(button.action.type==='go-to-page'&&button.action.pageId===original.id)button.action.pageId=copyId;
  }
  document.pages.push(copy);
  return validateStudioDocument(document);
}

export function movePage(input:StudioDocument,pageId:string,offset:-1|1):StudioDocument{
  const document=clone(input),index=document.pages.findIndex(item=>item.id===pageId);
  if(index<0)throw new Error(`Unknown page: ${pageId}`);
  if(offset!==-1&&offset!==1)throw new Error('Invalid page movement');
  const target=index+offset;
  if(target>=0&&target<document.pages.length)[document.pages[index],document.pages[target]]=[document.pages[target]!,document.pages[index]!];
  return validateStudioDocument(document);
}

export function setDefaultPage(input:StudioDocument,pageId:string):StudioDocument{
  const document=clone(input);page(document,pageId);document.defaultPageId=pageId;
  return validateStudioDocument(document);
}

export function pageReferences(input:StudioDocument,targetPageId:string):PageReference[]{
  const document=clone(input);page(document,targetPageId);
  return document.pages.flatMap(item=>(item.buttons??[])
    .filter(button=>button.action.type==='go-to-page'&&button.action.pageId===targetPageId)
    .map(button=>({pageId:item.id,buttonId:button.id})));
}

export function deletePage(input:StudioDocument,pageId:string,replacementPageId?:string):StudioDocument{
  const document=clone(input);page(document,pageId);
  if(document.pages.length===1)throw new Error('Cannot delete the only page');
  const deletingDefault=document.defaultPageId===pageId;
  if(!deletingDefault&&replacementPageId!==undefined)throw new Error('A replacement is only accepted for the default page');
  if(deletingDefault){
    if(replacementPageId===undefined)throw new Error('Deleting the default page requires a replacement');
    if(replacementPageId===pageId||!document.pages.some(item=>item.id===replacementPageId))throw new Error('Unknown replacement page');
  }
  if(pageReferences(document,pageId).length)throw new Error('Cannot delete page: page is still referenced');
  document.pages=document.pages.filter(item=>item.id!==pageId);
  if(deletingDefault)document.defaultPageId=replacementPageId!;
  return validateStudioDocument(document);
}
