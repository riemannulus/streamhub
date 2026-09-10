import {CONTENT_KEYS,SessionDeck,type DeckKey,type DeckLayout,type DeckPage,type PressIntent,type SessionRecord} from './index';
import type {StudioDocument} from '../studio/document';

export const BUILTIN_ICONS=['terminal','folder','check','alert','play','link'] as const;
export type BuiltinIcon=typeof BUILTIN_ICONS[number];
export type ButtonStyle={color?:string;icon?:BuiltinIcon};
export type PageButton = ButtonStyle & {buttonId?:string} & (
  | {index:number;type:'page';pageId:string;label?:string}
  | {index:number;type:'auto';label?:string}
  | {index:number;type:'previous-page';label?:string}
  | {index:number;type:'next-page';label?:string}
  | {index:number;type:'page-indicator';label?:string}
  | {index:number;type:'text';label:string}
  | {index:number;type:'open';url:string;label?:string}
  | {index:number;type:'app';bundleId:string;label?:string}
  | {index:number;type:'action';name:string;args:Record<string,string>;label?:string});
export type SignalFilter={source?:string;sources?:string[];levels?:SessionRecord['level'][];freshness?:SessionRecord['freshness'][]};
export type SignalRegion={id:string;keys:number[];signals:SignalFilter};
export type PageDefinition = {id:string;title:string;match?:{appBundleId?:string;windowTitle?:{mode:'equals'|'contains';value:string};displayId?:string};priority?:number;signals?:SignalFilter;regions?:SignalRegion[];buttons?:PageButton[]};
export type PageConfig = {defaultPage:string;pages:PageDefinition[];transition?:'none'|'fade';durationMs?:number};
export type PageBoardLayout = {version:1;currentPage:string;manual:boolean;pages:Record<string,DeckLayout>;regions?:Record<string,Record<string,DeckLayout>>};
export type PageContext = {appBundleId:string|null;available:boolean;windowTitle?:string|null;displayId?:string|null};

/** Project Studio v3 onto the proven PageBoard allocator and input state machine. */
export function studioDocumentToPageConfig(document:StudioDocument):PageConfig{
  const project=(button:StudioDocument['pages'][number]['buttons'] extends (infer T)[]|undefined?T:never):PageButton=>{
    const label=button.appearance.label?.text,style=button.appearance.background?.color?{color:button.appearance.background.color}:{};
    const common={buttonId:button.id,index:button.index,...style,...(label?{label}:{})};
    const action=button.action;
    if(action.type==='open-app')return{...common,type:'app',bundleId:action.bundleId};
    if(action.type==='open-url')return{...common,type:'open',url:action.url};
    if(action.type==='registered')return{...common,type:'action',name:action.name,args:action.args};
    if(action.type==='go-to-page')return{...common,type:'page',pageId:action.pageId};
    if(action.type==='previous-page')return{...common,type:'previous-page'};
    if(action.type==='next-page')return{...common,type:'next-page'};
    if(action.type==='page-indicator')return{...common,type:'page-indicator'};
    if(action.type==='resume-auto-page')return{...common,type:'auto'};
    return{index:button.index,type:'text',label:label??' ',...style};
  };
  return validatePageConfig({defaultPage:document.defaultPageId,pages:document.pages.map(page=>({id:page.id,title:page.title,...(page.match?{match:page.match}:{}),...(page.priority!==undefined?{priority:page.priority}:{}),buttons:page.buttons?.map(project)}))});
}

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

function validateFilter(raw:unknown):SignalFilter{
  const input=object(raw);exact(input,['source','sources','levels','freshness']);
  if(input.source!==undefined&&input.sources!==undefined)throw new Error('Use source or sources, not both');
  const source=(value:unknown)=>{const name=text(value,64);if(!/^[a-z0-9][a-z0-9_-]*$/.test(name))throw new Error('Invalid signal source');return name;};
  const filter:SignalFilter={};
  if(input.source!==undefined)filter.source=source(input.source);
  for(const field of ['sources','levels','freshness'] as const)if(input[field]!==undefined){
    const values=input[field];if(!Array.isArray(values)||values.length>64||new Set(values).size!==values.length)throw new Error('Invalid signal filter list');
    if(field==='sources')filter.sources=values.map(source);
    else if(field==='levels'){if(values.some(value=>!['info','warn','urgent'].includes(value)))throw new Error('Invalid level filter');filter.levels=values;}
    else{if(values.some(value=>!['fresh','stale'].includes(value)))throw new Error('Invalid freshness filter');filter.freshness=values;}
  }
  return filter;
}
export function matchesSignal(record:SessionRecord,filter:SignalFilter):boolean{
  return(filter.source===undefined||record.source===filter.source)&&(filter.sources===undefined||filter.sources.includes(record.source))&&(filter.levels===undefined||filter.levels.includes(record.level))&&(filter.freshness===undefined||filter.freshness.includes(record.freshness));
}
export function validatePageSources(board:PageConfig,registered:readonly string[]):void{
  for(const page of board.pages)for(const filter of [page.signals,...(page.regions??[]).map(region=>region.signals)])if(filter){
    for(const source of [filter.source,...(filter.sources??[])])if(source!==undefined&&!registered.includes(source))throw new Error(`Unknown signal source: ${source}`);
  }
}

/** Data-only configuration: no executable expressions or arbitrary actions. */
export function validatePageConfig(raw:unknown):PageConfig{
  const input=object(raw);exact(input,['defaultPage','pages','transition','durationMs']);
  const defaultPage=id(input.defaultPage);
  if(!Array.isArray(input.pages)||input.pages.length<1||input.pages.length>32)throw new Error('Expected 1–32 pages');
  const seen=new Set<string>();
  const pages:PageDefinition[]=input.pages.map(rawPage=>{
    const value=object(rawPage);exact(value,['id','title','match','priority','signals','regions','buttons']);
    const page:PageDefinition={id:id(value.id),title:text(value.title,80)};
    if(seen.has(page.id))throw new Error('Duplicate page ID');seen.add(page.id);
    if(value.priority!==undefined){if(!Number.isInteger(value.priority)||(value.priority as number)<-1000||(value.priority as number)>1000)throw new Error('Invalid rule priority');page.priority=value.priority as number;}
    if(value.match!==undefined){
      const match=object(value.match);exact(match,['appBundleId','windowTitle','displayId']);
      if(!Object.keys(match).length)throw new Error('Expected a page condition');
      page.match={};
      if(match.appBundleId!==undefined){const appBundleId=text(match.appBundleId,255);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(appBundleId))throw new Error('Invalid app bundle ID');page.match.appBundleId=appBundleId;}
      if(match.windowTitle!==undefined){const title=object(match.windowTitle);exact(title,['mode','value']);if(title.mode!=='equals'&&title.mode!=='contains')throw new Error('Invalid title condition');page.match.windowTitle={mode:title.mode,value:text(title.value,512)};}
      if(match.displayId!==undefined)page.match.displayId=text(match.displayId,128);
      if(!Object.keys(page.match).length)throw new Error('Expected a page condition');
    }
    if(value.signals!==undefined)page.signals=validateFilter(value.signals);
    if(value.buttons!==undefined){
      if(!Array.isArray(value.buttons)||value.buttons.length>15)throw new Error('Expected at most 15 buttons');
      const positions=new Set<number>();
      page.buttons=value.buttons.map(rawButton=>{
        const button=object(rawButton);
        if(!['page','auto','previous-page','next-page','page-indicator','text','open','app','action'].includes(button.type as string))throw new Error('Invalid page button type');
        exact(button,['buttonId','index','type','label','color','icon',...(button.type==='page'?['pageId']:button.type==='open'?['url']:button.type==='app'?['bundleId']:button.type==='action'?['name','args']:[])]);
        if(!Number.isInteger(button.index)||(button.index as number)<0||(button.index as number)>14||positions.has(button.index as number))throw new Error('Invalid or duplicate button index');
        const index=button.index as number;positions.add(index);
        const label=button.label===undefined?undefined:text(button.label,80);
        const style:ButtonStyle={};
        if(button.color!==undefined){if(typeof button.color!=='string'||!/^#[0-9a-f]{6}$/i.test(button.color))throw new Error('Invalid button color');style.color=button.color;}
        if(button.icon!==undefined){if(typeof button.icon!=='string'||!BUILTIN_ICONS.includes(button.icon as BuiltinIcon))throw new Error('Invalid builtin icon');style.icon=button.icon as BuiltinIcon;}
        const buttonId=button.buttonId===undefined?undefined:id(button.buttonId);
        const common={index,...style,...(buttonId===undefined?{}:{buttonId}),...(label===undefined?{}:{label})};
        if(button.type==='open'){const url=new URL(text(button.url,2048));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid button URL');return{...common,type:'open',url:url.href};}
        if(button.type==='app'){const bundleId=text(button.bundleId,255);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bundleId))throw new Error('Invalid app bundle ID');return{...common,type:'app',bundleId};}
        if(button.type==='action'){const args=object(button.args);if(Object.keys(args).length>32)throw new Error('Too many action arguments');return{...common,type:'action',name:text(button.name,128),args:Object.fromEntries(Object.entries(args).map(([key,value])=>[text(key,128),text(value,512)]))};}
        if(button.type==='text')return{index,type:'text',label:text(button.label,80),...style,...(buttonId===undefined?{}:{buttonId})};
        if(button.type==='page')return{index,type:'page',pageId:id(button.pageId),...style,...(label===undefined?{}:{label})};
        if(button.type==='previous-page'||button.type==='next-page'||button.type==='page-indicator')return{index,type:button.type,...style,...(label===undefined?{}:{label})};
        return{index,type:'auto',...style,...(label===undefined?{}:{label})};
      });
    }
    const occupied=new Set(page.buttons?.map(button=>button.index));
    if(value.regions!==undefined){
      if(!Array.isArray(value.regions)||value.regions.length>CONTENT_KEYS.length)throw new Error('Invalid signal regions');
      const ids=new Set<string>();
      page.regions=value.regions.map(raw=>{
        const region=object(raw);exact(region,['id','keys','signals']);const name=id(region.id);
        if(ids.has(name))throw new Error('Duplicate region ID');ids.add(name);
        if(!Array.isArray(region.keys)||!region.keys.length)throw new Error('Region needs content keys');
        const keys=region.keys.map(key=>{if(!Number.isInteger(key)||!(CONTENT_KEYS as readonly unknown[]).includes(key)||occupied.has(key as number))throw new Error('Overlapping or invalid region key');occupied.add(key as number);return key as number;});
        return{id:name,keys,signals:validateFilter(region.signals)};
      });
    }
    if(page.signals && CONTENT_KEYS.every(index=>occupied.has(index)))throw new Error('Signals page needs an available content key');
    return page;
  });
  if(!seen.has(defaultPage))throw new Error('Unknown default page');
  for(const page of pages)for(const button of page.buttons??[])if(button.type==='page'&&!seen.has(button.pageId))throw new Error('Unknown button target page');
  const config:PageConfig={defaultPage,pages};
  if(input.transition!==undefined){if(input.transition!=='none'&&input.transition!=='fade')throw new Error('Invalid page transition');config.transition=input.transition;}
  if(input.durationMs!==undefined){if(!Number.isInteger(input.durationMs)||(input.durationMs as number)<1||(input.durationMs as number)>500)throw new Error('Transition duration must be 1–500 ms');config.durationMs=input.durationMs as number;}
  return config;
}

export type PageSelection={target?:string;reason:string;unknown:boolean};
type FixedBinding={pageId:string;buttonId:string;action:PageButton['type']};
/** A known mismatch defeats an unknown field in the same AND rule. */
export function choosePage(config:PageConfig,context:PageContext):PageSelection{
  if(!context.available)return{reason:'문맥 미확인 · 현재 페이지 유지',unknown:true};
  const ranked=config.pages.filter(page=>page.match).map((page,index)=>({page,index})).sort((a,b)=>(b.page.priority??0)-(a.page.priority??0)||a.index-b.index);
  for(const {page} of ranked){
    const match=page.match!,conditions:(boolean|undefined)[]=[];
    if(match.appBundleId!==undefined)conditions.push(context.appBundleId===match.appBundleId);
    if(match.windowTitle!==undefined)conditions.push(context.windowTitle==null?undefined:match.windowTitle.mode==='equals'?context.windowTitle===match.windowTitle.value:context.windowTitle.includes(match.windowTitle.value));
    if(match.displayId!==undefined)conditions.push(context.displayId==null?undefined:context.displayId===match.displayId);
    if(conditions.includes(false))continue;
    if(conditions.includes(undefined))return{reason:`${page.title}: 문맥 미확인 · 현재 페이지 유지`,unknown:true};
    return{target:page.id,reason:`${page.title}: 조건 일치 · 우선순위 ${page.priority??0}`,unknown:false};
  }
  return{target:config.defaultPage,reason:'일치하는 조건 없음 · 기본 페이지',unknown:false};
}

/** Outer pages compose independent SessionDecks; context never changes core state. */
export class PageBoard{
  private readonly config:PageConfig;
  private readonly decks=new Map<string,SessionDeck>();
  private readonly regionDecks=new Map<string,Map<string,SessionDeck>>();
  private readonly globalPages=new Map<string,number>();
  private regionEpoch='';
  private current:string;
  private manual=false;
  private epoch=0;
  private innerEpoch=0;
  private held=new Map<number,{epoch:number;cell:DeckKey;fixed?:FixedBinding}>();
  private blocked=false;
  private candidate:string|undefined;
  private candidateSince=0;
  private now=0;
  private reason='문맥 대기';
  private actionStatus=new Map<string,{status:'running'|'success'|'error';message?:string}>();
  constructor(config:PageConfig,layout?:PageBoardLayout){
    this.config=validatePageConfig(config);
    this.current=this.config.defaultPage;
    if(layout){
      const saved=object(layout);exact(saved,['version','currentPage','manual','pages','regions']);
      if(saved.version!==1||typeof saved.currentPage!=='string'||typeof saved.manual!=='boolean')throw new Error('Invalid saved page layout');
      object(saved.pages);if(saved.regions!==undefined)object(saved.regions);
      if(this.config.pages.some(page=>page.id===layout.currentPage)){this.current=layout.currentPage;this.manual=layout.manual;}
    }
    for(const page of this.config.pages){
      const available=CONTENT_KEYS.filter(index=>!page.buttons?.some(button=>button.index===index)&&!page.regions?.some(region=>region.keys.includes(index)));
      const contentKeys=page.signals?available:CONTENT_KEYS;
      let saved:DeckLayout|undefined;
      if(layout&&Object.hasOwn(layout.pages,page.id)){
        const raw=layout.pages[page.id];object(raw);
        // Old capacity is not persisted. One content key validates every possible
        // previous page range without accepting malformed keys or page numbers.
        saved=new SessionDeck(raw,[CONTENT_KEYS[0]]).exportLayout();
        saved.currentPage=Math.min(saved.currentPage,Math.max(0,Math.ceil(saved.slots.length/contentKeys.length)-1));
      }
      this.decks.set(page.id,new SessionDeck(saved,contentKeys));
      const regions=new Map<string,SessionDeck>();
      for(const region of page.regions??[]){
        let previous:DeckLayout|undefined;
        const layouts=layout?.regions?.[page.id];if(layouts!==undefined)object(layouts);
        if(layouts&&Object.hasOwn(layouts,region.id)){
          previous=new SessionDeck(layouts[region.id],[CONTENT_KEYS[0]]).exportLayout();
          previous.currentPage=Math.min(previous.currentPage,Math.max(0,Math.ceil(previous.slots.length/region.keys.length)-1));
        }
        regions.set(region.id,new SessionDeck(previous,region.keys));
      }
      this.regionDecks.set(page.id,regions);
      this.globalPages.set(page.id,Math.max(saved?.currentPage??0,...[...regions.values()].map(deck=>deck.page().index)));
    }
  }
  private get deck(){return this.decks.get(this.current)!;}
  private get definition(){return this.config.pages.find(page=>page.id===this.current)!;}
  update(records:readonly SessionRecord[]):void{
    for(const page of this.config.pages){
      const assigned=new Set<SessionRecord>();
      for(const region of page.regions??[]){
        const visible=records.filter(record=>!assigned.has(record)&&matchesSignal(record,region.signals));
        visible.forEach(record=>assigned.add(record));this.regionDecks.get(page.id)!.get(region.id)!.update(visible);
      }
      const visible=page.signals===undefined?[]:records.filter(record=>!assigned.has(record)&&matchesSignal(record,page.signals!));
      this.decks.get(page.id)!.update(visible);
    }
  }
  context(context:PageContext,now:number):void{
    if(!Number.isFinite(now))throw new Error('Invalid context timestamp');
    this.now=now;
    const selection=choosePage(this.config,context);this.reason=selection.reason;
    if(selection.target===undefined){this.candidate=undefined;return;}
    const target=selection.target;
    if(target!==this.candidate||now<this.candidateSince){this.candidate=target;this.candidateSince=now;}
    this.route();
  }
  selectionReason():string{return this.manual?'수동 고정':this.candidate!==undefined&&this.candidate!==this.current&&this.now-this.candidateSince<250?`${this.reason} · 전환 대기`:this.reason;}
  private route(){if(!this.manual&&this.candidate!==undefined&&this.now-this.candidateSince>=250)this.select(this.candidate);}
  private select(pageId:string){
    if(pageId===this.current)return;
    for(const deck of this.allDecks())deck.cancelInput();
    this.current=pageId;this.epoch++;this.innerEpoch=this.deck.page().epoch;
    this.blocked=this.held.size>0;
  }
  private allDecks():SessionDeck[]{return[...this.decks.values(),...[...this.regionDecks.values()].flatMap(regions=>[...regions.values()])];}
  private parts():SessionDeck[]{return[this.deck,...this.regionDecks.get(this.current)!.values()];}
  private composedPage():DeckPage{
    if(!this.definition.regions?.length){
      const frame=this.deck.page();
      if(this.definition.signals!==undefined)return frame;
      return{...frame,keys:frame.keys.map((key,index)=>index===10||index===13||index===14?{type:'empty',index}:key)};
    }
    const parts=this.parts(),count=Math.max(...parts.map(deck=>deck.page().pageCount));
    const index=Math.min(this.globalPages.get(this.current)??0,count-1);this.globalPages.set(this.current,index);
    const frames=parts.map(deck=>deck.page(index)),frame=frames[0];
    const epochs=JSON.stringify([this.current,...frames.map(frame=>frame.epoch)]);
    if(epochs!==this.regionEpoch){this.regionEpoch=epochs;this.epoch++;this.blocked=this.held.size>0;}
    for(const [i,region] of this.definition.regions.entries())for(const key of region.keys)frame.keys[key]=frames[i+1].keys[key];
    const urgency=(physical:number)=>frames.reduce((sum,frame)=>{const key=frame.keys[physical];return sum+((key.type==='previous'||key.type==='next')?key.urgentCount:0);},0);
    frame.keys[10]=count>1?{type:'previous',index:10,enabled:index>0,urgentCount:urgency(10)}:{type:'empty',index:10};
    frame.keys[13]={type:'empty',index:13};
    frame.keys[14]=count>1?{type:'next',index:14,enabled:index<count-1,urgentCount:urgency(14)}:{type:'empty',index:14};
    const pins=frames.map(frame=>frame.keys[13]).filter((key):key is Extract<DeckKey,{type:'pin'}>=>key.type==='pin'&&!!key.record);
    if(pins.length)frame.keys[13]={...pins[0],hiddenCount:pins.reduce((sum,key)=>sum+key.hiddenCount+1,0)-1};
    return{...frame,index,pageCount:count};
  }
  private inputDeck(index:number):SessionDeck{
    const region=this.definition.regions?.find(region=>region.keys.includes(index));
    if(region)return this.regionDecks.get(this.current)!.get(region.id)!;
    if(index===13&&this.definition.regions?.length){
      const pin=this.composedPage().keys[13];
      if(pin.type==='pin'&&pin.record)return this.parts().find(deck=>{const key=deck.page().keys[13];return key.type==='pin'&&key.record?.id===pin.record!.id&&key.record?.source===pin.record!.source;})??this.deck;
    }
    return this.deck;
  }
  private navigateRegions(index:number):void{this.globalPages.set(this.current,index);this.composedPage();}
  page():DeckPage{
    const frame=this.composedPage();
    if(frame.epoch!==this.innerEpoch){this.innerEpoch=frame.epoch;this.epoch++;this.blocked=this.held.size>0;}
    for(const button of this.definition.buttons??[]){
      let key:DeckKey;
      if(button.type==='page')key={type:'tile',index:button.index,label:button.label??this.config.pages.find(page=>page.id===button.pageId)!.title,color:'#62a9ff',enabled:true};
      else if(button.type==='auto')key={type:'tile',index:button.index,label:button.label??'자동',foot:this.manual?'수동 고정':'자동 모드',color:'#76c8a1',enabled:true};
      else if(button.type==='previous-page'||button.type==='next-page'){const current=this.config.pages.findIndex(page=>page.id===this.current),target=current+(button.type==='previous-page'?-1:1);key={type:'tile',index:button.index,label:button.label??(button.type==='previous-page'?'이전 페이지':'다음 페이지'),color:'#62a9ff',enabled:target>=0&&target<this.config.pages.length};}
      else if(button.type==='page-indicator')key={type:'tile',index:button.index,label:`${this.config.pages.findIndex(page=>page.id===this.current)+1} / ${this.config.pages.length}`,enabled:false};
      else if(button.type==='text')key={type:'tile',index:button.index,label:button.label,enabled:false};
      else key={type:'tile',index:button.index,label:button.label??(button.type==='open'?new URL(button.url).hostname:button.type==='app'?button.bundleId:button.name),enabled:true,color:'#426087'};
      if(button.color!==undefined)key.color=button.color;
      if(button.icon!==undefined)key.icon=button.icon;
      const status=this.actionStatus.get(JSON.stringify([this.current,button.index]));
      if(status){key.foot=status.message??(status.status==='running'?'실행 중':status.status==='success'?'완료':'실패');key.enabled=status.status!=='running';key.color=status.status==='running'?'#dba52f':status.status==='success'?'#269d91':'#dc3741';}
      frame.keys[button.index]=key;
    }
    return{...frame,epoch:this.epoch,viewId:this.current,transition:{type:this.config.transition??'fade',durationMs:this.config.durationMs??250}};
  }
  down(index:number):void{
    if(!Number.isInteger(index)||index<0||index>=15||this.held.has(index))return;
    const frame=this.page();
    if(this.actionStatus.get(JSON.stringify([this.current,index]))?.status==='running')return;
    const fixed=this.definition.buttons?.find(button=>button.index===index);
    this.held.set(index,{epoch:this.blocked?-1:frame.epoch,cell:frame.keys[index]!,...(fixed?{fixed:{pageId:this.current,buttonId:fixed.buttonId??`${this.current}:${fixed.index}`,action:fixed.type}}:{})});
    if(!this.definition.buttons?.some(button=>button.index===index)&&!(this.definition.regions?.length&&(index===10||index===14)))this.inputDeck(index).down(index);
  }
  up(index:number):PressIntent|undefined{
    const frame=this.page(),binding=this.held.get(index),blocked=this.blocked;
    this.held.delete(index);if(!this.held.size)this.blocked=false;
    if(blocked||!binding||binding.epoch!==frame.epoch||JSON.stringify(binding.cell)!==JSON.stringify(frame.keys[index])){for(const deck of this.parts())deck.cancelInput(index);return;}
    const button=this.definition.buttons?.find(button=>button.index===index);
    if(binding.fixed&&(binding.fixed.pageId!==this.current||binding.fixed.buttonId!==(button?.buttonId??`${this.current}:${index}`)||binding.fixed.action!==button?.type))return;
    if(button){
      if(button.type==='text'||button.type==='page-indicator')return;
      if(button.type==='open'||button.type==='app'||button.type==='action'){
        this.setActionStatus(this.current,index,'running');
        const effect=button.type==='open'?{type:'open' as const,url:button.url}:button.type==='app'?{type:'app' as const,bundleId:button.bundleId}:{type:'action' as const,name:button.name,args:{...button.args}};
        return{type:'button-effect',pageId:this.current,index,effect};
      }
      if(button.type==='page'){this.manual=true;this.select(button.pageId);}
      else if(button.type==='previous-page'||button.type==='next-page'){const current=this.config.pages.findIndex(page=>page.id===this.current),target=current+(button.type==='previous-page'?-1:1);if(target<0||target>=this.config.pages.length)return;this.manual=true;this.select(this.config.pages[target]!.id);}
      else{this.manual=false;this.route();}
      return{type:'navigate',page:this.page().index};
    }
    if(this.definition.regions?.length&&(index===10||index===14)){
      const key=frame.keys[index];if((key.type==='previous'||key.type==='next')&&key.enabled){this.navigateRegions(frame.index+(index===10?-1:1));return{type:'navigate',page:this.page().index};}return;
    }
    const intent=this.inputDeck(index).up(index);
    if(this.definition.regions?.length&&intent?.type==='navigate')this.navigateRegions(intent.page);
    this.page();return intent;
  }
  setActionStatus(pageId:string,index:number,status:'running'|'success'|'error',message?:string):void{
    const button=this.config.pages.find(page=>page.id===pageId)?.buttons?.find(button=>button.index===index);
    if(!button||!['open','app','action'].includes(button.type))throw new Error('Unknown action button');
    if(!['running','success','error'].includes(status))throw new Error('Invalid action status');
    this.actionStatus.set(JSON.stringify([pageId,index]),{status,...(message?{message:message.slice(0,80)}:{})});
  }
  cancelInput(index?:number):void{
    if(index===undefined)this.held.clear();else this.held.delete(index);
    for(const deck of this.allDecks())deck.cancelInput(index);
    if(!this.held.size)this.blocked=false;
  }
  exportLayout():PageBoardLayout{
    return{version:1,currentPage:this.current,manual:this.manual,pages:Object.fromEntries([...this.decks].map(([id,deck])=>[id,deck.exportLayout()])),...(this.config.pages.some(page=>page.regions?.length)?{regions:Object.fromEntries([...this.regionDecks].filter(([,regions])=>regions.size).map(([page,regions])=>[page,Object.fromEntries([...regions].map(([id,deck])=>[id,deck.exportLayout()]))]))}:{})};
  }
}
