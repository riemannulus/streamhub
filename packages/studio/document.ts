import type {PageDefinition,SignalFilter} from '../streamdeck/pages';

export type AssetPlacement={assetId:string;fit:'cover'|'contain'|'stretch'};
export type StudioAppearance={background?:AssetPlacement;color?:string};
export type ButtonAppearance={color?:string;iconAssetId?:string;opacity?:number};
type ButtonBase={index:number;label?:string;appearance?:ButtonAppearance};
export type StudioButton=ButtonBase&(
  |{type:'text';label:string}|{type:'page';pageId:string}|{type:'auto'}
  |{type:'open';url:string}|{type:'app';bundleId:string}
  |{type:'action';name:string;args:Record<string,string>});
export type DynamicRegion={id:string;keys:number[];signals:SignalFilter;order:'recent'|'urgent-first';overflow:'paginate'|'replace-oldest';empty:'background'|'placeholder'};
export type StudioPage={id:string;title:string;match?:PageDefinition['match'];priority?:number;appearance?:StudioAppearance;buttons?:StudioButton[];dynamicRegions?:DynamicRegion[]};
export type TransitionSpec={type:'none'|'crossfade'|'fade-through-black';durationMs:number};
export type StudioDocument={version:2;device:{kind:'streamdeck-classic-5x3'};defaultPageId:string;pages:StudioPage[];standby:StudioAppearance;motion:{pageChange:TransitionSpec;unlock:TransitionSpec;reconnect:TransitionSpec}};
export type StudioValidationContext={sources?:readonly string[];actions?:Record<string,{args?:Record<string,unknown>}>;assets?:readonly string[]};

const obj=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Expected object');return v as Record<string,unknown>};
const exact=(v:Record<string,unknown>,keys:readonly string[])=>{const key=Object.keys(v).find(k=>!keys.includes(k));if(key)throw new Error(`Unknown field: ${key}`)};
const str=(v:unknown,max=128)=>{if(typeof v!=='string'||!v||v.length>max||/[\0-\x1f\x7f]/.test(v))throw new Error('Invalid string');return v};
const ident=(v:unknown)=>{const s=str(v,64);if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(s))throw new Error('Invalid ID');return s};
const asset=(v:unknown,context:StudioValidationContext)=>{const s=str(v,64);if(!/^[a-f0-9]{64}$/.test(s))throw new Error('Invalid asset ID');if(context.assets&&!context.assets.includes(s))throw new Error(`Unknown asset: ${s}`);return s};
const color=(v:unknown)=>{if(typeof v!=='string'||!/^#[0-9a-f]{6}$/i.test(v))throw new Error('Invalid color');return v};
function appearance(raw:unknown,context:StudioValidationContext):StudioAppearance{
  const v=obj(raw);exact(v,['background','color']);const out:StudioAppearance={};
  if(v.color!==undefined)out.color=color(v.color);
  if(v.background!==undefined){const b=obj(v.background);exact(b,['assetId','fit']);if(!['cover','contain','stretch'].includes(b.fit as string))throw new Error('Invalid asset fit');out.background={assetId:asset(b.assetId,context),fit:b.fit as AssetPlacement['fit']};}
  return out;
}
function filter(raw:unknown,context:StudioValidationContext):SignalFilter{
  const v=obj(raw);exact(v,['source','sources','levels','freshness']);const out:SignalFilter={};
  const source=(x:unknown)=>{const s=ident(x).toLowerCase();if(context.sources&&!context.sources.includes(s))throw new Error(`Unknown source: ${s}`);return s};
  if(v.source!==undefined)out.source=source(v.source);
  if(v.sources!==undefined){if(!Array.isArray(v.sources)||new Set(v.sources).size!==v.sources.length)throw new Error('Invalid sources');out.sources=v.sources.map(source);}
  if(out.source&&out.sources)throw new Error('Use source or sources');
  if(v.levels!==undefined){if(!Array.isArray(v.levels)||v.levels.some(x=>!['info','warn','urgent'].includes(x)))throw new Error('Invalid levels');out.levels=v.levels as SignalFilter['levels'];}
  if(v.freshness!==undefined){if(!Array.isArray(v.freshness)||v.freshness.some(x=>!['fresh','stale'].includes(x)))throw new Error('Invalid freshness');out.freshness=v.freshness as SignalFilter['freshness'];}
  return out;
}
function transition(raw:unknown):TransitionSpec{const v=obj(raw);exact(v,['type','durationMs']);if(!['none','crossfade','fade-through-black'].includes(v.type as string))throw new Error('Invalid transition');if(!Number.isInteger(v.durationMs)||(v.durationMs as number)<0||(v.durationMs as number)>500)throw new Error('Transition duration must be 0–500 ms');return{type:v.type as TransitionSpec['type'],durationMs:v.durationMs as number};}

export function defaultStudioDocument():StudioDocument{return{version:2,device:{kind:'streamdeck-classic-5x3'},defaultPageId:'home',pages:[{id:'home',title:'홈'}],standby:{color:'#000000'},motion:{pageChange:{type:'crossfade',durationMs:280},unlock:{type:'crossfade',durationMs:480},reconnect:{type:'crossfade',durationMs:360}}};}

export function validateStudioDocument(raw:unknown,context:StudioValidationContext={}):StudioDocument{
  const v=obj(raw);exact(v,['version','device','defaultPageId','pages','standby','motion']);if(v.version!==2)throw new Error('StudioDocument version 2 required');
  const device=obj(v.device);exact(device,['kind']);if(device.kind!=='streamdeck-classic-5x3')throw new Error('Unsupported device');
  if(!Array.isArray(v.pages)||v.pages.length<1||v.pages.length>32)throw new Error('Expected 1–32 pages');const ids=new Set<string>();
  const pages:StudioPage[]=v.pages.map(rawPage=>{const p=obj(rawPage);exact(p,['id','title','match','priority','appearance','buttons','dynamicRegions']);const id=ident(p.id);if(ids.has(id))throw new Error('Duplicate page ID');ids.add(id);const page:StudioPage={id,title:str(p.title,80)};
    if(p.priority!==undefined){if(!Number.isInteger(p.priority)||(p.priority as number)<-1000||(p.priority as number)>1000)throw new Error('Invalid priority');page.priority=p.priority as number;}
    if(p.match!==undefined){const m=obj(p.match);exact(m,['appBundleId','windowTitle','displayId']);page.match=structuredClone(m) as PageDefinition['match'];}
    if(p.appearance!==undefined)page.appearance=appearance(p.appearance,context);
    const occupied=new Set<number>();
    if(p.buttons!==undefined){if(!Array.isArray(p.buttons)||p.buttons.length>15)throw new Error('Invalid buttons');page.buttons=p.buttons.map(rawButton=>{const b=obj(rawButton);const type=b.type;if(!['text','page','auto','open','app','action'].includes(type as string))throw new Error('Invalid button type');const extra=type==='page'?['pageId']:type==='open'?['url']:type==='app'?['bundleId']:type==='action'?['name','args']:[];exact(b,['index','type','label','appearance',...extra]);if(!Number.isInteger(b.index)||(b.index as number)<0||(b.index as number)>14||occupied.has(b.index as number))throw new Error('Invalid or duplicate button index');const index=b.index as number;occupied.add(index);const base:ButtonBase={index};if(b.label!==undefined)base.label=str(b.label,80);if(b.appearance!==undefined){const a=obj(b.appearance);exact(a,['color','iconAssetId','opacity']);base.appearance={};if(a.color!==undefined)base.appearance.color=color(a.color);if(a.iconAssetId!==undefined)base.appearance.iconAssetId=asset(a.iconAssetId,context);if(a.opacity!==undefined){if(typeof a.opacity!=='number'||a.opacity<0||a.opacity>1)throw new Error('Invalid opacity');base.appearance.opacity=a.opacity;}}
      if(type==='text')return{...base,type,label:str(b.label,80)};if(type==='page')return{...base,type,pageId:ident(b.pageId)};if(type==='auto')return{...base,type};if(type==='open'){const u=new URL(str(b.url,2048));if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid URL');return{...base,type,url:u.href};}if(type==='app'){const bundleId=str(b.bundleId,255);if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(bundleId))throw new Error('Invalid bundle ID');return{...base,type,bundleId};}
      const args=obj(b.args);if(context.actions&&!context.actions[str(b.name)] )throw new Error(`Unknown action: ${b.name}`);return{...base,type:'action',name:str(b.name),args:Object.fromEntries(Object.entries(args).map(([k,x])=>[str(k),str(x,512)]))};}) as StudioButton[];}
    if(p.dynamicRegions!==undefined){if(!Array.isArray(p.dynamicRegions)||p.dynamicRegions.length>15)throw new Error('Invalid dynamic regions');const regionIds=new Set<string>();page.dynamicRegions=p.dynamicRegions.map(rawRegion=>{const r=obj(rawRegion);exact(r,['id','keys','signals','order','overflow','empty']);const rid=ident(r.id);if(regionIds.has(rid))throw new Error('Duplicate region ID');regionIds.add(rid);if(!Array.isArray(r.keys)||!r.keys.length)throw new Error('Region needs keys');const keys=r.keys.map(k=>{if(!Number.isInteger(k)||(k as number)<0||(k as number)>14||occupied.has(k as number))throw new Error('Overlapping or invalid region key');occupied.add(k as number);return k as number});if(!['recent','urgent-first'].includes(r.order as string)||!['paginate','replace-oldest'].includes(r.overflow as string)||!['background','placeholder'].includes(r.empty as string))throw new Error('Invalid dynamic region');return{id:rid,keys,signals:filter(r.signals,context),order:r.order as DynamicRegion['order'],overflow:r.overflow as DynamicRegion['overflow'],empty:r.empty as DynamicRegion['empty']};});}
    return page;});
  const defaultPageId=ident(v.defaultPageId);if(!ids.has(defaultPageId))throw new Error('Unknown default page');for(const page of pages)for(const button of page.buttons??[])if(button.type==='page'&&!ids.has(button.pageId))throw new Error('Unknown target page');
  const m=obj(v.motion);exact(m,['pageChange','unlock','reconnect']);return{version:2,device:{kind:'streamdeck-classic-5x3'},defaultPageId,pages,standby:appearance(v.standby,context),motion:{pageChange:transition(m.pageChange),unlock:transition(m.unlock),reconnect:transition(m.reconnect)}};
}
