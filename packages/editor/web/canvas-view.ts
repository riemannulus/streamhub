import {actionsInBehavior,type ButtonAction,type ButtonDefinition,type StudioAppearance} from '../../studio/document';
import type {Geometry} from './state';
import type {StudioModel} from './model';
import type {ActionType} from './action-library';

const assetUrl=(id?:string)=>id?`/api/assets/${id}`:'';
export function canvasLayersFor(button:ButtonDefinition):{background?:NonNullable<ButtonDefinition['appearance']['background']>;icon?:NonNullable<ButtonDefinition['appearance']['icon']>;label?:NonNullable<ButtonDefinition['appearance']['label']>} {
  const mode=button.appearance.contentMode;if(mode==='hidden')return{};const result:ReturnType<typeof canvasLayersFor>={};
  if(button.appearance.background)result.background=structuredClone(button.appearance.background);
  if(button.appearance.icon&&mode!=='label-only')result.icon=structuredClone(button.appearance.icon);
  if(button.appearance.label&&mode!=='icon-only')result.label=structuredClone(button.appearance.label);
  return result;
}
export function applyCanvasBackground(canvas:HTMLElement,appearance?:StudioAppearance):void{
  canvas.style.backgroundImage=appearance?.background?`url(${assetUrl(appearance.background.assetId)})`:'';canvas.style.backgroundColor=appearance?.color??'#05070a';canvas.style.backgroundSize=appearance?.background?.fit==='stretch'?'100% 100%':appearance?.background?.fit??'cover';canvas.style.backgroundPosition='center';
}
function visual(key:HTMLButtonElement,button:ButtonDefinition):void{
  const mode=button.appearance.contentMode,layers=canvasLayersFor(button);key.classList.add('occupied');if(mode==='hidden')key.classList.add('hidden-action');
  if(mode!=='hidden'){const layer=document.createElement('span');layer.className='button-visual';layer.style.backgroundColor='transparent';if(layers.background){const background=document.createElement('span');background.style.cssText='position:absolute;inset:0;background-position:center;background-size:cover';if(layers.background.color)background.style.backgroundColor=layers.background.color;if(layers.background.assetId)background.style.backgroundImage=`url(${assetUrl(layers.background.assetId)})`;background.style.opacity=String(layers.background.opacity);layer.append(background);}if(layers.icon){const image=document.createElement('img');image.src=assetUrl(layers.icon.assetId);image.style.objectFit=layers.icon.fit;layer.append(image);}if(layers.label){const label=document.createElement('b');label.textContent=layers.label.text;label.className=`label-${layers.label.position} size-${layers.label.size}`;label.style.color=layers.label.color;layer.append(label);}key.append(layer);}
  const badge=document.createElement('i'),types=actionsInBehavior(button.behavior).map(action=>action.type);badge.textContent=types.some(type=>['go-to-page','previous-page','next-page','page-indicator','resume-auto-page'].includes(type))?'PAGE':'ACTION';key.append(badge);
}
export function renderCanvas(canvas:HTMLElement,model:StudioModel,geometry:Geometry,options:{standby:boolean;select(index:number):void;drop(type:ActionType,index:number):void;moveStart(index:number):void;moveDrop(index:number):void}):void{
  const page=model.document.pages.find(item=>item.id===model.selectedPageId)!;applyCanvasBackground(canvas,options.standby?model.document.standby:page.appearance);canvas.replaceChildren();
  for(let index=0;index<15;index++){
    const key=document.createElement('button');key.className='deck-key'+(!options.standby&&model.selectedKey===index?' selected':'');key.style.left=`${geometry.x[index%5]}px`;key.style.top=`${geometry.y[Math.floor(index/5)]}px`;key.disabled=options.standby;key.onclick=()=>options.select(index);key.ondragover=event=>{event.preventDefault();key.classList.add('drop-target');};key.ondragleave=()=>key.classList.remove('drop-target');key.ondrop=event=>{event.preventDefault();key.classList.remove('drop-target');const type=event.dataTransfer?.getData('application/x-streamhub-action') as ActionType;if(type)options.drop(type,index);else if(event.dataTransfer?.getData('application/x-streamhub-button'))options.moveDrop(index);};
    const button=!options.standby?page.buttons?.find(item=>item.index===index):undefined;if(button){key.draggable=true;key.ondragstart=event=>{options.moveStart(index);event.dataTransfer?.setData('application/x-streamhub-button','move');};visual(key,button);}
    const number=document.createElement('small');number.className='key-number';number.textContent=String(index+1).padStart(2,'0');key.append(number);canvas.append(key);
  }
}
