import {expect,test} from 'bun:test';
import {addActionStep,addDelayStep,moveStep,removeStep,setBranchEnabled,setProgramType,setSequenceMode,setThresholds} from './behavior-editor';
import {defaultStudioDocument,singlePressBehavior,type ButtonDefinition} from '../../studio/document';
import {StudioModel} from './model';

const button=():ButtonDefinition=>({id:'advanced',index:0,behavior:singlePressBehavior({type:'open-app',bundleId:'org.mozilla.firefox'}),appearance:{contentMode:'hidden'}});

test('edits multiple steps immutably with bounded delay and sequence modes',()=>{
  const input=button(),multiple=setProgramType(input,'press','sequence');
  expect((multiple.behavior.press as any).sequence.steps).toHaveLength(1);
  const added=addActionStep(multiple,'press',{type:'media',command:'play-pause'}),delayed=addDelayStep(added,'press',250),moved=moveStep(delayed,'press',2,-1),removed=removeStep(moved,'press',2);
  expect((removed.behavior.press as any).sequence.steps).toEqual([{type:'action',action:{type:'open-app',bundleId:'org.mozilla.firefox'}},{type:'delay',milliseconds:250}]);
  expect(input.behavior.press).toMatchObject({type:'single'});
  expect(()=>setSequenceMode(delayed,'press','parallel')).toThrow('delay');
  expect(setSequenceMode(added,'press','parallel').behavior.press).toMatchObject({sequence:{mode:'parallel'}});
});

test('configures toggle branches, double press, hold and thresholds',()=>{
  let value=setProgramType(button(),'press','toggle');expect(value.behavior.press).toMatchObject({type:'toggle',initial:'off'});
  value=setBranchEnabled(value,'doublePress',true);value=setBranchEnabled(value,'hold',true);expect(value.behavior.doublePress).toBeDefined();expect(value.behavior.hold).toBeDefined();
  value=setBranchEnabled(value,'doublePress',false);expect(value.behavior.doublePress).toBeUndefined();
  expect(setThresholds(value,{doublePressMs:250,holdMs:700}).behavior).toMatchObject({doublePressMs:250,holdMs:700});
  expect(()=>setThresholds(value,{doublePressMs:149})).toThrow('150–750');expect(()=>setThresholds(value,{doublePressMs:700,holdMs:600})).toThrow('greater');
});

test('one visible model behavior edit creates one undo entry',()=>{
  const document=defaultStudioDocument();document.pages[0].buttons=[button()];const model=new StudioModel(document);model.selectKey(0);
  model.setSelectedButtonBehavior(setProgramType(button(),'press','sequence').behavior);expect(model.document.pages[0].buttons![0]!.behavior.press).toMatchObject({type:'sequence'});
  expect(model.undo()).toBe(true);expect(model.document.pages[0].buttons![0]!.behavior.press).toMatchObject({type:'single'});expect(model.undo()).toBe(false);
});
