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
