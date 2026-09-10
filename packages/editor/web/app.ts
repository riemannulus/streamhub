import type {ButtonAction,TransitionSpec} from '../../studio/document';
import {createButtonForAction,renderActionLibrary} from './action-library';
import {renderCanvas} from './canvas-view';
import {renderInspector} from './inspector-view';
import {renderPages} from './pages-view';
import {StudioState} from './state';
import {shortcutFor} from './clipboard';

const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const input=(id:string)=>$<HTMLInputElement>(id),select=(id:string)=>$<HTMLSelectElement>(id);
let studio:StudioState,standby=false,query='',dragSource:{pageId:string;index:number}|undefined;
const currentPage=()=>studio.model.document.pages.find(page=>page.id===studio.model.selectedPageId)!;
const showError=(message='')=>{const node=$('error');node.hidden=!message;node.textContent=message;if(message)setTimeout(()=>{if(node.textContent===message)node.hidden=true;},6000);};
const runtimeText=()=>studio.runtimeStatus?.connected?'Stream Deck 연결됨':studio.runtimeStatus?.message??'Runtime 오프라인';

function changed(){studio.changed();render();}
function chooseAction(type:ButtonAction['type'],index=studio.model.selectedKey){
  if(standby)return;
  if(type==='registered'&&!studio.actions.length){showError('등록된 명령이 없습니다. Runtime 설정에서 먼저 명령을 등록하세요.');return;}
  if(currentPage().buttons?.some(button=>button.index===index)&&!confirm('이 키의 기존 버튼을 바꿀까요?'))return;
  try{studio.model.selectKey(index);studio.model.setButton(createButtonForAction(type,index,{pageId:studio.model.selectedPageId,appBundleId:studio.apps[0]?.bundleId,registered:studio.actions}));changed();}catch(error){showError(error instanceof Error?error.message:String(error));}
}
function renderSurfaceTools(){
  const appearance=standby?studio.model.document.standby:currentPage().appearance;$('surface-title').textContent=standby?'대기 화면':currentPage().title;$('surface-description').textContent=standby?'Mac이 잠겼을 때 표시합니다.':'키 전체에 이어지는 배경을 설정합니다.';select('background-fit').value=appearance?.background?.fit??'cover';input('surface-color').value=appearance?.color??'#05070a';
  $('page-settings').hidden=standby;input('page-name').value=currentPage().title;$<HTMLInputElement>('default-page').checked=studio.model.document.defaultPageId===studio.model.selectedPageId;
}
function render(){
  $('runtime').textContent=runtimeText();$('runtime-dot').classList.toggle('offline',!studio.runtimeStatus?.connected);$('state').textContent=studio.model.dirty?'적용하지 않은 변경':'장치와 동일';$('state').classList.toggle('dirty',studio.model.dirty);$<HTMLButtonElement>('apply').disabled=!studio.model.dirty;
  renderPages($('pages'),studio.model,{standby,select:pageId=>{standby=false;studio.model.selectPage(pageId);render();},selectStandby:()=>{standby=true;render();},changed,error:showError});
  renderActionLibrary($('actions'),query,chooseAction);$('action-pane').classList.toggle('disabled',standby);
  renderCanvas($('canvas'),studio.model,studio.geometry,{standby,select:index=>{studio.model.selectKey(index);render();},drop:(type,index)=>chooseAction(type,index),moveStart:index=>{dragSource={pageId:studio.model.selectedPageId,index};},moveDrop:index=>{if(!dragSource)return;try{const occupied=currentPage().buttons?.some(button=>button.index===index),swap=!!occupied&&confirm('두 버튼의 위치를 서로 바꿀까요?');if(occupied&&!swap)return;const moved=studio.model.moveButton(dragSource,{pageId:studio.model.selectedPageId,index},swap);dragSource=undefined;if(moved)changed();else render();}catch(error){showError(String(error));}}});
  if(standby){$('inspector').innerHTML='<div class="inspector-heading"><span>☾</span><div><h2>대기 화면</h2><small>잠금 상태</small></div></div><div class="empty-inspector"><b>전체 화면 설정</b><p>가운데 상단에서 배경 이미지, 색상과 맞춤 방식을 설정하세요.</p></div>';}
  else renderInspector($('inspector'),studio.model,{apps:studio.apps,actions:studio.actions,upload:file=>studio.upload(file),pick:kind=>studio.pick(kind),changed,error:showError});
  renderSurfaceTools();for(const [id,trigger] of [['page-motion','pageChange'],['unlock-motion','unlock'],['reconnect-motion','reconnect']] as const)select(id).value=studio.model.document.motion[trigger].type;
}

input('action-search').oninput=()=>{query=input('action-search').value;render();};
$('add-page').onclick=()=>{try{standby=false;studio.model.addPage();changed();}catch(error){showError(String(error));}};
$('undo').onclick=()=>{if(studio.model.undo())changed();else render();};$('redo').onclick=()=>{if(studio.model.redo())changed();else render();};
$('apply').onclick=async()=>{try{await studio.apply();render();}catch(error){showError(error instanceof Error?error.message:String(error));}};
input('page-name').onchange=()=>{try{studio.model.renamePage(studio.model.selectedPageId,input('page-name').value);changed();}catch(error){showError(String(error));}};
input('default-page').onchange=()=>{if(input('default-page').checked){studio.model.setDefaultPage(studio.model.selectedPageId);changed();}};
input('surface-color').onchange=()=>{studio.model.setSurfaceColor(standby?'standby':'page',input('surface-color').value);changed();};
input('background-file').onchange=async()=>{const file=input('background-file').files?.[0];if(!file)return;try{studio.model.setBackground(standby?'standby':'page',await studio.upload(file),select('background-fit').value as 'cover'|'contain'|'stretch');changed();}catch(error){showError(String(error));}};
select('background-fit').onchange=()=>{const appearance=standby?studio.model.document.standby:currentPage().appearance;if(appearance?.background){studio.model.setBackground(standby?'standby':'page',appearance.background.assetId,select('background-fit').value as 'cover'|'contain'|'stretch');changed();}};
for(const [id,trigger,duration] of [['page-motion','pageChange',280],['unlock-motion','unlock',480],['reconnect-motion','reconnect',360]] as const)select(id).onchange=()=>{studio.model.setMotion(trigger,{type:select(id).value as TransitionSpec['type'],durationMs:select(id).value==='none'?0:duration});changed();};

window.addEventListener('keydown',event=>{if(!studio||standby)return;const command=shortcutFor(event);if(!command)return;event.preventDefault();try{if(command==='copy'){studio.model.copyButton();return;}if(command==='undo'){if(studio.model.undo())changed();return;}if(command==='redo'){if(studio.model.redo())changed();return;}const mutated=command==='paste'?studio.model.pasteButton():command==='duplicate'?studio.model.duplicateButton():studio.model.removeButton();if(mutated)changed();}catch(error){showError(error instanceof Error?error.message:String(error));}});

StudioState.connect().then(state=>{studio=state;render();}).catch(error=>showError(error instanceof Error?error.message:String(error)));
