import sharp from 'sharp';
import type {StudioAppearance,StudioDocument,StudioPage} from '../studio/document';
import type {DeckPage} from '../streamdeck';
import {renderKey} from '../streamdeck/render';
import {composeButton} from './button-compositor';
import {extractKeyPngs,keyViewport} from './geometry';

export type AssetReader={read(id:string):Promise<Uint8Array>};
export type DeckCanvas={png:Buffer;keys:string[]};
const uri=(bytes:Uint8Array)=>`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

export async function renderStudioBackground(appearance:StudioAppearance|undefined,assets:AssetReader):Promise<Buffer>{
  const color=appearance?.color??'#000000';
  if(!appearance?.background)return sharp({create:{width:480,height:272,channels:4,background:color}}).png().toBuffer();
  const input=await assets.read(appearance.background.assetId),fit=appearance.background.fit==='stretch'?'fill':appearance.background.fit;
  return sharp(input).rotate().resize(480,272,{fit,background:color}).ensureAlpha().png().toBuffer();
}

export class DeckVisualRenderer{
  async render(document:StudioDocument,page:StudioPage,deckPage:DeckPage,assets:AssetReader,state?:{toggle(pageId:string,buttonId:string):'off'|'on'|undefined}):Promise<DeckCanvas>{return this.renderAppearance(page.appearance,deckPage,page,assets,state);}
  async renderStandby(document:StudioDocument,assets:AssetReader):Promise<DeckCanvas>{const empty:DeckPage={index:0,pageCount:1,epoch:0,keys:Array.from({length:15},(_,index)=>({type:'empty',index}))};return this.renderAppearance(document.standby,empty,undefined,assets);}
  private async renderAppearance(appearance:StudioAppearance|undefined,deckPage:DeckPage,page:StudioPage|undefined,assets:AssetReader,state?:{toggle(pageId:string,buttonId:string):'off'|'on'|undefined}):Promise<DeckCanvas>{
    const background=await renderStudioBackground(appearance,assets),crops=await extractKeyPngs(background),overlays:sharp.OverlayOptions[]=[];
    for(const key of deckPage.keys){
      const fixed=page?.buttons?.find(button=>button.index===key.index);let input:Buffer|undefined;
      if(fixed){const toggle=page&&state?.toggle(page.id,fixed.id),runtime=key.type==='tile'?{label:key.label,...(key.foot?{detail:key.foot}:{}),...(toggle?{toggle}:{})}:toggle?{toggle}:undefined;input=await composeButton({appearance:fixed.appearance,background:crops[key.index]!,assets,...(runtime?{runtime}:{})});}
      else if(key.type!=='empty')input=await sharp(await renderKey(key,deckPage),{raw:{width:72,height:72,channels:3}}).ensureAlpha().png().toBuffer();
      if(input)overlays.push({input,left:keyViewport(key.index).left,top:keyViewport(key.index).top});
    }
    const canvas=await sharp(background).composite(overlays).png().toBuffer(),keys=await extractKeyPngs(canvas);
    return{png:canvas,keys:keys.map(uri)};
  }
}
