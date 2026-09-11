import type {IconPackIcon,IconPackSummary} from '../icon-packs';

type IconSource={iconPacks():Promise<IconPackSummary[]>;iconPackIcons(packId:string,query?:string):Promise<IconPackIcon[]>;iconPreview(packId:string,iconId:string):Promise<Blob>;importIcon(packId:string,iconId:string):Promise<string>};

export class IconLibraryModel{
  packs:IconPackSummary[]=[];icons:IconPackIcon[]=[];selectedPackId?:string;
  private revision=0;
  constructor(private readonly source:IconSource){}
  async open():Promise<void>{this.packs=await this.source.iconPacks();this.selectedPackId=this.packs[0]?.id;this.icons=[];if(this.selectedPackId)await this.search('');}
  async select(packId:string):Promise<void>{if(!this.packs.some(pack=>pack.id===packId))throw new Error('아이콘팩을 찾지 못했습니다.');this.selectedPackId=packId;this.icons=[];await this.search('');}
  async search(query:string):Promise<void>{const packId=this.selectedPackId;if(!packId){this.icons=[];return;}const revision=++this.revision,icons=await this.source.iconPackIcons(packId,query.trim().slice(0,80));if(revision===this.revision&&packId===this.selectedPackId)this.icons=icons;}
  preview(iconId:string):Promise<Blob>{if(!this.selectedPackId)throw new Error('아이콘팩을 선택하세요.');return this.source.iconPreview(this.selectedPackId,iconId);}
  import(iconId:string):Promise<string>{if(!this.selectedPackId)throw new Error('아이콘팩을 선택하세요.');return this.source.importIcon(this.selectedPackId,iconId);}
}

const node=<K extends keyof HTMLElementTagNameMap>(tag:K,className?:string)=>{const element=document.createElement(tag);if(className)element.className=className;return element;};

export async function chooseIconFromLibrary(source:IconSource):Promise<string|undefined>{
  const model=new IconLibraryModel(source),dialog=node('dialog','icon-library'),shell=node('div','icon-library-shell'),header=node('header'),title=node('div'),close=node('button'),body=node('div','icon-library-body'),sidebar=node('aside'),main=node('section'),search=node('input'),status=node('small'),grid=node('div','icon-grid'),empty=node('div','icon-library-empty');
  title.append(Object.assign(node('b'),{textContent:'아이콘 라이브러리'}),Object.assign(node('small'),{textContent:'설치된 Stream Deck 아이콘팩'}));close.type='button';close.textContent='×';close.title='닫기';header.append(title,close);search.type='search';search.placeholder='이름이나 태그 검색';main.append(search,status,grid,empty);body.append(sidebar,main);shell.append(header,body);dialog.append(shell);document.body.append(dialog);
  let settled=false,renderRevision=0,searchTimer:number|undefined,resolveChoice:(value?:string)=>void=()=>{};const objectUrls=new Set<string>(),choice=new Promise<string|undefined>(resolve=>{resolveChoice=resolve;}),finish=(value?:string)=>{if(settled)return;settled=true;if(searchTimer!==undefined)clearTimeout(searchTimer);for(const url of objectUrls)URL.revokeObjectURL(url);dialog.close();dialog.remove();resolveChoice(value);};
  close.onclick=()=>finish();dialog.oncancel=event=>{event.preventDefault();finish();};
  const renderPacks=()=>{sidebar.replaceChildren();if(!model.packs.length){const message=node('p');message.textContent='설치된 아이콘팩이 없습니다. Stream Deck 앱에서 팩을 설치한 뒤 Studio를 다시 여세요.';sidebar.append(message);return;}for(const pack of model.packs){const button=node('button');button.type='button';button.classList.toggle('active',pack.id===model.selectedPackId);const name=node('b'),meta=node('small');name.textContent=pack.name;meta.textContent=`${pack.iconCount}개 · ${pack.author}`;button.append(name,meta);button.onclick=async()=>{if(pack.id===model.selectedPackId)return;try{search.value='';status.textContent='불러오는 중…';await model.select(pack.id);renderPacks();await renderIcons();}catch(error){status.textContent=error instanceof Error?error.message:String(error);}};sidebar.append(button);}};
  const renderIcons=async()=>{const revision=++renderRevision;for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.clear();grid.replaceChildren();empty.hidden=true;const pack=model.packs.find(item=>item.id===model.selectedPackId);status.textContent=pack?`${pack.name} · ${model.icons.length}${model.icons.length===200?'개 이상':'개'}${pack.hasLicense?' · 라이선스 포함':''}`:'';if(!model.icons.length){empty.hidden=false;empty.textContent=model.packs.length?'일치하는 아이콘이 없습니다.':'Stream Deck 앱에 아이콘팩을 설치하면 여기에 표시됩니다.';return;}
    const cards=model.icons.map(icon=>{const button=node('button');button.type='button';button.title=icon.name;const frame=node('span'),image=node('img'),label=node('b');image.alt='';label.textContent=icon.name;frame.append(image);if(icon.animated){const badge=node('i');badge.textContent='첫 프레임';frame.append(badge);}button.append(frame,label);button.onclick=async()=>{button.disabled=true;try{finish(await model.import(icon.id));}catch(error){button.disabled=false;status.textContent=error instanceof Error?error.message:String(error);}};grid.append(button);return{icon,image};});
    let cursor=0;await Promise.all(Array.from({length:Math.min(6,cards.length)},async()=>{for(;;){const current=cards[cursor++];if(!current||revision!==renderRevision||settled)return;try{const url=URL.createObjectURL(await model.preview(current.icon.id));if(revision!==renderRevision||settled){URL.revokeObjectURL(url);return;}objectUrls.add(url);current.image.src=url;}catch{current.image.alt='미리보기 실패';}}}));
  };
  search.oninput=()=>{if(searchTimer!==undefined)clearTimeout(searchTimer);searchTimer=window.setTimeout(async()=>{try{status.textContent='검색 중…';await model.search(search.value);await renderIcons();}catch(error){status.textContent=error instanceof Error?error.message:String(error);}},180);};
  dialog.showModal();try{await model.open();renderPacks();await renderIcons();}catch(error){empty.hidden=false;empty.textContent=error instanceof Error?error.message:String(error);}return choice;
}
