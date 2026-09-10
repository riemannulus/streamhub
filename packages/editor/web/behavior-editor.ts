import {validateKeyBehavior,type ActionProgram,type ActionSequence,type ButtonAction,type ButtonDefinition,type KeyBehavior} from '../../studio/document';

export type BehaviorBranch='press'|'doublePress'|'hold';
export type ProgramType=ActionProgram['type'];
const fallback:ButtonAction={type:'media',command:'play-pause'};
const clone=(button:ButtonDefinition)=>structuredClone(button);
const checked=(button:ButtonDefinition)=>{button.behavior=validateKeyBehavior(button.behavior);return button;};
const sequenceOf=(program:ActionProgram):ActionSequence=>program.type==='single'?{mode:'sequential',steps:[{type:'action',action:structuredClone(program.action)}]}:program.type==='sequence'?structuredClone(program.sequence):structuredClone(program.offToOn);
const program=(button:ButtonDefinition,branch:BehaviorBranch)=>button.behavior[branch];
function updateProgram(input:ButtonDefinition,branch:BehaviorBranch,next:ActionProgram|undefined){const button=clone(input);button.behavior[branch]=next;return checked(button);}

export function setBranchEnabled(input:ButtonDefinition,branch:BehaviorBranch,enabled:boolean):ButtonDefinition{
  if(enabled&&program(input,branch))return clone(input);if(!enabled)return updateProgram(input,branch,undefined);
  const source=input.behavior.press??{type:'single' as const,action:fallback};return updateProgram(input,branch,structuredClone(source));
}
export function setProgramType(input:ButtonDefinition,branch:BehaviorBranch,type:ProgramType):ButtonDefinition{
  const current=program(input,branch)??{type:'single' as const,action:fallback},sequence=sequenceOf(current);
  if(type==='single'){const action=sequence.steps.find(step=>step.type==='action')?.action??fallback;return updateProgram(input,branch,{type:'single',action:structuredClone(action)});}
  if(type==='sequence')return updateProgram(input,branch,{type:'sequence',sequence});
  return updateProgram(input,branch,{type:'toggle',initial:'off',offToOn:structuredClone(sequence),onToOff:structuredClone(sequence)});
}
function editSequence(input:ButtonDefinition,branch:BehaviorBranch,mutator:(sequence:ActionSequence)=>void,side:'offToOn'|'onToOff'='offToOn'){
  const button=clone(input),current=program(button,branch);if(!current||current.type==='single')throw new Error('Select multiple or toggle first');const sequence=current.type==='sequence'?current.sequence:current[side];mutator(sequence);return checked(button);
}
export const addActionStep=(input:ButtonDefinition,branch:BehaviorBranch,action:ButtonAction,side:'offToOn'|'onToOff'='offToOn')=>editSequence(input,branch,sequence=>{sequence.steps.push({type:'action',action:structuredClone(action)});},side);
export const addDelayStep=(input:ButtonDefinition,branch:BehaviorBranch,milliseconds:number,side:'offToOn'|'onToOff'='offToOn')=>editSequence(input,branch,sequence=>{sequence.steps.push({type:'delay',milliseconds});},side);
export const removeStep=(input:ButtonDefinition,branch:BehaviorBranch,index:number,side:'offToOn'|'onToOff'='offToOn')=>editSequence(input,branch,sequence=>{if(!Number.isInteger(index)||index<0||index>=sequence.steps.length)throw new Error('Unknown action step');sequence.steps.splice(index,1);},side);
export const moveStep=(input:ButtonDefinition,branch:BehaviorBranch,index:number,offset:-1|1,side:'offToOn'|'onToOff'='offToOn')=>editSequence(input,branch,sequence=>{const target=index+offset;if(!Number.isInteger(index)||index<0||index>=sequence.steps.length||target<0||target>=sequence.steps.length)return;[sequence.steps[index],sequence.steps[target]]=[sequence.steps[target]!,sequence.steps[index]!];},side);
export const setSequenceMode=(input:ButtonDefinition,branch:BehaviorBranch,mode:ActionSequence['mode'],side:'offToOn'|'onToOff'='offToOn')=>editSequence(input,branch,sequence=>{sequence.mode=mode;},side);
export function setThresholds(input:ButtonDefinition,values:{doublePressMs?:number;holdMs?:number}){const button=clone(input);Object.assign(button.behavior,values);return checked(button);}

const branchLabels:Record<BehaviorBranch,string>={press:'누르기',doublePress:'두 번',hold:'길게'};
const selectedBranches=new Map<string,BehaviorBranch>();
export const selectedBranchFor=(buttonId:string)=>selectedBranches.get(buttonId)??'press';
export function setSingleAction(input:ButtonDefinition,branch:BehaviorBranch,action:ButtonAction){return updateProgram(input,branch,{type:'single',action});}
const describeAction=(action:ButtonAction)=>({'open-app':'앱 열기','open-path':'파일·폴더','open-url':'웹사이트','hotkey':'단축키','text':'텍스트','media':'미디어','registered':'등록 명령','go-to-page':'페이지 이동','previous-page':'이전 페이지','next-page':'다음 페이지','page-indicator':'페이지 표시','resume-auto-page':'자동 복귀','none':'표시 전용'}[action.type]);
const describeSequence=(sequence:ActionSequence)=>sequence.steps.map(step=>step.type==='delay'?`${step.milliseconds}ms 기다리기`:describeAction(step.action)).join(' → ');

export function renderBehaviorEditor(container:HTMLElement,button:ButtonDefinition,onChange:(next:ButtonDefinition)=>void,onRefresh:()=>void):void{
  const branch=selectedBranchFor(button.id);selectedBranches.set(button.id,branch);container.replaceChildren();container.className='inspector-section behavior-editor';const title=document.createElement('h3');title.textContent='누르는 방식';container.append(title);
  const tabs=document.createElement('div');tabs.className='behavior-tabs';for(const key of ['press','doublePress','hold'] as const){const tab=document.createElement('button');tab.textContent=branchLabels[key]+(button.behavior[key]?'':' +');tab.classList.toggle('active',key===branch);tab.onclick=()=>{selectedBranches.set(button.id,key);onRefresh();};tabs.append(tab);}container.append(tabs);
  const current=button.behavior[branch];if(!current){const enable=document.createElement('button');enable.textContent=`${branchLabels[branch]} 동작 사용`;enable.onclick=()=>onChange(setBranchEnabled(button,branch,true));container.append(enable);return;}
  if(branch!=='press'){const disable=document.createElement('button');disable.className='subtle';disable.textContent='이 분기 끄기';disable.onclick=()=>onChange(setBranchEnabled(button,branch,false));container.append(disable);}
  const modes=document.createElement('div');modes.className='segments behavior-modes';for(const [type,label] of [['single','한 동작'],['sequence','여러 동작'],['toggle','토글']] as const){const choice=document.createElement('button');choice.textContent=label;choice.classList.toggle('active',current.type===type);choice.onclick=()=>onChange(setProgramType(button,branch,type));modes.append(choice);}container.append(modes);
  if(current.type==='single'){const summary=document.createElement('p');summary.className='behavior-summary';summary.textContent=describeAction(current.action);container.append(summary);}
  if(current.type==='sequence')renderSequence(container,button,branch,current.sequence,onChange);
  if(current.type==='toggle'){
    const keyPreview=document.createElement('div');keyPreview.className='toggle-key-preview';keyPreview.textContent=button.appearance.label?.text??'버튼';const badge=document.createElement('b');badge.textContent='OFF';keyPreview.append(badge);const previews=document.createElement('div');previews.className='toggle-preview';for(const state of ['off','on'] as const){const preview=document.createElement('button');preview.textContent=state==='off'?'꺼짐 미리보기':'켜짐 미리보기';preview.onclick=()=>{container.dataset.togglePreview=state;badge.textContent=state.toUpperCase();for(const item of previews.children)item.classList.toggle('active',item===preview);};previews.append(preview);}container.append(keyPreview,previews);
    for(const [side,label] of [['offToOn','꺼짐 → 켜짐'],['onToOff','켜짐 → 꺼짐']] as const){const heading=document.createElement('h4');heading.textContent=label;container.append(heading);renderSequence(container,button,branch,current[side],onChange,side);}
  }
  const timing=document.createElement('div');timing.className='behavior-timing';const double=document.createElement('input');double.type='number';double.min='150';double.max='750';double.value=String(button.behavior.doublePressMs);double.onchange=()=>onChange(setThresholds(button,{doublePressMs:Number(double.value)}));const hold=document.createElement('input');hold.type='number';hold.min='300';hold.max='2000';hold.value=String(button.behavior.holdMs);hold.onchange=()=>onChange(setThresholds(button,{holdMs:Number(hold.value)}));timing.append(labelled('두 번 간격 (ms)',double),labelled('길게 기준 (ms)',hold));container.append(timing);
}
function labelled(text:string,node:HTMLElement){const label=document.createElement('label');label.append(document.createTextNode(text),node);return label;}
function renderSequence(container:HTMLElement,button:ButtonDefinition,branch:BehaviorBranch,sequence:ActionSequence,onChange:(next:ButtonDefinition)=>void,side:'offToOn'|'onToOff'='offToOn'){
  const mode=document.createElement('select');mode.add(new Option('차례로 실행','sequential'));mode.add(new Option('동시에 실행','parallel'));mode.value=sequence.mode;const hasDelay=sequence.steps.some(step=>step.type==='delay');if(hasDelay&&sequence.mode==='sequential')mode.options[1]!.disabled=true;mode.onchange=()=>onChange(setSequenceMode(button,branch,mode.value as ActionSequence['mode'],side));container.append(labelled('실행 방식',mode));if(hasDelay){const reason=document.createElement('small');reason.textContent='기다리기는 차례로 실행할 때만 사용할 수 있습니다.';container.append(reason);}
  const list=document.createElement('ol');list.className='behavior-steps';sequence.steps.forEach((step,index)=>{const item=document.createElement('li');item.textContent=step.type==='delay'?`${step.milliseconds}ms 기다리기`:describeAction(step.action);for(const [label,offset] of [['↑',-1],['↓',1]] as const){const move=document.createElement('button');move.textContent=label;move.disabled=index+offset<0||index+offset>=sequence.steps.length;move.onclick=()=>onChange(moveStep(button,branch,index,offset,side));item.append(move);}const remove=document.createElement('button');remove.textContent='×';remove.disabled=sequence.steps.length===1;remove.onclick=()=>onChange(removeStep(button,branch,index,side));item.append(remove);list.append(item);});container.append(list);
  const add=document.createElement('button');add.textContent='동작 추가';add.disabled=sequence.steps.length>=16;add.onclick=()=>onChange(addActionStep(button,branch,fallback,side));const delay=document.createElement('button');delay.textContent='기다리기 추가';delay.disabled=sequence.mode==='parallel'||sequence.steps.length>=16;delay.title=sequence.mode==='parallel'?'동시 실행에는 기다리기를 넣을 수 없습니다.':'';delay.onclick=()=>onChange(addDelayStep(button,branch,250,side));container.append(add,delay);
  const navigation=document.createElement('small');navigation.textContent='페이지 이동은 차례 실행의 마지막 동작에만 둘 수 있습니다. 최대 16단계입니다.';container.append(navigation);
}
