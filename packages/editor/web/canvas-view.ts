import {actionsInBehavior,type ButtonAction,type ButtonDefinition,type StudioAppearance} from '../../studio/document';
import type {Geometry} from './state';
import type {StudioModel} from './model';

const assetUrl=(id?:string)=>id?`/api/assets/${id}`:'';
export function applyCanvasBackground(canvas:HTMLElement,appearance?:StudioAppearance):void{
  canvas.style.backgroundImage=appearance?.background?`url(${assetUrl(appearance.background.assetId)})`:'';canvas.style.backgroundColor=appearance?.color??'#05070a';canvas.style.backgroundSize=appearance?.background?.fit==='stretch'?'100% 100%':appearance?.background?.fit??'cover';canvas.style.backgroundPosition='center';
}
function visual(key:HTMLButtonElement,button:ButtonDefinition):void{
  const mode=button.appearance.contentMode;key.classList.add('occupied');if(mode==='hidden')key.classList.add('hidden-action');
  if(mode!=='hidden'){const layer=document.createElement('span');layer.className='button-visual';if(button.appearance.background?.color)layer.style.backgroundColor=button.appearance.background.color;if(button.appearance.background)layer.style.opacity=String(button.appearance.background.opacity);if(button.appearance.icon&&mode!=='label-only'){const image=document.createElement('img');image.src=assetUrl(button.appearance.icon.assetId);image.style.objectFit=button.appearance.icon.fit;layer.append(image);}if(button.appearance.label&&mode!=='icon-only'){const label=document.createElement('b');label.textContent=button.appearance.label.text;label.className=`label-${button.appearance.label.position} size-${button.appearance.label.size}`;label.style.color=button.appearance.label.color;layer.append(label);}key.append(layer);}
  const badge=document.createElement('i'),types=actionsInBehavior(button.behavior).map(action=>action.type);badge.textContent=types.some(type=>['go-to-page','previous-page','next-page','page-indicator','resume-auto-page'].includes(type))?'PAGE':'ACTION';key.append(badge);
}
export function renderCanvas(canvas:HTMLElement,model:StudioModel,geometry:Geometry,options:{standby:boolean;select(index:number):void;drop(type:ButtonAction['type'],index:number):void;moveStart(index:number):void;moveDrop(index:number):void}):void{
  const page=model.document.pages.find(item=>item.id===model.selectedPageId)!;applyCanvasBackground(canvas,options.standby?model.document.standby:page.appearance);canvas.replaceChildren();
  for(let index=0;index<15;index++){
    const key=document.createElement('button');key.className='deck-key'+(!options.standby&&model.selectedKey===index?' selected':'');key.style.left=`${geometry.x[index%5]}px`;key.style.top=`${geometry.y[Math.floor(index/5)]}px`;key.disabled=options.standby;key.onclick=()=>options.select(index);key.ondragover=event=>{event.preventDefault();key.classList.add('drop-target');};key.ondragleave=()=>key.classList.remove('drop-target');key.ondrop=event=>{event.preventDefault();key.classList.remove('drop-target');const type=event.dataTransfer?.getData('application/x-streamhub-action') as ButtonAction['type'];if(type)options.drop(type,index);else if(event.dataTransfer?.getData('application/x-streamhub-button'))options.moveDrop(index);};
    const button=!options.standby?page.buttons?.find(item=>item.index===index):undefined;if(button){key.draggable=true;key.ondragstart=event=>{options.moveStart(index);event.dataTransfer?.setData('application/x-streamhub-button','move');};visual(key,button);}
    const number=document.createElement('small');number.className='key-number';number.textContent=String(index+1).padStart(2,'0');key.append(number);canvas.append(key);
  }
}
