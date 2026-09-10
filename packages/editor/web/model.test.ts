import {expect,test} from 'bun:test';
import {defaultStudioDocument} from '../../studio/document';
import {StudioModel} from './model';

test('canvas model edits v3 backgrounds, hidden apps, motion and history',()=>{
  const model=new StudioModel(defaultStudioDocument());
  model.setBackground('page','a'.repeat(64));
  model.setButton({id:'firefox',index:0,action:{type:'open-app',bundleId:'org.mozilla.firefox'},appearance:{contentMode:'hidden'}});
  model.setMotion('unlock',{type:'fade-through-black',durationMs:400});
  expect(model.document.pages[0].buttons?.[0]).toMatchObject({action:{type:'open-app'}});
  model.undo();expect(model.document.motion.unlock.type).toBe('crossfade');
  model.redo();expect(model.dirty).toBe(true);model.markApplied();expect(model.dirty).toBe(false);
});

test('page command wrappers create one history entry and keep selection deterministic',()=>{
  const document=defaultStudioDocument();document.pages.push({id:'web',title:'Web'});
  const model=new StudioModel(document);
  model.addPage();expect(model.selectedPageId).toBe('page-3');
  model.renamePage('page-3','Tools');expect(model.document.pages.at(-1)?.title).toBe('Tools');
  model.duplicatePage('web');expect(model.selectedPageId).toBe('web-copy');
  model.movePage('web-copy',-1);expect(model.selectedPageId).toBe('web-copy');
  model.setDefaultPage('web');expect(model.document.defaultPageId).toBe('web');
  model.deletePage('web-copy');expect(model.selectedPageId).toBe('page-3');
  model.undo();expect(model.document.pages.some(page=>page.id==='web-copy')).toBe(true);
  expect(model.selectedPageId).toBe('web-copy');
});

test('button gestures create one undo entry, preserve selection and branch history',()=>{
  const document=defaultStudioDocument();document.pages.push({id:'web',title:'Web'});document.pages[0].buttons=[{id:'one',index:0,action:{type:'none'},appearance:{contentMode:'hidden'}}];const model=new StudioModel(document);
  model.selectKey(0);model.copyButton();model.selectPage('web');model.selectKey(3);model.pasteButton();expect(model.document.pages[1].buttons?.[0].index).toBe(3);
  model.undo();expect(model.document.pages[1].buttons).toBeUndefined();expect(model.selectedPageId).toBe('web');expect(model.selectedKey).toBe(3);
  model.redo();expect(model.document.pages[1].buttons).toHaveLength(1);
  model.undo();model.selectPage('home');model.selectKey(0);model.duplicateButton(2);expect(model.document.pages[0].buttons).toHaveLength(2);model.undo();expect(model.document.pages[0].buttons).toHaveLength(1);model.redo();expect(model.document.pages[0].buttons).toHaveLength(2);
});
