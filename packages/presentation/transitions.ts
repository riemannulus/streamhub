import sharp from 'sharp';import type {TransitionSpec} from '../studio/document';import type {FramePlan} from './playback';import {extractKeyJpegs,extractKeyPngs} from './geometry';
const uri=(b:Uint8Array,mime:'png'|'jpeg')=>`data:image/${mime};base64,${Buffer.from(b).toString('base64')}`;
export class TransitionCompiler{
  constructor(private readonly frameIntervalMs=34){}
  async compile(from:Uint8Array,to:Uint8Array,spec:TransitionSpec,generation:string|number):Promise<FramePlan>{
    const duration=spec.type==='none'?0:Math.min(500,Math.max(0,spec.durationMs)),count=duration===0?1:Math.min(15,Math.max(2,Math.ceil(duration/this.frameIntervalMs)));
    const a=await sharp(from).resize(480,272,{fit:'fill'}).ensureAlpha().raw().toBuffer(),b=await sharp(to).resize(480,272,{fit:'fill'}).ensureAlpha().raw().toBuffer();
    const frames=[];for(let i=1;i<=count;i++){const progress=i/count,rgba=Buffer.alloc(a.length);for(let p=0;p<a.length;p++){let target=b[p]!,start=a[p]!,q=progress;if(spec.type==='fade-through-black'){if(progress<.5){target=0;q=progress*2;}else{start=0;q=(progress-.5)*2;}}rgba[p]=Math.round(start+(target-start)*q);}const canvas=await sharp(rgba,{raw:{width:480,height:272,channels:4}}).png().toBuffer(),final=i===count,mime=final?'png':'jpeg',keys=final?await extractKeyPngs(canvas):await extractKeyJpegs(canvas);frames.push({index:i-1,offsetMs:count===1?0:Math.round(duration*i/count),keys:keys.map(key=>uri(key,mime))});}
    return{generation:String(generation),frames};
  }
}
