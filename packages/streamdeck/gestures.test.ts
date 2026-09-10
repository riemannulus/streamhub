import {expect,test} from 'bun:test';
import {createGestureRecognizer,type Gesture} from './gestures';

class Clock{
  now=0;tasks:{at:number;callback:()=>void;cancelled:boolean}[]=[];
  schedule=(delay:number,callback:()=>void)=>{const task={at:this.now+delay,callback,cancelled:false};this.tasks.push(task);return{cancel:()=>{task.cancelled=true;}};};
  advance(milliseconds:number){const target=this.now+milliseconds;for(;;){const task=this.tasks.filter(item=>!item.cancelled&&item.at<=target).sort((a,b)=>a.at-b.at)[0];if(!task)break;task.cancelled=true;this.now=task.at;task.callback();}this.now=target;}
}
const setup=(branches:Record<number,{press?:boolean;doublePress?:boolean;hold?:boolean;doublePressMs:number;holdMs:number}>)=>{const clock=new Clock(),events:{key:number;revision:number;gesture:Gesture}[]=[];return{clock,events,recognizer:createGestureRecognizer({schedule:clock.schedule,resolve:key=>branches[key],emit:(key,revision,gesture)=>events.push({key,revision,gesture})})};};

test('emits immediate press without double and defers an exclusive double press branch',()=>{
  const {clock,events,recognizer}=setup({0:{press:true,doublePressMs:300,holdMs:500},1:{press:true,doublePress:true,doublePressMs:300,holdMs:500}});
  recognizer.accept({type:'down',key:0,bindingRevision:1,at:0});recognizer.accept({type:'up',key:0,bindingRevision:1,at:20});expect(events.map(event=>event.gesture)).toEqual(['press']);
  recognizer.accept({type:'down',key:1,bindingRevision:1,at:30});recognizer.accept({type:'up',key:1,bindingRevision:1,at:50});clock.advance(299);expect(events).toHaveLength(1);
  recognizer.accept({type:'down',key:1,bindingRevision:1,at:349});recognizer.accept({type:'up',key:1,bindingRevision:1,at:360});expect(events.at(-1)?.gesture).toBe('double-press');clock.advance(500);expect(events.filter(event=>event.key===1)).toHaveLength(1);
});

test('two presses outside the window emit separate presses and hold suppresses release',()=>{
  const {clock,events,recognizer}=setup({0:{press:true,doublePress:true,hold:true,doublePressMs:250,holdMs:500}});
  recognizer.accept({type:'down',key:0,bindingRevision:2,at:0});recognizer.accept({type:'up',key:0,bindingRevision:2,at:20});clock.advance(251);expect(events.map(event=>event.gesture)).toEqual(['press']);
  recognizer.accept({type:'down',key:0,bindingRevision:2,at:300});clock.advance(500);expect(events.at(-1)?.gesture).toBe('hold');recognizer.accept({type:'up',key:0,bindingRevision:2,at:810});clock.advance(300);expect(events.map(event=>event.gesture)).toEqual(['press','hold']);
});

test('rejects duplicates, stale revisions and out-of-order events while keys stay independent',()=>{
  const {events,recognizer}=setup({0:{press:true,doublePressMs:300,holdMs:500},1:{press:true,doublePressMs:300,holdMs:500}});
  recognizer.accept({type:'up',key:0,bindingRevision:1,at:0});recognizer.accept({type:'down',key:0,bindingRevision:1,at:10});recognizer.accept({type:'down',key:0,bindingRevision:1,at:11});recognizer.accept({type:'down',key:1,bindingRevision:1,at:12});
  recognizer.accept({type:'up',key:0,bindingRevision:2,at:13});recognizer.accept({type:'up',key:1,bindingRevision:1,at:14});recognizer.accept({type:'up',key:0,bindingRevision:1,at:9});recognizer.accept({type:'up',key:0,bindingRevision:1,at:15});
  expect(events).toEqual([{key:1,revision:1,gesture:'press'},{key:0,revision:1,gesture:'press'}]);
});

test('revision replacement and cancel-all discard pending press and hold timers',()=>{
  const {clock,events,recognizer}=setup({0:{press:true,doublePress:true,hold:true,doublePressMs:300,holdMs:500}});
  recognizer.accept({type:'down',key:0,bindingRevision:1,at:0});recognizer.accept({type:'up',key:0,bindingRevision:1,at:20});
  recognizer.accept({type:'down',key:0,bindingRevision:2,at:30});clock.advance(100);recognizer.accept({type:'cancel-all',reason:'page',at:130});clock.advance(1000);expect(events).toEqual([]);
});
