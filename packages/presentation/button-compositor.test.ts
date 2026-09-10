import {createHash} from 'node:crypto';
import {describe,expect,test} from 'bun:test';
import sharp from 'sharp';
import type {ButtonAppearance} from '../studio/document';
import {composeButton} from './button-compositor';

const png=(color:string,width=72,height=72)=>sharp({create:{width,height,channels:4,background:color}}).png().toBuffer();
const label={text:'Run',position:'bottom' as const,size:'medium' as const,color:'#ffffff'};
const reader=(assets:Record<string,Buffer>)=>({read:async(id:string)=>{const value=assets[id];if(!value)throw new Error('missing');return value;}});
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');

describe('composeButton',()=>{
  test('composes all four modes deterministically and preserves hidden background bytes',async()=>{
    const background=await png('#112233'),icon=await png('#0000ff',16,16),assetId='a'.repeat(64),assets=reader({[assetId]:icon});
    const appearances:ButtonAppearance[]=[
      {contentMode:'icon-and-label',icon:{assetId,fit:'contain'},label},
      {contentMode:'icon-only',icon:{assetId,fit:'contain'}},
      {contentMode:'label-only',label},
      {contentMode:'hidden'},
    ];
    const results=await Promise.all(appearances.map(appearance=>composeButton({appearance,background,assets})));
    expect(new Set(results.map(hash)).size).toBe(4);
    expect(results[3]).toEqual(background);
    for(const result of results){const metadata=await sharp(result).metadata();expect(metadata).toMatchObject({width:72,height:72,channels:4});}
  });

  test('keeps icon pixels out of label-only and places them in icon modes',async()=>{
    const background=await png('#000000'),icon=await png('#0000ff',16,16),assetId='b'.repeat(64),assets=reader({[assetId]:icon});
    const iconOnly=await sharp(await composeButton({appearance:{contentMode:'icon-only',icon:{assetId,fit:'contain'}},background,assets})).raw().toBuffer();
    const labelOnly=await sharp(await composeButton({appearance:{contentMode:'label-only',label},background,assets})).raw().toBuffer();
    const bluePixels=(bytes:Buffer)=>Array.from({length:72*72},(_,index)=>bytes[index*4]===0&&bytes[index*4+1]===0&&bytes[index*4+2]===255).filter(Boolean).length;
    expect(bluePixels(iconOnly)).toBeGreaterThan(0);
    expect(bluePixels(labelOnly)).toBe(0);
  });

  test('layers background, icon, label and runtime badge without mutating inputs',async()=>{
    const background=await png('#101010'),buttonBackground=await png('#00ff00',8,8),icon=await png('#0000ff',8,8),backgroundId='c'.repeat(64),iconId='d'.repeat(64),assets=reader({[backgroundId]:buttonBackground,[iconId]:icon});
    const appearance:ButtonAppearance={contentMode:'icon-and-label',icon:{assetId:iconId,fit:'cover'},label,background:{assetId:backgroundId,color:'#ff0000',opacity:0.5}};
    const before=structuredClone(appearance),result=await composeButton({appearance,background,assets,runtime:{label:'Live',detail:'waiting',badge:'!'}});
    expect(appearance).toEqual(before);
    expect(hash(result)).not.toBe(hash(background));
    expect((await sharp(result).metadata()).channels).toBe(4);
  });

  test('rejects backgrounds that are not opaque 72 by 72 PNGs',async()=>{
    await expect(composeButton({appearance:{contentMode:'hidden'},background:await png('#000000',71,72),assets:reader({})})).rejects.toThrow('72×72');
  });
});
