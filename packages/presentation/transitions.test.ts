import {describe,expect,test} from 'bun:test';import sharp from 'sharp';import {TransitionCompiler} from './transitions';
const canvas=async(color:string)=>await sharp({create:{width:480,height:272,channels:4,background:color}}).png().toBuffer();
describe('TransitionCompiler',()=>{
  test('compiles a 30fps unlock with lightweight intermediates and an exact PNG destination',async()=>{
    const plan=await new TransitionCompiler().compile(await canvas('#000000'),await canvas('#ffffff'),{type:'crossfade',durationMs:480},7);
    expect(plan.frames).toHaveLength(15);
    expect(plan.frames.at(-1)?.offsetMs).toBe(480);
    expect(plan.frames.slice(0,-1).every(frame=>frame.keys.every(key=>key.startsWith('data:image/jpeg;base64,')))).toBe(true);
    expect(plan.frames.at(-1)?.keys.every(key=>key.startsWith('data:image/png;base64,'))).toBe(true);
    const last=Buffer.from(plan.frames.at(-1)!.keys[0]!.split(',')[1]!,'base64');
    const pixel=await sharp(last).raw().toBuffer();
    expect([...pixel.subarray(0,3)]).toEqual([255,255,255]);
    expect(plan.generation).toBe('7');
  });
  test('none produces just final frame',async()=>{expect((await new TransitionCompiler().compile(await canvas('red'),await canvas('blue'),{type:'none',durationMs:0},1)).frames).toHaveLength(1);});
});
