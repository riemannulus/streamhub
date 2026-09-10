import sharp from 'sharp';
import type {StudioDocument,StudioPage,StudioAppearance} from '../studio/document';
import type {DeckPage} from '../streamdeck';
import {renderKey} from '../streamdeck/render';
import {extractKeyPngs,keyViewport} from './geometry';

export type AssetReader={read(id:string):Promise<Uint8Array>};
export type DeckCanvas={png:Buffer;keys:string[]};
const uri=(bytes:Uint8Array)=>`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
async function base(appearance:StudioAppearance|undefined,assets:AssetReader):Promise<sharp.Sharp>{
  const color=appearance?.color??'#000000';if(!appearance?.background)return sharp({create:{width:480,height:272,channels:4,background:color}});
  const input=await assets.read(appearance.background.assetId),fit=appearance.background.fit==='stretch'?'fill':appearance.background.fit;
  return sharp(input).rotate().resize(480,272,{fit,background:color}).ensureAlpha();
}
export class DeckVisualRenderer{
  async render(document:StudioDocument,page:StudioPage,deckPage:DeckPage,assets:AssetReader):Promise<DeckCanvas>{return this.renderAppearance(page.appearance,deckPage,page,assets);}
  async renderStandby(document:StudioDocument,assets:AssetReader):Promise<DeckCanvas>{const empty:DeckPage={index:0,pageCount:1,epoch:0,keys:Array.from({length:15},(_,index)=>({type:'empty',index}))};return this.renderAppearance(document.standby,empty,undefined,assets);}
  private async renderAppearance(appearance:StudioAppearance|undefined,deckPage:DeckPage,page:StudioPage|undefined,assets:AssetReader):Promise<DeckCanvas>{
    const overlays:sharp.OverlayOptions[]=[];
    for(const key of deckPage.keys){const fixed=page?.buttons?.find(button=>button.index===key.index);if(fixed?.appearance.contentMode==='hidden'||(!fixed&&key.type==='empty'))continue;const opacity=fixed?.appearance.background?.opacity??1;let input:Buffer;if(fixed?.appearance.icon)input=await sharp(await assets.read(fixed.appearance.icon.assetId)).resize(72,72,{fit:fixed.appearance.icon.fit}).png().toBuffer();else input=await sharp(await renderKey(key,deckPage),{raw:{width:72,height:72,channels:3}}).png().toBuffer();if(opacity<1)input=await sharp(input).ensureAlpha().linear([1,1,1,opacity],[0,0,0,0]).png().toBuffer();overlays.push({input,left:keyViewport(key.index).left,top:keyViewport(key.index).top});}
    const canvas=await (await base(appearance,assets)).composite(overlays).png().toBuffer(),keys=await extractKeyPngs(canvas);return{png:canvas,keys:keys.map(uri)};
  }
}
