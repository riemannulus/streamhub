import {expect,test} from 'bun:test';
import {singlePressBehavior,type ButtonDefinition} from '../../studio/document';
import {canvasLayersFor} from './canvas-view';

test('button background opacity never changes icon or label opacity',()=>{
  const button:ButtonDefinition={id:'transparent',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'icon-and-label',icon:{assetId:'a'.repeat(64),fit:'contain'},label:{text:'Play',position:'bottom',size:'medium',color:'#ffffff'},background:{color:'#172538',opacity:0}}};
  expect(canvasLayersFor(button)).toEqual({background:{color:'#172538',opacity:0},icon:{assetId:'a'.repeat(64),fit:'contain'},label:button.appearance.label});
});

test('an icon without a button background exposes the page layer',()=>{
  const button:ButtonDefinition={id:'alpha',index:0,behavior:singlePressBehavior({type:'none'}),appearance:{contentMode:'icon-only',icon:{assetId:'b'.repeat(64),fit:'cover'}}};
  expect(canvasLayersFor(button)).toEqual({icon:{assetId:'b'.repeat(64),fit:'cover'}});
});
