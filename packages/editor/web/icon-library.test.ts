import {expect,test} from 'bun:test';
import {IconLibraryModel} from './icon-library';

const pack=(id:string,name:string)=>({id,name,version:'1.0.0',author:'Author',iconCount:1,hasLicense:false});
const icon=(id:string,name:string)=>({id,name,tags:[],animated:false});

test('opens the first pack, searches the selected pack and imports one icon',async()=>{
  const calls:string[]=[];const source={iconPacks:async()=>[pack('a','Alpha'),pack('b','Beta')],iconPackIcons:async(packId:string,query:string)=>{calls.push(`${packId}:${query}`);return[icon('one',query||'All')];},iconPreview:async()=>new Blob(),importIcon:async(packId:string,iconId:string)=>{calls.push(`import:${packId}:${iconId}`);return'asset';}};
  const model=new IconLibraryModel(source);await model.open();expect(model.selectedPackId).toBe('a');expect(model.icons[0]?.name).toBe('All');await model.search('play');expect(model.icons[0]?.name).toBe('play');expect(await model.import('one')).toBe('asset');expect(calls).toEqual(['a:','a:play','import:a:one']);
});

test('ignores a stale search response that finishes after a newer query',async()=>{
  const resolvers=new Map<string,(icons:ReturnType<typeof icon>[])=>void>(),source={iconPacks:async()=>[pack('a','Alpha')],iconPackIcons:async(_packId:string,query:string)=>new Promise<ReturnType<typeof icon>[]>(resolve=>resolvers.set(query,resolve)),iconPreview:async()=>new Blob(),importIcon:async()=>''};
  const model=new IconLibraryModel(source),opening=model.open();await Bun.sleep(0);resolvers.get('')?.([icon('all','All')]);await opening;
  const old=model.search('old'),latest=model.search('latest');await Bun.sleep(0);resolvers.get('latest')?.([icon('latest','Latest')]);await latest;resolvers.get('old')?.([icon('old','Old')]);await old;
  expect(model.icons.map(item=>item.name)).toEqual(['Latest']);
});
