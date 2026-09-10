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
