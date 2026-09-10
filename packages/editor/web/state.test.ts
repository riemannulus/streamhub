import {expect,test} from 'bun:test';
import {filteredActions} from './action-library';
import {inspectorFor} from './inspector-view';
import type {ButtonDefinition} from '../../studio/document';
import {defaultStudioDocument,validateStudioDocument} from '../../studio/document';
import {createButtonForAction} from './action-library';

const appearance={contentMode:'hidden' as const};
test('action search matches Korean labels and stable action types across groups',()=>{
  expect(filteredActions('페이지')).toEqual(expect.arrayContaining(['go-to-page','previous-page','next-page','page-indicator']));
  expect(filteredActions('open-url')).toEqual(['open-url']);
  expect(filteredActions('미디어')).toContain('media');
  expect(filteredActions('동적')).toEqual(expect.arrayContaining(['dynamic-region','dynamic-previous','dynamic-next']));
});

test('inspector fields depend on action while appearance fields stay explicit',()=>{
  const openAppButton:ButtonDefinition={id:'app',index:0,action:{type:'open-app',bundleId:'org.mozilla.firefox'},appearance};
  const pageIndicatorButton:ButtonDefinition={id:'indicator',index:1,action:{type:'page-indicator'},appearance};
  expect(inspectorFor(openAppButton)).toEqual(['action','content-mode','icon','label','background']);
  expect(inspectorFor(pageIndicatorButton)).toEqual(['content-mode','icon','label','background']);
  expect(inspectorFor(undefined)).toEqual(['empty']);
});

test('every available core library action creates a valid v3 button',()=>{
  const types=filteredActions('').filter(type=>!type.startsWith('dynamic-')) as ButtonDefinition['action']['type'][];
  for(const [index,type] of types.entries()){
    const document=defaultStudioDocument();document.pages[0].buttons=[createButtonForAction(type,index,{pageId:'home',appBundleId:'org.mozilla.firefox',registered:[{name:'build',args:['target']} ]})];
    expect(()=>validateStudioDocument(document,{actions:{build:{args:{target:{}}}}})).not.toThrow();
  }
});
