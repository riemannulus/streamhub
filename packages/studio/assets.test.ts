import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {VisualAssetStore} from './assets';

const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const store=()=>{const root=mkdtempSync(join(tmpdir(),'streamhub-assets-'));roots.push(root);return new VisualAssetStore(root)};
describe('VisualAssetStore',()=>{
  test('normalizes to PNG, rotates metadata and deduplicates bytes',async()=>{const s=store();const input=await sharp({create:{width:2,height:3,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer();const a=await s.put(input),b=await s.put(input);expect(a).toBe(b);expect((await sharp(await s.read(a)).metadata()).format).toBe('png');expect(statSync(join(s.directory,a+'.png')).mode&0o777).toBe(0o600);});
  test('rejects invalid data, limits and traversal IDs',async()=>{const s=store();await expect(s.put(Buffer.from('<svg/>'))).rejects.toThrow();await expect(s.put(Buffer.alloc(8*1024*1024+1))).rejects.toThrow();await expect(s.put(await sharp({create:{width:4097,height:4097,channels:3,background:'red'}}).png().toBuffer())).rejects.toThrow('pixel');await expect(s.read('../secret')).rejects.toThrow('asset ID');});
});
