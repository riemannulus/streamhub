import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {AppCatalog,normalizeAppCatalog} from './catalog';
import * as catalogModule from './catalog';

test('app catalog normalizes, sorts and caches bounded public fields',async()=>{
  let reads=0,now=1000;
  const catalog=new AppCatalog(async()=>{reads++;return[
    {name:'Zulu',bundleId:'com.example.zulu',path:'/Applications/Zulu.app'},
    {name:'alpha',bundleId:'com.example.alpha',path:'/Applications/Alpha.app',iconPng:Buffer.from('png').toString('base64')},
  ];},()=>now);
  expect(await catalog.apps()).toEqual([
    {id:'bundle:com.example.alpha',name:'alpha',bundleId:'com.example.alpha',path:'/Applications/Alpha.app',iconPng:'cG5n'},
    {id:'bundle:com.example.zulu',name:'Zulu',bundleId:'com.example.zulu',path:'/Applications/Zulu.app'},
  ]);
  await catalog.apps();expect(reads).toBe(1);now+=30001;await catalog.apps();expect(reads).toBe(2);
});

test('macOS app icon provider resolves the catalog item through a replaceable platform converter',async()=>{
  const Provider=(catalogModule as unknown as {MacAppIconProvider?:new(options:{platform:string;convert(path:string):Promise<Uint8Array>})=>{read(app:unknown):Promise<Uint8Array>}}).MacAppIconProvider;
  expect(Provider).toBeDefined();
  if(!Provider)return;
  const root=mkdtempSync(join(tmpdir(),'streamhub-app-icon-')),appPath=join(root,'Firefox.app'),resources=join(appPath,'Contents','Resources');
  mkdirSync(resources,{recursive:true});
  writeFileSync(join(appPath,'Contents','Info.plist'),'<plist><dict><key>CFBundleIconFile</key><string>firefox</string></dict></plist>');
  writeFileSync(join(resources,'firefox.icns'),'icon');
  const png=await sharp({create:{width:16,height:16,channels:4,background:'orange'}}).png().toBuffer(),paths:string[]=[];
  try{
    const provider=new Provider({platform:'darwin',convert:async path=>{paths.push(path);return new Uint8Array(png);}});
    const result=await provider.read({id:'bundle:org.mozilla.firefox',name:'Firefox',bundleId:'org.mozilla.firefox',path:appPath});
    expect(paths).toEqual([realpathSync(join(resources,'firefox.icns'))]);
    expect(await sharp(result).metadata()).toMatchObject({format:'png',width:16,height:16});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('app catalog rejects unsafe, duplicate and oversized discovery output',()=>{
  const valid={name:'App',bundleId:'com.example.app',path:'/Applications/App.app'};
  expect(()=>normalizeAppCatalog([{...valid,secret:'token'}])).toThrow('field');
  expect(()=>normalizeAppCatalog([valid,{...valid,path:'/Applications/Other.app'}])).toThrow('Duplicate');
  expect(()=>normalizeAppCatalog([{...valid,path:'relative/App.app'}])).toThrow('absolute');
  expect(()=>normalizeAppCatalog([{...valid,name:'bad\0name'}])).toThrow('string');
  expect(()=>normalizeAppCatalog([{...valid,iconPng:Buffer.alloc(512*1024+1).toString('base64')}])).toThrow('icon');
  expect(()=>normalizeAppCatalog(Array.from({length:2001},(_,index)=>({...valid,name:String(index),bundleId:`com.example.a${index}`,path:`/Applications/${index}.app`})))).toThrow('2,000');
});
