import {singlePressBehavior,type ButtonAction,type ButtonDefinition} from '../../studio/document';

export type ActionGroup='기본'|'탐색'|'데이터';
export type AdvancedActionType='multi-action'|'toggle-action'|'double-press'|'hold-action';
export type ActionType=ButtonAction['type']|AdvancedActionType|'dynamic-region'|'dynamic-previous'|'dynamic-next'|'dynamic-pin';
export type ActionItem={type:ActionType;label:string;description:string;group:ActionGroup;available:boolean;symbol:string};

export const ACTION_ITEMS:readonly ActionItem[]=[
  {type:'open-app',label:'앱 열기',description:'설치된 앱을 실행합니다',group:'기본',available:true,symbol:'◉'},
  {type:'open-path',label:'파일·폴더',description:'Finder 항목을 엽니다',group:'기본',available:true,symbol:'□'},
  {type:'open-url',label:'웹사이트',description:'안전한 웹 주소를 엽니다',group:'기본',available:true,symbol:'↗'},
  {type:'hotkey',label:'단축키',description:'현재 앱에 키 조합을 보냅니다',group:'기본',available:true,symbol:'⌘'},
  {type:'text',label:'텍스트',description:'현재 앱에 저장된 문구를 입력합니다',group:'기본',available:true,symbol:'T'},
  {type:'media',label:'미디어',description:'재생과 음량을 제어합니다',group:'기본',available:true,symbol:'▶'},
  {type:'registered',label:'등록된 명령',description:'Runtime에 허용된 명령을 실행합니다',group:'기본',available:true,symbol:'›_'},
  {type:'none',label:'표시 전용',description:'누르지 않는 안내 키입니다',group:'기본',available:true,symbol:'◇'},
  {type:'multi-action',label:'여러 동작',description:'선택한 버튼에 순서 동작을 만듭니다',group:'기본',available:true,symbol:'≡'},
  {type:'toggle-action',label:'토글',description:'꺼짐과 켜짐 동작을 나눕니다',group:'기본',available:true,symbol:'⇄'},
  {type:'double-press',label:'두 번 누르기',description:'선택한 버튼에 두 번 분기를 추가합니다',group:'기본',available:true,symbol:'×2'},
  {type:'hold-action',label:'길게 누르기',description:'선택한 버튼에 길게 분기를 추가합니다',group:'기본',available:true,symbol:'↧'},
  {type:'go-to-page',label:'특정 페이지로 이동',description:'고른 페이지를 바로 엽니다',group:'탐색',available:true,symbol:'⌁'},
  {type:'previous-page',label:'이전 페이지',description:'바깥 페이지를 한 칸 이동합니다',group:'탐색',available:true,symbol:'‹'},
  {type:'next-page',label:'다음 페이지',description:'바깥 페이지를 한 칸 이동합니다',group:'탐색',available:true,symbol:'›'},
  {type:'page-indicator',label:'페이지 표시',description:'현재 위치를 1 / 3처럼 표시합니다',group:'탐색',available:true,symbol:'#'},
  {type:'resume-auto-page',label:'자동 페이지 전환 복귀',description:'앱에 맞춘 자동 전환을 다시 켭니다',group:'탐색',available:true,symbol:'A'},
  {type:'dynamic-region',label:'동적 버튼 영역',description:'Runtime 데이터로 여러 키를 채웁니다 · M3',group:'데이터',available:false,symbol:'▦'},
  {type:'dynamic-previous',label:'동적 목록 이전',description:'데이터 목록을 이전으로 넘깁니다 · M3',group:'데이터',available:false,symbol:'⇤'},
  {type:'dynamic-next',label:'동적 목록 다음',description:'데이터 목록을 다음으로 넘깁니다 · M3',group:'데이터',available:false,symbol:'⇥'},
  {type:'dynamic-pin',label:'긴급 항목으로 이동',description:'긴급 데이터가 있는 키로 이동합니다 · M3',group:'데이터',available:false,symbol:'!'},
];

export function filteredActions(query:string):ActionType[]{
  const needle=query.trim().toLocaleLowerCase();
  return ACTION_ITEMS.filter(item=>!needle||`${item.label} ${item.type}`.toLocaleLowerCase().includes(needle)).map(item=>item.type);
}

export function createButtonForAction(type:ButtonAction['type'],index:number,options:{pageId:string;appBundleId?:string;registered?:{name:string;args:string[]}[]}):ButtonDefinition{
  const item=ACTION_ITEMS.find(item=>item.type===type)!;
  let action:ButtonAction;
  if(type==='open-app')action={type,bundleId:options.appBundleId??'com.apple.Finder'};
  else if(type==='open-path')action={type,path:'/Applications'};
  else if(type==='open-url')action={type,url:'https://example.com/'};
  else if(type==='hotkey')action={type,keys:['command','k']};
  else if(type==='text')action={type,text:'',mode:'type'};
  else if(type==='media')action={type,command:'play-pause'};
  else if(type==='registered'){const command=options.registered?.[0];action=command?{type,name:command.name,args:Object.fromEntries(command.args.map(key=>[key,'']))}:{type:'none'};}
  else if(type==='go-to-page')action={type,pageId:options.pageId};
  else action={type} as ButtonAction;
  return{id:crypto.randomUUID(),index,behavior:singlePressBehavior(action),appearance:{contentMode:'label-only',label:{text:item.label,position:'center',size:'medium',color:'#ffffff'},background:{color:'#172538',opacity:.82}}};
}

export function renderActionLibrary(container:HTMLElement,query:string,onChoose:(type:ActionType)=>void):void{
  const visible=new Set(filteredActions(query));container.replaceChildren();
  for(const group of ['기본','탐색','데이터'] as const){
    const items=ACTION_ITEMS.filter(item=>item.group===group&&visible.has(item.type));if(!items.length)continue;
    const section=document.createElement('section'),title=document.createElement('h3');title.textContent=group;section.append(title);
    for(const item of items){const button=document.createElement('button'),advanced=['multi-action','toggle-action','double-press','hold-action'].includes(item.type);button.className='action-item';button.disabled=!item.available;button.draggable=item.available&&!advanced;button.dataset.action=item.type;button.innerHTML=`<span>${item.symbol}</span><b></b><small></small>`;button.querySelector('b')!.textContent=item.label;button.querySelector('small')!.textContent=item.description;button.onclick=()=>item.available&&onChoose(item.type);button.ondragstart=event=>{if(!advanced)event.dataTransfer?.setData('application/x-streamhub-action',item.type);};section.append(button);}container.append(section);
  }
}
