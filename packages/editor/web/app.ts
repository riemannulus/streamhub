import type {ButtonDefinition,TransitionSpec} from '../../studio/document';
import {StudioModel} from './model';

const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>$<HTMLInputElement>(id),select=(id:string)=>$<HTMLSelectElement>(id);
type Bootstrap={token:string;snapshot:{document:any;version:string};draft?:any;runtimeStatus:any;geometry:{x:number[];y:number[]}};
let model:StudioModel,token='',version='',geometry:{x:number[];y:number[]},standby=false,draftTimer:ReturnType<typeof setTimeout>;
const page=()=>model.document.pages.find(item=>item.id===model.selectedPageId)!;
const selected=()=>page().buttons?.find(button=>button.index===model.selectedKey);
function error(message=''){$('error').hidden=!message;$('error').textContent=message;}
function assetUrl(id?:string){return id?`/api/assets/${id}`:'';}
function labelOf(button?:ButtonDefinition){return button?.appearance.label?.text??'';}
function typeOf(button?:ButtonDefinition){if(!button)return'empty';if(button.action.type==='open-app')return'app';if(button.action.type==='open-url')return'open';return'text';}
function status(){$('state').textContent=model.dirty?'적용하지 않은 변경':'장치와 동일';$<HTMLButtonElement>('apply').disabled=!model.dirty;}
function draw(){
  const current=page();$('crumb').textContent=standby?'대기 화면':`페이지 / ${current.title}`;$('title').textContent=standby?'잠금 중 표시할 화면':'버튼이 놓일 화면을 만드세요';
  const appearance=standby?model.document.standby:current.appearance;$('canvas').style.backgroundImage=appearance?.background?`url(${assetUrl(appearance.background.assetId)})`:'';$('canvas').style.backgroundColor=appearance?.color??'#000';$('canvas').style.backgroundSize=appearance?.background?.fit==='stretch'?'100% 100%':appearance?.background?.fit??'cover';select('fit').value=appearance?.background?.fit??'cover';
  const canvas=$('canvas');canvas.replaceChildren();
  for(let index=0;index<15;index++){
    const key=document.createElement('button');key.className='key'+(!standby&&index===model.selectedKey?' selected':'');key.style.left=`${geometry.x[index%5]}px`;key.style.top=`${geometry.y[Math.floor(index/5)]}px`;
    const button=!standby?current.buttons?.find(item=>item.index===index):undefined;
    if(button){const visual=document.createElement('span');visual.className='button-visual';visual.style.opacity=button.appearance.contentMode==='hidden'?'0':'1';if(button.appearance.icon)visual.style.backgroundImage=`url(${assetUrl(button.appearance.icon.assetId)})`;visual.textContent=labelOf(button);key.append(visual);}
    const number=document.createElement('small');number.textContent=String(index+1).padStart(2,'0');key.append(number);key.onclick=()=>{if(!standby){model.selectKey(index);draw();}};canvas.append(key);
  }
  const pages=$('pages');pages.replaceChildren(...model.document.pages.map(item=>{const button=document.createElement('button');button.className='page-row'+(!standby&&item.id===model.selectedPageId?' selected':'');button.append(Object.assign(document.createElement('b'),{textContent:'▦'}));const label=document.createElement('span');label.textContent=item.title;label.append(Object.assign(document.createElement('small'),{textContent:item.id}));button.append(label);button.onclick=()=>{standby=false;model.selectPage(item.id);draw();};return button;}));
  $('standby').classList.toggle('selected',standby);$('dynamic').hidden=true;
  const button=selected(),buttonType=typeOf(button);$('key-title').textContent=`버튼 ${model.selectedKey+1}`;$('position').textContent=`${Math.floor(model.selectedKey/5)+1}행 ${model.selectedKey%5+1}열 · 키 ${model.selectedKey+1}`;select('button-type').value=buttonType;input('button-label').value=labelOf(button);input('button-value').value=button?.action.type==='open-app'?button.action.bundleId:button?.action.type==='open-url'?button.action.url:'';input('opacity').value=button?.appearance.contentMode==='hidden'?'0':'100';$('opacity-value').textContent=input('opacity').value+'%';$('button-fields').hidden=!button;$('bundle-label').childNodes[0]!.textContent=buttonType==='open'?'URL':'앱 Bundle ID';
  for(const trigger of ['pageChange','unlock','reconnect'] as const)select(trigger==='pageChange'?'page-motion':trigger+'-motion').value=model.document.motion[trigger].type;status();
}
function changed(){draw();clearTimeout(draftTimer);draftTimer=setTimeout(()=>void fetch('/api/draft',{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':token},body:JSON.stringify({document:model.document})}),350);}
async function upload(file:File){const response=await fetch('/api/assets',{method:'POST',headers:{'X-Streamhub-Editor':token,'Content-Type':file.type||'application/octet-stream'},body:file});const body=await response.json();if(!response.ok)throw new Error(body.error);return body.assetId as string;}
function appearance(label:string,hidden=false):ButtonDefinition['appearance']{return hidden?{contentMode:'hidden'}:{contentMode:'label-only',label:{text:label||'버튼',position:'center',size:'medium',color:'#ffffff'}};}
input('background').onchange=async()=>{const file=input('background').files?.[0];if(!file)return;try{model.setBackground(standby?'standby':'page',await upload(file),select('fit').value as any);changed();}catch(cause){error(String(cause));}};
select('fit').onchange=()=>{const current=standby?model.document.standby:page().appearance;if(current?.background){model.setBackground(standby?'standby':'page',current.background.assetId,select('fit').value as any);changed();}};
select('button-type').onchange=()=>{const type=select('button-type').value;if(type==='empty'){model.removeButton(model.selectedKey);changed();return;}const label=input('button-label').value||'버튼',common={id:selected()?.id??crypto.randomUUID(),index:model.selectedKey,appearance:appearance(label)};const button:ButtonDefinition=type==='app'?{...common,action:{type:'open-app',bundleId:input('button-value').value||'org.mozilla.firefox'}}:type==='open'?{...common,action:{type:'open-url',url:input('button-value').value||'https://example.com/'}}:{...common,action:{type:'none'}};model.setButton(button);changed();};
for(const id of ['button-label','button-value','opacity'])input(id).oninput=()=>{const button=selected();if(!button)return;const clone=structuredClone(button),label=input('button-label').value||'버튼',hidden=Number(input('opacity').value)===0;clone.appearance=appearance(label,hidden);if(clone.action.type==='open-app')clone.action.bundleId=input('button-value').value;if(clone.action.type==='open-url')clone.action.url=input('button-value').value;try{model.setButton(clone);changed();}catch{}};
input('icon').onchange=async()=>{const button=selected(),file=input('icon').files?.[0];if(!button||!file)return;try{const label=labelOf(button),assetId=await upload(file);model.setButton({...button,appearance:{...button.appearance,contentMode:label?'icon-and-label':'icon-only',icon:{assetId,fit:'contain'},...(label?{label:{text:label,position:'bottom',size:'medium',color:'#ffffff'}}:{})}});changed();}catch(cause){error(String(cause));}};
$('add-page').onclick=()=>{standby=false;model.addPage();changed();};$('standby').onclick=()=>{standby=true;draw();};
for(const [id,trigger,duration] of [['page-motion','pageChange',280],['unlock-motion','unlock',480],['reconnect-motion','reconnect',360]] as const)select(id).onchange=()=>{model.setMotion(trigger,{type:select(id).value as TransitionSpec['type'],durationMs:select(id).value==='none'?0:duration});changed();};
$('undo').onclick=()=>{model.undo();draw();};$('redo').onclick=()=>{model.redo();draw();};
$('apply').onclick=async()=>{try{const response=await fetch('/api/apply',{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':token},body:JSON.stringify({document:model.document,expectedVersion:version})}),body=await response.json();if(!response.ok)throw new Error(body.error);version=body.version;model.markApplied();$('runtime').textContent=body.runtimeStatus?.connected?'Stream Deck 연결됨':'저장됨 · Runtime 오프라인';draw();}catch(cause){error(String(cause));}};
async function load(){const response=await fetch('/api/bootstrap'),data=await response.json() as Bootstrap;token=data.token;version=data.snapshot.version;geometry=data.geometry;model=new StudioModel(data.draft??data.snapshot.document);$('runtime').textContent=data.runtimeStatus?.connected?'Stream Deck 연결됨':data.runtimeStatus?.message??'Runtime 오프라인';draw();}
void load().catch(cause=>error(String(cause)));
