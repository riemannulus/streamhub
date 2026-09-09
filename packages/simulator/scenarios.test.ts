import { test,expect } from 'bun:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScenario } from './scenarios';

test('a failed scenario preserves failure evidence and cleans the running host',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'streamhub-failed-scenario-'));
  let url='';
  try{
    const result=await runScenario({name:'intentional-failure',description:'failure evidence test',async run(sim){url=sim.url;throw new Error('Expected test failure');}},directory);
    expect(result.passed).toBe(false);
    expect(result.error).toContain('Expected test failure');
    expect(JSON.parse(await readFile(join(directory,'summary.json'),'utf8')).result.passed).toBe(false);
    expect(await Bun.file(join(directory,'failure.png')).exists()).toBe(true);
    expect(await Bun.file(join(directory,'replay.html')).exists()).toBe(true);
    await expect(fetch(url,{signal:AbortSignal.timeout(300)})).rejects.toThrow();
  }finally{await rm(directory,{recursive:true,force:true});}
});
