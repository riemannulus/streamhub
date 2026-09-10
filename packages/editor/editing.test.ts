import {expect,test} from 'bun:test';
import {addPage,deletePage,duplicatePage,movePage,pageReferences,renamePage,setDefaultPage} from './editing';
import {actionsInBehavior,defaultStudioDocument,singlePressBehavior,type StudioDocument} from '../studio/document';

const initial=():StudioDocument=>{
  const document=defaultStudioDocument({id:'11111111-1111-4111-8111-111111111111'});
  document.pages=[
    {id:'home',title:'Home',buttons:[
      {id:'to-home',index:0,behavior:singlePressBehavior({type:'go-to-page',pageId:'home'}),appearance:{contentMode:'hidden'}},
      {id:'to-web',index:1,behavior:singlePressBehavior({type:'go-to-page',pageId:'web'}),appearance:{contentMode:'hidden'}},
    ]},
    {id:'web',title:'Web'},
    {id:'media',title:'Media'},
  ];
  return document;
};

test('page commands rename, move and choose a default without mutating input',()=>{
  const document=initial();
  expect(renamePage(document,'home','홈').pages[0].title).toBe('홈');
  expect(movePage(document,'media',-1).pages.map(page=>page.id)).toEqual(['home','media','web']);
  expect(setDefaultPage(document,'media').defaultPageId).toBe('media');
  expect(document.pages.map(page=>page.title)).toEqual(['Home','Web','Media']);
  expect(document.defaultPageId).toBe('home');
  expect(()=>renamePage(document,'missing','x')).toThrow('Unknown page');
  expect(()=>movePage(document,'home',0 as -1)).toThrow('Invalid page movement');
  expect(()=>setDefaultPage(document,'missing')).toThrow('Unknown page');
});

test('addPage generates a valid unique ID and enforces the page ceiling',()=>{
  const document=initial();document.pages.push({id:'page-4',title:'Existing'});
  const added=addPage(document);
  expect(added.pages.at(-1)).toMatchObject({id:'page-5',title:'페이지 5'});
  expect(document.pages).toHaveLength(4);
  let full=initial();
  while(full.pages.length<32)full=addPage(full);
  expect(()=>addPage(full)).toThrow('at most 32 pages');
});

test('duplicatePage gives pages and buttons unique IDs and remaps self references',()=>{
  const document=initial(),duplicated=duplicatePage(document,'home'),copy=duplicated.pages.at(-1)!;
  expect(copy).toMatchObject({id:'home-copy',title:'Home (복사)'});
  expect(copy.buttons?.map(button=>button.id)).toEqual(['to-home-copy','to-web-copy']);
  expect(copy.buttons?.flatMap(button=>actionsInBehavior(button.behavior))).toEqual([
    {type:'go-to-page',pageId:'home-copy'},
    {type:'go-to-page',pageId:'web'},
  ]);
  expect(document.pages).toHaveLength(3);
  const twice=duplicatePage(duplicated,'home');
  expect(twice.pages.at(-1)).toMatchObject({id:'home-copy-2',title:'Home (복사 2)'});
  expect(()=>duplicatePage(document,'missing')).toThrow('Unknown page');
});

test('pageReferences reports incoming buttons and deletion never rewrites them silently',()=>{
  const document=initial();
  expect(pageReferences(document,'web')).toEqual([{pageId:'home',buttonId:'to-web'}]);
  expect(()=>deletePage(document,'web')).toThrow('page is still referenced');
  expect(document.pages).toHaveLength(3);
});

test('copy and references traverse every isolated behavior branch and sequence',()=>{
  const document=initial(),button=document.pages[0].buttons![0]!;
  button.behavior={
    press:{type:'sequence',sequence:{mode:'sequential',steps:[{type:'action',action:{type:'open-app',bundleId:'org.mozilla.firefox'}},{type:'action',action:{type:'go-to-page',pageId:'web'}}]}},
    doublePress:{type:'single',action:{type:'go-to-page',pageId:'media'}},
    hold:{type:'toggle',initial:'off',offToOn:{mode:'sequential',steps:[{type:'action',action:{type:'go-to-page',pageId:'web'}}]},onToOff:{mode:'sequential',steps:[{type:'action',action:{type:'go-to-page',pageId:'home'}}]}},
    doublePressMs:300,holdMs:500,
  };
  expect(pageReferences(document,'web')).toContainEqual({pageId:'home',buttonId:'to-home'});
  const copy=duplicatePage(document,'home'),copied=copy.pages.at(-1)!.buttons![0]!;
  expect(actionsInBehavior(copied.behavior).filter(action=>action.type==='go-to-page').map(action=>action.pageId)).toEqual(['web','media','web','home-copy']);
  (copied.behavior.press as any).sequence.steps[0].action.bundleId='changed';
  expect((button.behavior.press as any).sequence.steps[0].action.bundleId).toBe('org.mozilla.firefox');
});

test('deletePage protects the only page and requires an explicit default replacement',()=>{
  const single=defaultStudioDocument({id:'22222222-2222-4222-8222-222222222222'});
  expect(()=>deletePage(single,'home')).toThrow('only page');

  const document=initial();document.pages[0].buttons=[];
  expect(()=>deletePage(document,'home')).toThrow('replacement');
  expect(()=>deletePage(document,'home','missing')).toThrow('Unknown replacement');
  const deleted=deletePage(document,'home','web');
  expect(deleted.pages.map(page=>page.id)).toEqual(['web','media']);
  expect(deleted.defaultPageId).toBe('web');
  expect(()=>deletePage(document,'media','web')).toThrow('only accepted for the default');
  expect(()=>deletePage(document,'missing')).toThrow('Unknown page');
});

test('boundary page movement returns an isolated validated clone',()=>{
  const document=initial(),unchanged=movePage(document,'home',-1);
  expect(unchanged).toEqual(document);expect(unchanged).not.toBe(document);
  unchanged.pages[0].title='Changed';expect(document.pages[0].title).toBe('Home');
});
