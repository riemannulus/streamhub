import {describe,expect,test} from 'bun:test';
import {join} from 'node:path';
import sharp from 'sharp';

const pluginRoot=join(import.meta.dir,'..');
const profile=join(pluginRoot,'com.streamhub.studio.sdPlugin','profiles','Streamhub.streamDeckProfile');

describe('bundled Stream Deck profile',()=>{
  test('uses the importable plugin profile envelope and contains all 15 canvas cells',()=>{
    const generated=Bun.spawnSync(['bun','scripts/generate-assets.ts'],{cwd:pluginRoot});
    expect(generated.exitCode).toBe(0);

    const listed=Bun.spawnSync(['unzip','-Z1',profile]);
    expect(listed.exitCode).toBe(0);
    const entries=new TextDecoder().decode(listed.stdout).trim().split('\n');
    const manifestPath=entries.find(entry=>/^[^/]+\.sdProfile\/manifest\.json$/.test(entry));
    expect(manifestPath).toBeDefined();
    expect(entries).not.toContain('manifest.json');

    const extracted=Bun.spawnSync(['unzip','-p',profile,manifestPath!]);
    expect(extracted.exitCode).toBe(0);
    const manifest=JSON.parse(new TextDecoder().decode(extracted.stdout));
    expect(manifest).toMatchObject({
      DeviceModel:'20GBA9901',
      InstalledByPluginUUID:'com.streamhub.studio',
      Name:'Streamhub',
      PreconfiguredName:'Streamhub',
      Version:'1.0',
    });
    expect(Object.keys(manifest.Actions)).toHaveLength(15);
    expect(Object.values(manifest.Actions).every((action:any)=>action.UUID==='com.streamhub.studio.canvas-cell')).toBeTrue();
  });

  test('uses a neutral black fallback key while dynamic images are warming',async()=>{
    const generated=Bun.spawnSync(['bun','scripts/generate-assets.ts'],{cwd:pluginRoot});
    expect(generated.exitCode).toBe(0);
    const pixels=await sharp(join(pluginRoot,'com.streamhub.studio.sdPlugin','imgs','key.png')).removeAlpha().raw().toBuffer();
    expect(pixels.every(channel=>channel===0)).toBe(true);
  });
});
