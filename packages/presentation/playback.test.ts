import {describe,expect,test} from 'bun:test';
import {playFramePlan,type FramePlan} from './playback';

const keys=(value:string)=>Array.from({length:15},()=>`data:image/png;base64,${value}`);
const plan:FramePlan={
  generation:'g1',
  frames:[
    {index:0,offsetMs:0,keys:keys('a')},
    {index:1,offsetMs:10,keys:keys('b')},
    {index:2,offsetMs:20,keys:keys('c')},
    {index:3,offsetMs:30,keys:keys('d')},
  ],
};

describe('playFramePlan',()=>{
  test('skips late intermediate frames but sends the exact final frame',async()=>{
    let now=0;
    const sent:number[]=[];
    const result=await playFramePlan(plan,async frame=>{
      sent.push(frame.index);
      now+=frame.index===1?18:1;
    },{
      now:()=>now,
      wait:async milliseconds=>{now+=milliseconds;},
    });

    expect(sent).toEqual([0,1,3]);
    expect(result).toEqual({generation:'g1',sent:[0,1,3],aborted:false,startedAt:0,finishedAt:31});
  });

  test('stops during a wait when a newer generation aborts playback',async()=>{
    let now=0;
    const controller=new AbortController();
    const sent:number[]=[];
    const result=await playFramePlan(plan,async frame=>{sent.push(frame.index);},{
      signal:controller.signal,
      now:()=>now,
      wait:async milliseconds=>{now+=milliseconds;controller.abort();},
    });

    expect(sent).toEqual([0]);
    expect(result.aborted).toBe(true);
  });

  test('validates the complete plan before sending its first frame',async()=>{
    let sends=0;
    const invalid={...plan,frames:[...plan.frames.slice(0,3),{index:3,offsetMs:5,keys:keys('d')}]} as FramePlan;
    await expect(playFramePlan(invalid,async()=>{sends++;})).rejects.toThrow('Frame offsets must increase');
    expect(sends).toBe(0);
  });
});
