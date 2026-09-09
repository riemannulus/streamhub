import { test,expect } from 'bun:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkDraft } from './draft-check';
test('draft checks use arbitrary page IDs and skip absent routing rules',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'streamhub-draft-'));
  try{
    const result=await checkDraft({defaultPage:'tools',pages:[{id:'tools',title:'도구',buttons:[{index:3,type:'text',label:'준비'}]}]},['work'],directory);
    expect(result.passed).toBe(true);
    expect(result.checks.find(check=>check.name==='자동 전환')?.status).toBe('skip');
    expect(await Bun.file(join(directory,'replay.html')).exists()).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
});
