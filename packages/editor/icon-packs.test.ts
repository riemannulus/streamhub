import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {IconPackCatalog} from './icon-packs';

const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const temporary=()=>{const root=mkdtempSync(join(tmpdir(),'streamhub-icon-packs-'));roots.push(root);return root;};

async function createPack(root:string,name='Example Pack'){
  const directory=join(root,'com.example.icons.sdIconPack'),icons=join(directory,'icons');mkdirSync(icons,{recursive:true});
  writeFileSync(join(directory,'manifest.json'),JSON.stringify({Name:name,Version:'1.2.3',Author:'Example Author',Description:'테스트 팩',Icon:'icon.png',License:'license.txt'}));
  writeFileSync(join(directory,'license.txt'),'Example license');
  writeFileSync(join(directory,'icon.png'),await sharp({create:{width:56,height:56,channels:4,background:'blue'}}).png().toBuffer());
  writeFileSync(join(icons,'play.png'),await sharp({create:{width:144,height:144,channels:4,background:'green'}}).png().toBuffer());
  writeFileSync(join(icons,'stop.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="red"/></svg>');
  writeFileSync(join(directory,'icons.json'),'\ufeff'+JSON.stringify([
    {path:'play.png',name:'Play',tags:['media','재생']},
    {path:'stop.svg',name:'Stop',tags:['media','정지']},
    {path:'../license.txt',name:'Escape',tags:[]},
    {path:'missing.png',name:'Missing',tags:[]},
  ]));
  return directory;
}

test('discovers valid packs without exposing local paths and searches names and tags',async()=>{
  const root=temporary();await createPack(root);const catalog=new IconPackCatalog({roots:[root]});
  const packs=await catalog.packs();expect(packs).toHaveLength(1);expect(packs[0]).toMatchObject({name:'Example Pack',version:'1.2.3',author:'Example Author',description:'테스트 팩',iconCount:2,hasLicense:true});
  expect(packs[0]!.id).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(packs)).not.toContain(root);
  const byName=await catalog.icons(packs[0]!.id,'stop');expect(byName.map(icon=>icon.name)).toEqual(['Stop']);
  const byTag=await catalog.icons(packs[0]!.id,'재생');expect(byTag.map(icon=>icon.name)).toEqual(['Play']);
  expect(JSON.stringify(byTag)).not.toContain(root);
});

test('reads only indexed files contained by the icon directory',async()=>{
  const root=temporary(),outside=join(root,'outside.png'),pack=await createPack(root);writeFileSync(outside,await sharp({create:{width:2,height:2,channels:3,background:'black'}}).png().toBuffer());
  symlinkSync(outside,join(pack,'icons','linked.png'));const raw=JSON.parse(await Bun.file(join(pack,'icons.json')).text());raw.push({path:'linked.png',name:'Linked',tags:[]});writeFileSync(join(pack,'icons.json'),JSON.stringify(raw));
  const catalog=new IconPackCatalog({roots:[root]}),[summary]=await catalog.packs(),icons=await catalog.icons(summary!.id);
  expect(icons.map(icon=>icon.name)).toEqual(['Play','Stop']);
  const bytes=await catalog.read(summary!.id,icons[0]!.id);expect((await sharp(bytes).metadata()).width).toBe(144);
  await expect(catalog.read(summary!.id,'0'.repeat(64))).rejects.toThrow('Icon not found');
});

test('ignores malformed packs and bounds metadata volume',async()=>{
  const root=temporary();await createPack(root,'x'.repeat(300));mkdirSync(join(root,'broken.sdIconPack'));writeFileSync(join(root,'broken.sdIconPack','manifest.json'),'{}');
  expect(await new IconPackCatalog({roots:[root]}).packs()).toEqual([]);
});

test('rejects a pack whose icons directory is a link outside the pack',async()=>{
  const root=temporary(),outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'icon.png'),await sharp({create:{width:2,height:2,channels:3,background:'black'}}).png().toBuffer());
  const pack=join(root,'linked.sdIconPack');mkdirSync(pack);symlinkSync(outside,join(pack,'icons'));writeFileSync(join(pack,'manifest.json'),JSON.stringify({Name:'Linked',Version:'1.0.0',Author:'Example'}));writeFileSync(join(pack,'icons.json'),JSON.stringify([{path:'icon.png',name:'Outside',tags:[]}]))
  expect(await new IconPackCatalog({roots:[root]}).packs()).toEqual([]);
});

test('reuses one validated catalog snapshot while Studio is open',async()=>{
  const root=temporary(),directory=await createPack(root),catalog=new IconPackCatalog({roots:[root]}),[pack]=await catalog.packs();writeFileSync(join(directory,'icons.json'),'broken after discovery');
  expect((await catalog.icons(pack!.id)).map(icon=>icon.name)).toEqual(['Play','Stop']);
});
