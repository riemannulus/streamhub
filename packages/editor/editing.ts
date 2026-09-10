import {validatePageConfig, type PageConfig, type PageDefinition} from '../streamdeck/pages';
import {CONTENT_KEYS} from '../streamdeck';

export function pageSignalCapacity(page:PageDefinition):{general:number;regional:number;total:number}{
  const fixed=new Set(page.buttons?.map(button=>button.index));
  const regionKeys=new Set(page.regions?.flatMap(region=>region.keys));
  const general=page.signals===undefined?0:CONTENT_KEYS.filter(index=>!fixed.has(index)&&!regionKeys.has(index)).length;
  const regional=regionKeys.size;
  return{general,regional,total:general+regional};
}

/** Draft history intentionally accepts incomplete edits, including temporarily invalid fields. */
export class BoardHistory {
  private entries:PageConfig[]=[];
  private cursor=0;
  constructor(initial:PageConfig){this.reset(initial);}
  reset(board:PageConfig):void{this.entries=[structuredClone(board)];this.cursor=0;}
  push(board:PageConfig):void{
    if(JSON.stringify(this.entries[this.cursor])===JSON.stringify(board))return;
    this.entries.splice(this.cursor+1);
    this.entries.push(structuredClone(board));
    if(this.entries.length>100)this.entries.shift();
    this.cursor=this.entries.length-1;
  }
  get canUndo():boolean{return this.cursor>0;}
  get canRedo():boolean{return this.cursor<this.entries.length-1;}
  undo():PageConfig|undefined{if(!this.canUndo)return;return structuredClone(this.entries[--this.cursor]);}
  redo():PageConfig|undefined{if(!this.canRedo)return;return structuredClone(this.entries[++this.cursor]);}
}
function nextId(board:PageConfig,base:string):string{
  let id=base,index=2;
  while(board.pages.some(page=>page.id===id)){
    const suffix=`-${index++}`;id=base.slice(0,64-suffix.length)+suffix;
  }
  return id;
}
function append(board:PageConfig,page:PageDefinition):{board:PageConfig;selected:string}{
  return{board:validatePageConfig({...board,pages:[...board.pages,page]}),selected:page.id};
}
export function duplicatePage(input:PageConfig,id:string):{board:PageConfig;selected:string}{
  const board=validatePageConfig(input),original=board.pages.find(page=>page.id===id);
  if(!original)throw new Error('Unknown page');
  const selected=nextId(board,`${id.slice(0,59)}-copy`);
  let suffix=' (복사)',number=2;
  let title=original.title.slice(0,80-suffix.length)+suffix;
  while(board.pages.some(page=>page.title===title)){
    suffix=` (복사 ${number++})`;title=original.title.slice(0,80-suffix.length)+suffix;
  }
  const page=structuredClone(original);page.id=selected;page.title=title;
  for(const button of page.buttons??[])if(button.type==='page'&&button.pageId===id)button.pageId=selected;
  return append(board,page);
}
export function movePage(input:PageConfig,id:string,offset:-1|1):PageConfig{
  const board=validatePageConfig(input),index=board.pages.findIndex(page=>page.id===id);
  if(index<0)throw new Error('Unknown page');
  if(offset!==-1&&offset!==1)throw new Error('Invalid page movement');
  const target=index+offset;
  if(target<0||target>=board.pages.length)return board;
  [board.pages[index],board.pages[target]]=[board.pages[target],board.pages[index]];
  return validatePageConfig(board);
}
export function createTemplate(input:PageConfig,kind:'all'|'source'|'tools',source?:string):{board:PageConfig;selected:string}{
  const board=validatePageConfig(input);
  if(!['all','source','tools'].includes(kind))throw new Error('Unknown page template');
  if(kind==='source'&&!source)throw new Error('Select a registered source');
  const page:PageDefinition={id:nextId(board,kind),title:kind==='all'?'전체 세션':kind==='source'?'소스별 세션':'도구',
    buttons:[{index:12,type:'page',pageId:board.defaultPage,label:'홈'},{index:13,type:'auto',label:'자동'}]};
  if(kind==='tools')page.buttons!.unshift({index:0,type:'text',label:'도구 페이지'});
  else page.signals=kind==='source'?{source}:{};
  return append(board,page);
}
