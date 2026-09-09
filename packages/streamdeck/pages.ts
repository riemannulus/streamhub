import {CONTENT_KEYS,SessionDeck,type DeckKey,type DeckLayout,type DeckPage,type PressIntent,type SessionRecord} from './index';

export type PageButton =
  | {index:number;type:'page';pageId:string;label?:string}
  | {index:number;type:'auto';label?:string}
  | {index:number;type:'text';label:string};
export type PageDefinition = {id:string;title:string;match?:{appBundleId:string};signals?:{source?:string};buttons?:PageButton[]};
export type PageConfig = {defaultPage:string;pages:PageDefinition[];transition?:'none'|'fade';durationMs?:number};
export type PageBoardLayout = {version:1;currentPage:string;manual:boolean;pages:Record<string,DeckLayout>};
export type PageContext = {appBundleId:string|null;available:boolean};

function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected page configuration object');
  return value as Record<string,unknown>;
}
function exact(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unknown page configuration field');}
function text(value:unknown,max:number):string{
  if(typeof value!=='string'||!value.length||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error('Invalid page configuration string');
  return value;
}
function id(value:unknown):string{const result=text(value,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result))throw new Error('Invalid page ID');return result;}

/** Data-only configuration: no executable expressions or arbitrary actions. */
export function validatePageConfig(raw:unknown):PageConfig{
  const input=object(raw);exact(input,['defaultPage','pages','transition','durationMs']);
  const defaultPage=id(input.defaultPage);
  if(!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>32)throw new Error('Expected 1–32 pages');
  const seen=new Set<string>();
  const pages:PageDefinition[]=input.pages.map(rawPage=>{
    const value=object(rawPage);exact(value,['id','title','match','signals','buttons']);
    const page:PageDefinition={id:id(value.id),title:text(value.title,80)};
    if(seen.has(page.id))throw new Error('Duplicate page ID');seen.add(page.id);
    if(value.match!==undefined){
      const match=object(value.match);exact(match,['appBundleId']);
      const appBundleId=text(match.appBundleId,255);
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(appBundleId))throw new Error('Invalid app bundle ID');
      page.match={appBundleId};
    }
    if(value.signals!==undefined){
      const signals=object(value.signals);exact(signals,['source']);page.signals={};
      if(signals.source!==undefined){const source=text(signals.source,64);if(!/^[a-z0-9][a-z0-9_-]*$/.test(source))throw new Error('Invalid signal source');page.signals.source=source;}
    }
    if(value.buttons!==undefined){
      if(!Array.isArray(value.buttons)||value.buttons.length>15)throw new Error('Expected at most 15 buttons');
      const positions=new Set<number>();
      page.buttons=value.buttons.map(rawButton=>{
        const button=object(rawButton);
        if(button.type!=='page'&&button.type!=='auto'&&button.type!=='text')throw new Error('Invalid page button type');
        exact(button,button.type==='page'?['index','type','pageId','label']:['index','type','label']);
        if(!Number.isInteger(button.index)||(button.index as number)<0||(button.index as number)>14||positions.has(button.index as number))throw new Error('Invalid or duplicate button index');
        const index=button.index as number;positions.add(index);
        const label=button.label===undefined?undefined:text(button.label,80);
        if(button.type==='text')return{index,type:'text',label:text(button.label,80)};
        if(button.type==='page')return{index,type:'page',pageId:id(button.pageId),...(label===undefined?{}:{label})};
        return{index,type:'auto',...(label===undefined?{}:{label})};
      });
    }
    if(page.signals && CONTENT_KEYS.every(index=>page.buttons?.some(button=>button.index===index)))throw new Error('Signals page needs an available content key');
    return page;
  });
  if(!seen.has(defaultPage))throw new Error('Unknown default page');
  for(const page of pages)for(const button of page.buttons??[])if(button.type==='page'&&!seen.has(button.pageId))throw new Error('Unknown button target page');
  const config:PageConfig={defaultPage,pages};
  if(input.transition!==undefined){if(input.transition!=='none'&&input.transition!=='fade')throw new Error('Invalid page transition');config.transition=input.transition;}
  if(input.durationMs!==undefined){if(!Number.isInteger(input.durationMs)||(input.durationMs as number)<1||(input.durationMs as number)>500)throw new Error('Transition duration must be 1–500 ms');config.durationMs=input.durationMs as number;}
  return config;
}

/** Outer pages compose independent SessionDecks; context never changes core state. */
export class PageBoard{
  private readonly config:PageConfig;
  private readonly decks=new Map<string,SessionDeck>();
  private current:string;
  private manual=false;
  private epoch=0;
  private innerEpoch=0;
  private held=new Map<number,{epoch:number;cell:DeckKey}>();
  private blocked=false;
  private candidate:string|undefined;
  private candidateSince=0;
  private now=0;
  constructor(config:PageConfig,layout?:PageBoardLayout){
    this.config=validatePageConfig(config);
    this.current=this.config.defaultPage;
    if(layout){
      const saved=object(layout);exact(saved,['version','currentPage','manual','pages']);
      if(saved.version!==1||typeof saved.currentPage!=='string'||typeof saved.manual!=='boolean')throw new Error('Invalid saved page layout');
      object(saved.pages);
      if(this.config.pages.some(page=>page.id===layout.currentPage)){this.current=layout.currentPage;this.manual=layout.manual;}
    }
    for(const page of this.config.pages){
      const contentKeys=page.signals ? CONTENT_KEYS.filter(index=>!page.buttons?.some(button=>button.index===index)) : CONTENT_KEYS;
      let saved:DeckLayout|undefined;
      if(layout&&Object.hasOwn(layout.pages,page.id)){
        const raw=layout.pages[page.id];object(raw);
        // Old capacity is not persisted. One content key validates every possible
        // previous page range without accepting malformed keys or page numbers.
        saved=new SessionDeck(raw,[CONTENT_KEYS[0]]).exportLayout();
        saved.currentPage=Math.min(saved.currentPage,Math.max(0,Math.ceil(saved.slots.length/contentKeys.length)-1));
      }
      this.decks.set(page.id,new SessionDeck(saved,contentKeys));
    }
  }
  private get deck(){return this.decks.get(this.current)!;}
  private get definition(){return this.config.pages.find(page=>page.id===this.current)!;}
  update(records:readonly SessionRecord[]):void{
    for(const page of this.config.pages){
      const visible=page.signals===undefined?[]:records.filter(record=>page.signals!.source===undefined||record.source===page.signals!.source);
      this.decks.get(page.id)!.update(visible);
    }
  }
  context(context:PageContext,now:number):void{
    if(!Number.isFinite(now))throw new Error('Invalid context timestamp');
    this.now=now;
    if(!context.available){this.candidate=undefined;return;}
    const target=this.config.pages.find(page=>page.match?.appBundleId===context.appBundleId)?.id??this.config.defaultPage;
    if(target!==this.candidate||now<this.candidateSince){this.candidate=target;this.candidateSince=now;}
    this.route();
  }
  private route(){if(!this.manual&&this.candidate!==undefined&&this.now-this.candidateSince>=250)this.select(this.candidate);}
  private select(pageId:string){
    if(pageId===this.current)return;
    for(const deck of this.decks.values())deck.cancelInput();
    this.current=pageId;this.epoch++;this.innerEpoch=this.deck.page().epoch;
    this.blocked=this.held.size>0;
  }
  page():DeckPage{
    const frame=this.deck.page();
    if(frame.epoch!==this.innerEpoch){this.innerEpoch=frame.epoch;this.epoch++;this.blocked=this.held.size>0;}
    for(const button of this.definition.buttons??[]){
      let key:DeckKey;
      if(button.type==='page')key={type:'tile',index:button.index,label:button.label??this.config.pages.find(page=>page.id===button.pageId)!.title,color:'#62a9ff',enabled:true};
      else if(button.type==='auto')key={type:'tile',index:button.index,label:button.label??'자동',foot:this.manual?'수동 고정':'자동 모드',color:'#76c8a1',enabled:true};
      else key={type:'tile',index:button.index,label:button.label,enabled:false};
      frame.keys[button.index]=key;
    }
    return{...frame,epoch:this.epoch,viewId:this.current,transition:{type:this.config.transition??'fade',durationMs:this.config.durationMs??250}};
  }
  down(index:number):void{
    if(!Number.isInteger(index)||index<0||index>=15||this.held.has(index))return;
    const frame=this.page();
    this.held.set(index,{epoch:this.blocked?-1:frame.epoch,cell:frame.keys[index]!});
    if(!this.definition.buttons?.some(button=>button.index===index))this.deck.down(index);
  }
  up(index:number):PressIntent|undefined{
    const frame=this.page(),binding=this.held.get(index),blocked=this.blocked;
    this.held.delete(index);if(!this.held.size)this.blocked=false;
    if(blocked||!binding||binding.epoch!==frame.epoch||JSON.stringify(binding.cell)!==JSON.stringify(frame.keys[index])){this.deck.cancelInput(index);return;}
    const button=this.definition.buttons?.find(button=>button.index===index);
    if(button){
      if(button.type==='text')return;
      if(button.type==='page'){this.manual=true;this.select(button.pageId);}
      else{this.manual=false;this.route();}
      return{type:'navigate',page:this.page().index};
    }
    const intent=this.deck.up(index);this.page();return intent;
  }
  cancelInput(index?:number):void{
    if(index===undefined)this.held.clear();else this.held.delete(index);
    for(const deck of this.decks.values())deck.cancelInput(index);
    if(!this.held.size)this.blocked=false;
  }
  exportLayout():PageBoardLayout{
    return{version:1,currentPage:this.current,manual:this.manual,pages:Object.fromEntries([...this.decks].map(([id,deck])=>[id,deck.exportLayout()]))};
  }
}
