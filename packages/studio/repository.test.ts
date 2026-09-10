import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {VisualAssetStore} from './assets';
import {StudioRepository,StudioVersionConflictError} from './repository';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const root=()=>{const value=mkdtempSync(join(tmpdir(),'streamhub-studio-'));roots.push(value);return value;};

describe('StudioRepository',()=>{
  test('persists v3 atomically and detects stale updates',async()=>{
    const directory=root(),repository=new StudioRepository(directory),a=repository.snapshot();
    expect(a.document.version).toBe(3);
    expect(a.document.id).toMatch(/^[0-9a-f-]{36}$/);
    const next=structuredClone(a.document);next.pages[0].title='Changed';
    const b=repository.apply(next,a.version);
    expect(b.version).not.toBe(a.version);
    expect(()=>repository.apply(next,a.version)).toThrow(StudioVersionConflictError);
    expect(new StudioRepository(directory).snapshot()).toEqual(b);
    const asset=await repository.putAsset(await sharp({create:{width:1,height:1,channels:3,background:'red'}}).png().toBuffer());
    expect(await repository.assets.has(asset)).toBe(true);
  });

  test('backs up v2 once, creates v3 and preserves assets',async()=>{
    const directory=root();mkdirSync(directory,{recursive:true});
    const assets=new VisualAssetStore(join(directory,'assets'));
    const bytes=await sharp({create:{width:2,height:2,channels:3,background:'yellow'}}).png().toBuffer();
    const assetId=await assets.put(bytes);
    writeFileSync(join(directory,'studio.json'),JSON.stringify({
      version:2,device:{kind:'streamdeck-classic-5x3'},defaultPageId:'home',pages:[{id:'home',title:'홈'}],standby:{color:'#000000'},
      motion:{pageChange:{type:'crossfade',durationMs:280},unlock:{type:'crossfade',durationMs:480},reconnect:{type:'crossfade',durationMs:360}},
    }));
    const repository=new StudioRepository(directory),first=repository.snapshot();
    expect(first.document.version).toBe(3);
    expect(first.reset).toMatchObject({fromVersion:2});
    const backups=readdirSync(directory).filter(name=>/^studio\.v2\.\d{8}T\d{6}Z\.backup\.json$/.test(name));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(directory,backups[0]),'utf8')).version).toBe(2);
    expect(Buffer.from(await repository.assets.read(assetId))).toEqual(Buffer.from(await assets.read(assetId)));
    expect(repository.snapshot().reset).toBeUndefined();
  });
});
