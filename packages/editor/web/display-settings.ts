import type {DisplayMode} from '../../host/src/config';
import type {StudioDisplayStatus} from '../../host/src/runtime';
import type {StudioState} from './state';

const copy:Record<DisplayMode,{title:string;description:string;note:string}>={
  hid:{title:'직접 연결 (HID)',description:'Streamhub가 Stream Deck 앱을 완전히 종료한 뒤 장치를 직접 제어합니다.',note:'가장 빠르고 부드러운 화면 전환을 제공합니다.'},
  plugin:{title:'Stream Deck 플러그인',description:'Stream Deck 앱의 키와 프로필을 사용합니다. 전환 속도와 프레임에는 앱 API 제한이 적용됩니다.',note:'Stream Deck 앱에서 다른 플러그인과 함께 쓰기 좋습니다.'},
  off:{title:'사용 안 함',description:'Streamhub가 Stream Deck 화면과 키를 제어하지 않습니다.',note:'Runtime의 데이터 수집과 API만 실행합니다.'},
};

export const displayModeCopy=(mode:DisplayMode)=>copy[mode];
export const displayRestartRequired=(status:Pick<StudioDisplayStatus,'configuredMode'|'activeMode'>)=>status.configuredMode!==status.activeMode;
const stateCopy=(status:StudioDisplayStatus)=>status.restartRequired?'Runtime을 다시 시작하면 적용됩니다.':status.state==='ready'?'현재 모드가 실행 중입니다.':status.state==='connecting'?'장치에 연결하는 중입니다.':status.state==='recovering'?'화면을 복구하는 중입니다.':status.state==='off'?'디스플레이가 꺼져 있습니다.':status.message??'선택한 디스플레이를 사용할 수 없습니다.';

export function openDisplaySettings(studio:StudioState,options:{changed():void;error(message:string):void}):void{
  const dialog=document.createElement('dialog');dialog.className='display-dialog';dialog.setAttribute('aria-labelledby','display-settings-title');
  const form=document.createElement('form');form.method='dialog';
  const heading=document.createElement('div');heading.className='display-heading';heading.innerHTML='<div><small>장치 설정</small><h2 id="display-settings-title">Stream Deck 연결 방식</h2></div><button value="cancel" aria-label="닫기">×</button>';form.append(heading);
  const intro=document.createElement('p');intro.className='display-intro';intro.textContent='한 번에 한 방식만 장치를 제어합니다. 모드를 저장해도 현재 Runtime은 그대로 유지됩니다.';form.append(intro);
  const choices=document.createElement('fieldset');choices.className='display-choices';choices.setAttribute('aria-label','연결 방식');let selected=studio.display.configuredMode;
  for(const mode of ['hid','plugin','off'] as const){const details=copy[mode],label=document.createElement('label');label.className='display-choice';const radio=document.createElement('input');radio.type='radio';radio.name='display-mode';radio.value=mode;radio.checked=mode===selected;radio.onchange=()=>{selected=mode;for(const node of choices.querySelectorAll('.display-choice'))node.classList.toggle('selected',(node.querySelector('input') as HTMLInputElement).checked);};const body=document.createElement('span');body.innerHTML=`<b>${details.title}</b><span>${details.description}</span><small>${details.note}</small>`;label.append(radio,body);label.classList.toggle('selected',radio.checked);choices.append(label);}form.append(choices);
  const status=document.createElement('div');status.className=`display-status${studio.display.restartRequired?' pending':''}`;status.textContent=stateCopy(studio.display);form.append(status);
  const actions=document.createElement('div');actions.className='display-actions';actions.innerHTML='<button value="cancel">취소</button><button type="button" class="primary">설정 저장</button>';form.append(actions);dialog.append(form);document.body.append(dialog);
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  (actions.querySelector('.primary') as HTMLButtonElement).onclick=async()=>{const save=actions.querySelector('.primary') as HTMLButtonElement;save.disabled=true;try{await studio.setDisplayMode(selected);options.changed();dialog.close();}catch(error){save.disabled=false;options.error(error instanceof Error?error.message:String(error));}};
  dialog.showModal();
}
