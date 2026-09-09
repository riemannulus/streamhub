import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

type Event = { type:string; at:number; index?:number; rgb?:Uint8Array; [key:string]:unknown };
type SavedEvent = Omit<Event,'rgb'> & { asset?:string };
const hash = (bytes:Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Records the transport's actual key writes, including incomplete frames. */
export class ArtifactRecorder {
  private readonly events:SavedEvent[]=[];
  private readonly assets=new Map<string,Buffer>();
  private pixels:(Buffer|null)[]=Array(15).fill(null);
  private standby=false;
  private failure?:Error;
  constructor(readonly directory:string){}
  record(event:Event):void {
    if(this.failure)return;
    if(this.events.length>=50000){this.failure=new Error('Simulation trace exceeded 50,000 events');return;}
    const {rgb,...metadata}=event;
    const saved:SavedEvent={...metadata};
    if(event.type==='key'){
      if(!rgb||rgb.byteLength!==72*72*3||!Number.isInteger(event.index)||event.index!<0||event.index!>14){this.failure=new Error('Invalid simulator RGB event');return;}
      const bytes=Buffer.from(rgb),id=hash(bytes);
      if(!this.assets.has(id)){
        if(this.assets.size>=4096){this.failure=new Error('Simulation trace exceeded 4096 unique key images');return;}
        this.assets.set(id,bytes);
      }
      this.pixels[event.index!]=bytes;this.standby=false;saved.asset=id;
    }else if(event.type==='standby'){
      this.pixels=Array(15).fill(null);this.standby=true;
    }
    this.events.push(saved);
  }
  async screenshot(name:string):Promise<string>{
    if(!/^[a-zA-Z0-9_-]+$/.test(name))throw new Error('Invalid checkpoint name');
    await mkdir(this.directory,{recursive:true});
    const width=5*72+6*8,height=3*72+4*8;
    const composites=await Promise.all(this.pixels.map(async(bytes,index)=>({
      input:await sharp(bytes??Buffer.alloc(72*72*3,this.standby?24:0),{raw:{width:72,height:72,channels:3}}).png().toBuffer(),
      left:8+(index%5)*80,top:8+Math.floor(index/5)*80,
    })));
    const path=join(this.directory,`${name}.png`);
    await sharp({create:{width,height,channels:3,background:'#354151'}}).composite(composites).removeAlpha().png().toFile(path);
    return path;
  }
  async finish(summary:unknown):Promise<void>{
    await mkdir(join(this.directory,'rgb'),{recursive:true});
    await Promise.all([...this.assets].map(([id,bytes])=>writeFile(join(this.directory,'rgb',`${id}.rgb`),bytes)));
    await writeFile(join(this.directory,'trace.jsonl'),this.events.map(event=>JSON.stringify(event)).join('\n')+'\n');
    const data=JSON.stringify({events:this.events,assets:Object.fromEntries([...this.assets].map(([id,bytes])=>[id,bytes.toString('base64')]))}).replace(/</g,'\\u003c');
    await writeFile(join(this.directory,'replay.html'),`<!doctype html><html lang="ko"><meta charset="utf-8"><title>Streamhub simulation replay</title><style>body{background:#111820;color:#e6eef8;font:16px system-ui;max-width:850px;margin:40px auto;padding:16px}canvas{width:min(100%,816px);image-rendering:pixelated}input{width:100%}pre{white-space:pre-wrap}button{padding:8px;margin:8px}</style><h1>시뮬레이션 출력 기록</h1><p>실제 렌더러가 가상 장치에 전송한 키별 픽셀입니다. 대기화면의 회색 키는 대기 명령을 나타내며 실제 장치 로고가 아닙니다.</p><canvas width="408" height="248"></canvas><p id="state"></p><button id="play">재생</button><input id="timeline" aria-label="이벤트 타임라인" type="range" min="0"><pre id="event"></pre><script type="application/json" id="data">${data}</script><script>
const data=JSON.parse(document.getElementById('data').textContent),canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),slider=document.getElementById('timeline');slider.max=Math.max(0,data.events.length-1);let timer;
function show(n){ctx.fillStyle='#354151';ctx.fillRect(0,0,408,248);const slots=Array(15).fill(null);let standby=false;for(let i=0;i<=n;i++){const e=data.events[i];if(e?.type==='standby'){slots.fill(null);standby=true;}if(e?.type==='key'){slots[e.index]=e.asset;standby=false;}}
slots.forEach((id,i)=>{const x=8+(i%5)*80,y=8+Math.floor(i/5)*80;ctx.fillStyle=standby?'#181818':'#000';ctx.fillRect(x,y,72,72);if(id){const rgb=atob(data.assets[id]),rgba=new Uint8ClampedArray(72*72*4);for(let j=0;j<72*72;j++){rgba[j*4]=rgb.charCodeAt(j*3);rgba[j*4+1]=rgb.charCodeAt(j*3+1);rgba[j*4+2]=rgb.charCodeAt(j*3+2);rgba[j*4+3]=255;}ctx.putImageData(new ImageData(rgba,72,72),x,y);}});document.getElementById('state').textContent=standby?'대기 명령 수신':'키별 출력 상태';document.getElementById('event').textContent=JSON.stringify(data.events[n]??{},null,2);slider.value=n;}
function stop(){clearTimeout(timer);timer=undefined;document.getElementById('play').textContent='재생';}function next(){const n=Number(slider.value);if(n>=data.events.length-1){stop();return;}timer=setTimeout(()=>{show(n+1);next();},Math.max(0,data.events[n+1].at-data.events[n].at));}slider.oninput=()=>{stop();show(Number(slider.value));};document.getElementById('play').onclick=()=>{if(timer!==undefined){stop();return;}if(Number(slider.value)>=data.events.length-1)show(0);document.getElementById('play').textContent='일시 정지';next();};show(data.events.length-1);
</script></html>`);
    if(this.failure)throw this.failure;
    await writeFile(join(this.directory,'summary.json'),JSON.stringify({result:summary},null,2)+'\n');
  }
}
