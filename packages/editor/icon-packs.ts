import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {extname,isAbsolute,join,relative,resolve} from 'node:path';

export type IconPackSummary={id:string;name:string;version:string;author:string;description?:string;iconCount:number;hasLicense:boolean};
export type IconPackIcon={id:string;name:string;tags:string[];animated:boolean};
type IconRecord=IconPackIcon&{path:string};
type PackRecord={summary:IconPackSummary;directory:string;icons:IconRecord[]};

const MAX_PACKS=128,MAX_ICONS=10_000,MAX_JSON_BYTES=4*1024*1024,MAX_ICON_BYTES=8*1024*1024;
const ICON_EXTENSIONS=new Set(['.svg','.png','.jpg','.jpeg','.gif','.webp']);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const boundedString=(value:unknown,maximum:number)=>typeof value==='string'&&value.length>0&&value.length<=maximum?value:undefined;
const contained=(parent:string,path:string)=>{const value=relative(parent,path);return value!==''&&!value.startsWith('..')&&!isAbsolute(value);};
const readJson=(path:string)=>{const stat=statSync(path);if(!stat.isFile()||stat.size>MAX_JSON_BYTES)throw new Error('Invalid icon pack metadata');return JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')) as unknown;};

export function defaultIconPackRoots():string[]{
  const application=join(homedir(),'Library','Application Support','com.elgato.StreamDeck');
  return[join(application,'IconPacks'),join(application,'Plugins','com.elgato.keycreator.sdPlugin','static')];
}

export class IconPackCatalog{
  private readonly roots:string[];
  private cache?:PackRecord[];
  constructor(options:{roots?:string[]}={}){this.roots=options.roots??defaultIconPackRoots();}
  private pack(directory:string):PackRecord|undefined{
    try{
      const canonical=realpathSync(directory),manifest=readJson(join(canonical,'manifest.json')) as Record<string,unknown>,rawIcons=readJson(join(canonical,'icons.json'));
      if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||!Array.isArray(rawIcons)||rawIcons.length>MAX_ICONS)return;
      const name=boundedString(manifest.Name,160),version=boundedString(manifest.Version,40),author=boundedString(manifest.Author,160),description=boundedString(manifest.Description,500);
      if(!name||!version||!author)return;
      const iconDirectoryPath=join(canonical,'icons'),iconDirectoryStat=lstatSync(iconDirectoryPath);if(!iconDirectoryStat.isDirectory()||iconDirectoryStat.isSymbolicLink())return;
      const iconsDirectory=realpathSync(iconDirectoryPath);if(!contained(canonical,iconsDirectory))return;const icons:IconRecord[]=[];
      for(const value of rawIcons){
        try{
          if(!value||typeof value!=='object'||Array.isArray(value))continue;const item=value as Record<string,unknown>,path=boundedString(item.path,240),iconName=boundedString(item.name,160);
          if(!path||!iconName||isAbsolute(path)||!Array.isArray(item.tags)||item.tags.length>32)continue;
          const tags=item.tags.every(tag=>boundedString(tag,80))?item.tags as string[]:undefined;if(!tags)continue;
          const candidate=resolve(iconsDirectory,path);if(!contained(iconsDirectory,candidate)||!ICON_EXTENSIONS.has(extname(candidate).toLowerCase()))continue;
          const sourceStat=lstatSync(candidate);if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.size>MAX_ICON_BYTES)continue;
          const canonicalIcon=realpathSync(candidate);if(!contained(iconsDirectory,canonicalIcon))continue;
          const id=digest(path);if(icons.some(icon=>icon.id===id))continue;const extension=extname(candidate).toLowerCase();icons.push({id,name:iconName,tags:[...tags],animated:extension==='.gif'||extension==='.webp',path:canonicalIcon});
        }catch{continue;}
      }
      if(!icons.length)return;
      let hasLicense=false;const license=boundedString(manifest.License,240);if(license&&!isAbsolute(license)){try{const licensePath=realpathSync(resolve(canonical,license));hasLicense=contained(canonical,licensePath)&&statSync(licensePath).isFile();}catch{}}
      return{directory:canonical,icons,summary:{id:digest(canonical),name,version,author,...(description?{description}:{}),iconCount:icons.length,hasLicense}};
    }catch{return;}
  }
  private scan():PackRecord[]{
    if(this.cache)return this.cache;
    const packs:PackRecord[]=[];
    for(const root of this.roots){
      let entries;try{entries=readdirSync(root,{withFileTypes:true});}catch{continue;}
      for(const entry of entries){if(packs.length>=MAX_PACKS)break;if(!entry.isDirectory()||entry.isSymbolicLink()||!entry.name.endsWith('.sdIconPack'))continue;const pack=this.pack(join(root,entry.name));if(pack&&!packs.some(existing=>existing.summary.id===pack.summary.id))packs.push(pack);}
    }
    this.cache=packs.sort((left,right)=>left.summary.name.localeCompare(right.summary.name));return this.cache;
  }
  async packs():Promise<IconPackSummary[]>{return this.scan().map(pack=>structuredClone(pack.summary));}
  async icons(packId:string,query=''):Promise<IconPackIcon[]>{
    const pack=this.scan().find(item=>item.summary.id===packId);if(!pack)throw new Error('Icon pack not found');const normalized=query.trim().toLocaleLowerCase();
    return pack.icons.filter(icon=>!normalized||icon.name.toLocaleLowerCase().includes(normalized)||icon.tags.some(tag=>tag.toLocaleLowerCase().includes(normalized))).slice(0,200).map(({path:_,...icon})=>structuredClone(icon));
  }
  async read(packId:string,iconId:string):Promise<Buffer>{
    const pack=this.scan().find(item=>item.summary.id===packId),icon=pack?.icons.find(item=>item.id===iconId);if(!icon)throw new Error('Icon not found');
    const stat=lstatSync(icon.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_ICON_BYTES)throw new Error('Icon not found');return readFileSync(icon.path);
  }
}
