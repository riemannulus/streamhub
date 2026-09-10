import {expect,test} from 'bun:test';
import {AppCatalog,normalizeAppCatalog} from './catalog';

test('app catalog normalizes, sorts and caches bounded public fields',async()=>{
  let reads=0,now=1000;
  const catalog=new AppCatalog(async()=>{reads++;return[
    {name:'Zulu',bundleId:'com.example.zulu',path:'/Applications/Zulu.app'},
    {name:'alpha',bundleId:'com.example.alpha',path:'/Applications/Alpha.app',iconPng:Buffer.from('png').toString('base64')},
  ];},()=>now);
  expect(await catalog.apps()).toEqual([
    {name:'alpha',bundleId:'com.example.alpha',path:'/Applications/Alpha.app',iconPng:'cG5n'},
    {name:'Zulu',bundleId:'com.example.zulu',path:'/Applications/Zulu.app'},
  ]);
  await catalog.apps();expect(reads).toBe(1);now+=30001;await catalog.apps();expect(reads).toBe(2);
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
