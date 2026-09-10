import sharp from 'sharp';
import type {ButtonAppearance} from '../studio/document';
import type {AssetReader} from './render';

export type ComposeButtonInput={
  appearance:ButtonAppearance;
  background:Buffer;
  assets:AssetReader;
  runtime?:{label?:string;detail?:string;badge?:string};
};

const escapeXml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]!));
const bounded=(value:string|undefined,max:number)=>value?.slice(0,max);

async function validateBackground(background:Buffer):Promise<void>{
  const {data,info}=await sharp(background).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  if(info.width!==72||info.height!==72||info.channels!==4)throw new Error('Button background must be a 72×72 image');
  for(let offset=3;offset<data.length;offset+=4)if(data[offset]!==255)throw new Error('Button background must be opaque');
}

async function buttonBackground(appearance:ButtonAppearance,assets:AssetReader):Promise<Buffer|undefined>{
  const definition=appearance.background;if(!definition)return;
  let image=definition.color
    ?sharp({create:{width:72,height:72,channels:4,background:definition.color}})
    :sharp({create:{width:72,height:72,channels:4,background:{r:0,g:0,b:0,alpha:0}}});
  if(definition.assetId){const asset=await sharp(await assets.read(definition.assetId)).rotate().resize(72,72,{fit:'cover'}).ensureAlpha().png().toBuffer();image=image.composite([{input:asset,left:0,top:0}]);}
  return image.ensureAlpha().linear([1,1,1,definition.opacity],[0,0,0,0]).png().toBuffer();
}

async function iconLayer(appearance:ButtonAppearance,assets:AssetReader):Promise<{input:Buffer;left:number;top:number}|undefined>{
  if(!appearance.icon||appearance.contentMode==='label-only'||appearance.contentMode==='hidden')return;
  const size=appearance.contentMode==='icon-and-label'?46:58,top=appearance.contentMode==='icon-and-label'?4:7;
  const input=await sharp(await assets.read(appearance.icon.assetId)).rotate().resize(size,size,{fit:appearance.icon.fit,background:{r:0,g:0,b:0,alpha:0}}).ensureAlpha().png().toBuffer();
  return{input,left:Math.floor((72-size)/2),top};
}

function textLayer(appearance:ButtonAppearance,runtime:ComposeButtonInput['runtime']):Buffer|undefined{
  if(!appearance.label||appearance.contentMode==='icon-only'||appearance.contentMode==='hidden')return;
  const label=escapeXml(bounded(runtime?.label,80)??appearance.label.text),detail=bounded(runtime?.detail,80),sizes={small:11,medium:13,large:16} as const,fontSize=sizes[appearance.label.size];
  const y=appearance.contentMode==='icon-and-label'?65:appearance.label.position==='top'?fontSize+5:appearance.label.position==='center'?39:66;
  const detailMarkup=detail?`<text x="36" y="${Math.min(69,y+11)}" text-anchor="middle" font-size="9" fill="${appearance.label.color}" opacity="0.78">${escapeXml(detail)}</text>`:'';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><text x="36" y="${y}" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="${appearance.label.color}" stroke="#000000" stroke-opacity="0.55" stroke-width="2" paint-order="stroke">${label}</text>${detailMarkup}</svg>`);
}

function badgeLayer(value:string|undefined):Buffer|undefined{
  const badge=bounded(value,4);if(!badge)return;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect x="52" y="3" width="17" height="17" rx="8.5" fill="#38d7c5"/><text x="60.5" y="15.5" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Arial,sans-serif" font-size="10" font-weight="800" fill="#061018">${escapeXml(badge)}</text></svg>`);
}

/** Shared fixed/dynamic key compositor. The input crop is never mutated. */
export async function composeButton(input:ComposeButtonInput):Promise<Buffer>{
  await validateBackground(input.background);
  if(input.appearance.contentMode==='hidden')return Buffer.from(input.background);
  const overlays:sharp.OverlayOptions[]=[];
  const background=await buttonBackground(input.appearance,input.assets);if(background)overlays.push({input:background,left:0,top:0});
  const icon=await iconLayer(input.appearance,input.assets);if(icon)overlays.push(icon);
  const text=textLayer(input.appearance,input.runtime);if(text)overlays.push({input:text,left:0,top:0});
  const badge=badgeLayer(input.runtime?.badge);if(badge)overlays.push({input:badge,left:0,top:0});
  return sharp(input.background).ensureAlpha().composite(overlays).png().toBuffer();
}
