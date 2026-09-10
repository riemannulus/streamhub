import {expect,test} from 'bun:test';
import {copyButton,duplicateButton,moveButton,pasteButton,removeButton,shortcutFor,type ButtonClipboard} from './clipboard';
import {defaultStudioDocument,type StudioDocument} from '../../studio/document';

const document=():StudioDocument=>{
  const value=defaultStudioDocument({id:'33333333-3333-4333-8333-333333333333'});value.pages=[{id:'home',title:'Home',buttons:[
    {id:'one',index:0,action:{type:'open-app',bundleId:'org.mozilla.firefox'},appearance:{contentMode:'icon-only',icon:{assetId:'a'.repeat(64),fit:'contain'}}},
    {id:'two',index:1,action:{type:'none'},appearance:{contentMode:'hidden'}},
  ]},{id:'web',title:'Web'}];return value;
};

test('move handles blank targets and requires explicit swap confirmation for occupied targets',()=>{
  const input=document(),moved=moveButton(input,{pageId:'home',index:0},{pageId:'web',index:4});
  expect(moved.pages[0].buttons?.map(button=>button.index)).toEqual([1]);expect(moved.pages[1].buttons?.[0]).toMatchObject({id:'one',index:4});
  expect(input.pages[0].buttons?.[0]).toMatchObject({id:'one',index:0});
  expect(()=>moveButton(input,{pageId:'home',index:0},{pageId:'home',index:1})).toThrow('confirmation');
  const swapped=moveButton(input,{pageId:'home',index:0},{pageId:'home',index:1},{swap:true});expect(swapped.pages[0].buttons?.find(button=>button.id==='one')).toMatchObject({index:1});expect(swapped.pages[0].buttons?.find(button=>button.id==='two')).toMatchObject({index:0});
});

test('copy stays in memory and cross-page paste assigns a fresh ID while preserving assets',()=>{
  const input=document(),clipboard=copyButton(input,'home',0)!;
  expect(clipboard).toEqual({version:1,button:{action:{type:'open-app',bundleId:'org.mozilla.firefox'},appearance:{contentMode:'icon-only',icon:{assetId:'a'.repeat(64),fit:'contain'}}}});
  const pasted=pasteButton(input,'web',3,clipboard);expect(pasted.pages[1].buttons?.[0]).toMatchObject({index:3,action:{type:'open-app'},appearance:{icon:{assetId:'a'.repeat(64)}}});expect(pasted.pages[1].buttons?.[0].id).not.toBe('one');
  (clipboard.button.action as {bundleId:string}).bundleId='changed';expect(input.pages[0].buttons?.[0].action).toMatchObject({bundleId:'org.mozilla.firefox'});
});

test('duplicate and remove are immutable, bounded and collision-safe',()=>{
  const input=document(),duplicated=duplicateButton(input,'home',0,2);expect(duplicated.pages[0].buttons).toHaveLength(3);expect(duplicated.pages[0].buttons?.find(button=>button.index===2)?.id).not.toBe('one');
  const removed=removeButton(duplicated,'home',1);expect(removed.pages[0].buttons?.map(button=>button.index)).toEqual([0,2]);expect(duplicated.pages[0].buttons).toHaveLength(3);
  expect(()=>pasteButton(input,'home',1,copyButton(input,'home',0)!)).toThrow('occupied');
  expect(()=>duplicateButton(input,'home',0,1)).toThrow('occupied');
  expect(()=>pasteButton(input,'home',3,{version:2} as unknown as ButtonClipboard)).toThrow('clipboard');
});

test('keyboard shortcuts ignore text entry controls and map editing chords',()=>{
  expect(shortcutFor({key:'c',metaKey:true,shiftKey:false,target:{tagName:'DIV'}})).toBe('copy');
  expect(shortcutFor({key:'v',metaKey:true,shiftKey:false,target:{tagName:'INPUT'}})).toBeUndefined();
  expect(shortcutFor({key:'z',metaKey:true,shiftKey:true,target:{tagName:'DIV'}})).toBe('redo');
  expect(shortcutFor({key:'Backspace',metaKey:false,shiftKey:false,target:{tagName:'DIV'}})).toBe('remove');
  expect(shortcutFor({key:'d',metaKey:true,shiftKey:false,target:{tagName:'TEXTAREA'}})).toBeUndefined();
});
