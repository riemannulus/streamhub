import { test,expect } from 'bun:test';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ArtifactRecorder } from './artifacts';

test('artifacts retain exact partial key writes, standby and safe offline replay',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'streamhub-artifact-'));
  try{
    const recorder=new ArtifactRecorder(directory),rgb=Buffer.alloc(72*72*3);
    for(let i=0;i<rgb.length;i+=3)rgb[i]=255;
    recorder.record({type:'key',at:1,index:4,rgb});
    const path=await recorder.screenshot('partial');
    const {data,info}=await sharp(path).raw().toBuffer({resolveWithObject:true});
    expect([info.width,info.height]).toEqual([408,248]);
    expect([...data.subarray((8*408+328)*3,(8*408+328)*3+3)]).toEqual([255,0,0]);
    recorder.record({type:'standby',at:2});
    recorder.record({type:'note',at:3,message:'</script><script>alert(1)</script>'});
    await recorder.finish({passed:true});
    const trace=(await readFile(join(directory,'trace.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(trace.map(e=>e.type)).toEqual(['key','standby','note']);
    expect(await readFile(join(directory,'rgb',`${trace[0].asset}.rgb`))).toEqual(rgb);
    const html=await readFile(join(directory,'replay.html'),'utf8');
    expect(html).not.toContain('</script><script>alert');
    const standby=await sharp(await recorder.screenshot('standby')).raw().toBuffer();
    expect([...standby.subarray((8*408+328)*3,(8*408+328)*3+3)]).toEqual([24,24,24]);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('recording failures cannot publish a successful summary',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'streamhub-artifact-failure-'));
  try{
    const recorder=new ArtifactRecorder(directory);
    recorder.record({type:'key',at:0,index:0,rgb:Buffer.alloc(1)});
    await expect(recorder.finish({passed:true})).rejects.toThrow('Invalid simulator RGB event');
    expect(await Bun.file(join(directory,'summary.json')).exists()).toBe(false);
  }finally{await rm(directory,{recursive:true,force:true});}
});
