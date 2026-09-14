import {expect,test} from 'bun:test';
import {chmodSync,existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReleaseManifest} from './manifest';
import {installPreview,parseInstallerArguments,resolveInstallerPaths,uninstallPreview} from './install';

type FixtureOptions={installedCommit?:string;packageCommit?:string};

const writePackageCommit=(packageRoot:string,gitCommit:string)=>writeFileSync(join(packageRoot,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit,builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})));
const readInstalledCommit=(installRoot:string)=>JSON.parse(readFileSync(join(installRoot,'manifest.json'),'utf8')).gitCommit;

const fixture=async({installedCommit,packageCommit='a'.repeat(40)}:FixtureOptions={})=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub preview install ')),packageRoot=join(root,'extracted'),applicationRoot=join(root,'Application Support','Streamhub'),binDirectory=join(root,'.local','bin'),dataRoot=join(applicationRoot,'data');
  mkdirSync(join(packageRoot,'bin'),{recursive:true});mkdirSync(join(packageRoot,'app'),{recursive:true});mkdirSync(join(packageRoot,'share'),{recursive:true});
  writeFileSync(join(packageRoot,'bin','streamhub'),'#!/bin/sh\n');writeFileSync(join(packageRoot,'app','cli.js'),'cli');writeFileSync(join(packageRoot,'README.md'),'user');writeFileSync(join(packageRoot,'DEVELOPMENT.md'),'dev');writeFileSync(join(packageRoot,'install.sh'),'install');writeFileSync(join(packageRoot,'uninstall.sh'),'uninstall');writeFileSync(join(packageRoot,'SHA256SUMS'),'hashes');
  writePackageCommit(packageRoot,installedCommit??packageCommit);
  const options={packageRoot,applicationRoot,binDirectory};
  if(installedCommit) await installPreview(options);
  writePackageCommit(packageRoot,packageCommit);
  return{root,packageRoot,applicationRoot,binDirectory,dataRoot,options};
};

test('install is repeatable and never creates or copies user data',async()=>{
  const h=await fixture(),first=await installPreview(h.options),second=await installPreview(h.options),command=join(h.binDirectory,'streamhub');
  expect(second).toEqual(first);expect(realpathSync(command)).toBe(realpathSync(join(first.installRoot,'bin','streamhub')));expect(lstatSync(command).isSymbolicLink()).toBe(true);
  expect(existsSync(join(first.installRoot,'.streamhub'))).toBe(false);expect(existsSync(h.dataRoot)).toBe(false);
});

test('uninstall removes only its marked version and command while preserving data',async()=>{
  const h=await fixture(),installed=await installPreview(h.options);mkdirSync(h.dataRoot,{recursive:true});writeFileSync(join(h.dataRoot,'studio.json'),'keep');
  const result=await uninstallPreview({packageRoot:installed.installRoot,applicationRoot:h.applicationRoot,binDirectory:h.binDirectory});
  expect(result).toEqual({removed:true,dataRoot:h.dataRoot});expect(existsSync(installed.installRoot)).toBe(false);expect(existsSync(join(h.binDirectory,'streamhub'))).toBe(false);expect(readFileSync(join(h.dataRoot,'studio.json'),'utf8')).toBe('keep');
});

test('install refuses unowned, linked, and broad destinations',async()=>{
  const unowned=await fixture(),destination=join(unowned.applicationRoot,'app','0.1.0-preview.1');mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'foreign'),'keep');await expect(installPreview(unowned.options)).rejects.toThrow('owned');expect(readFileSync(join(destination,'foreign'),'utf8')).toBe('keep');
  const linked=await fixture(),outside=join(linked.root,'outside');mkdirSync(outside);mkdirSync(join(linked.applicationRoot,'app'),{recursive:true});symlinkSync(outside,join(linked.applicationRoot,'app','0.1.0-preview.1'));await expect(installPreview(linked.options)).rejects.toThrow('symbolic link');
  const broad=await fixture();for(const applicationRoot of ['/',broad.root])await expect(installPreview({...broad.options,applicationRoot})).rejects.toThrow('install root');
});

test('uninstall refuses foreign command links and unmarked payloads',async()=>{
  const foreign=await fixture(),installed=await installPreview(foreign.options),command=join(foreign.binDirectory,'streamhub'),other=join(foreign.root,'other');writeFileSync(other,'foreign');unlinkSync(command);symlinkSync(other,command);
  await expect(uninstallPreview({packageRoot:installed.installRoot,applicationRoot:foreign.applicationRoot,binDirectory:foreign.binDirectory})).rejects.toThrow('command');expect(existsSync(installed.installRoot)).toBe(true);
  const unmarked=await fixture(),payload=join(unmarked.applicationRoot,'app','0.1.0-preview.1');mkdirSync(payload,{recursive:true});await expect(uninstallPreview({packageRoot:payload,applicationRoot:unmarked.applicationRoot,binDirectory:unmarked.binDirectory})).rejects.toThrow('owned');
});

test('an enabled service is stopped before replacement and restored on the new payload',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),events:string[]=[];
  await installPreview({...h.options,service:{
    prepare:async()=>{events.push('disable-old');return{wasEnabled:true};},
    activate:async(_state,result)=>{expect(existsSync(result.installRoot)).toBe(true);expect(readInstalledCommit(result.installRoot)).toBe('b'.repeat(40));events.push('enable-new');},
    rollback:async()=>{events.push('restore-old');},
  }});
  expect(events).toEqual(['disable-old','enable-new']);
});

test('failed service activation restores the old payload and service state',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),events:string[]=[];
  await expect(installPreview({...h.options,service:{
    prepare:async()=>({wasEnabled:true}),
    activate:async()=>{throw new Error('bootstrap failed');},
    rollback:async()=>{events.push('restore-old');},
  }})).rejects.toThrow('bootstrap failed');
  expect(readInstalledCommit(join(h.applicationRoot,'app','0.1.0-preview.1'))).toBe('a'.repeat(40));
  expect(events).toEqual(['restore-old']);
});

test('uninstall stops the owned service before removing any program path',async()=>{
  const h=await fixture(),events:string[]=[],installed=await installPreview(h.options);
  await uninstallPreview({...h.options,packageRoot:installed.installRoot,beforeRemove:async()=>{expect(existsSync(installed.installRoot)).toBe(true);events.push('disable');}});
  expect(events).toEqual(['disable']);expect(existsSync(installed.installRoot)).toBe(false);
});

test('a fresh install does not invoke a supplied service lifecycle',async()=>{
  const h=await fixture(),events:string[]=[];
  await installPreview({...h.options,service:{
    prepare:async()=>{events.push('prepare');return undefined;},
    activate:async()=>{events.push('activate');},
    rollback:async()=>{events.push('rollback');},
  }});
  expect(events).toEqual([]);
});

test('a fresh install inspects a supplied exact service definition before publishing',async()=>{
  const h=await fixture(),events:string[]=[];
  await expect(installPreview({...h.options,service:{
    inspect:async()=>{events.push('inspect');throw new Error('foreign plist');},
    prepare:async()=>{events.push('prepare');return undefined;},
    activate:async()=>{events.push('activate');},
    rollback:async()=>{events.push('rollback');},
  }})).rejects.toThrow('foreign plist');
  expect(events).toEqual(['inspect']);
  expect(existsSync(join(h.applicationRoot,'app','0.1.0-preview.1'))).toBe(false);
});

test('a foreign service refusal happens before payload mutation',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),installRoot=join(h.applicationRoot,'app','0.1.0-preview.1');
  await expect(installPreview({...h.options,service:{
    prepare:async()=>{throw new Error('foreign plist');},
    activate:async()=>{},
    rollback:async()=>{},
  }})).rejects.toThrow('foreign plist');
  expect(readInstalledCommit(installRoot)).toBe('a'.repeat(40));
});

test('a service disable failure preserves the existing package',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),installRoot=join(h.applicationRoot,'app','0.1.0-preview.1');
  await expect(installPreview({...h.options,service:{
    prepare:async()=>{throw new Error('disable failed');},
    activate:async()=>{},
    rollback:async()=>{},
  }})).rejects.toThrow('disable failed');
  expect(readInstalledCommit(installRoot)).toBe('a'.repeat(40));
});

test('a repeated same-commit install does not restart the service',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'a'.repeat(40)}),events:string[]=[];
  await installPreview({...h.options,service:{
    prepare:async()=>{events.push('prepare');return undefined;},
    activate:async()=>{events.push('activate');},
    rollback:async()=>{events.push('rollback');},
  }});
  expect(events).toEqual([]);
});

test('recovery keeps the activation failure primary and still rolls back after a filesystem recovery failure',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),events:string[]=[],appRoot=join(h.applicationRoot,'app');
  let failure:Error|undefined;
  try{
    try{await installPreview({...h.options,service:{
      prepare:async()=>({wasEnabled:true}),
      activate:async()=>{chmodSync(appRoot,0o500);throw new Error('activation failed');},
      rollback:async()=>{events.push('rollback');},
    }});}catch(error){failure=error as Error;}
  }finally{chmodSync(appRoot,0o700);}
  expect(failure?.message).toContain('activation failed');
  expect(failure?.message).toContain('EACCES');
  expect(failure?.message).not.toContain(h.applicationRoot);
  expect(events).toEqual(['rollback']);
});

test('recovery guards a failed payload inspection and rolls back without a restored root',async()=>{
  const h=await fixture({installedCommit:'a'.repeat(40),packageCommit:'b'.repeat(40)}),installRoot=join(h.applicationRoot,'app','0.1.0-preview.1');
  let failure:Error|undefined,restoredRoot:string|undefined;
  try{await installPreview({...h.options,service:{
    prepare:async()=>({wasEnabled:true}),
    activate:async()=>{unlinkSync(join(installRoot,'.streamhub-preview-install.json'));mkdirSync(join(installRoot,'.streamhub-preview-install.json'));throw new Error('activation failed');},
    rollback:async(_state,context)=>{restoredRoot=context.restoredRoot;},
  }});}catch(error){failure=error as Error;}
  expect(failure?.message).toContain('activation failed');
  expect(failure?.message).toContain('EISDIR');
  expect(failure?.message).not.toContain(h.applicationRoot);
  expect(restoredRoot).toBeUndefined();
});

test('installer arguments allow one absolute smoke prefix only',()=>{
  expect(parseInstallerArguments(['install'])).toEqual({operation:'install'});
  expect(parseInstallerArguments(['uninstall','--prefix','/private/tmp/streamhub-preview'])).toEqual({operation:'uninstall',prefix:'/private/tmp/streamhub-preview'});
  for(const argv of [[],['update'],['install','--prefix','relative'],['install','--prefix'],['install','--bad']])expect(()=>parseInstallerArguments(argv)).toThrow('Usage');
});

test('installed uninstall derives its application and command roots from the invoked package',()=>{
  const home='/Users/example',packageRoot='/private/tmp/preview/Application Support/Streamhub/app/0.1.0-preview.1',commandPath='/private/tmp/preview/bin/streamhub';
  expect(resolveInstallerPaths({arguments:{operation:'uninstall'},packageRoot,home,commandPath,installedPackage:true})).toEqual({applicationRoot:'/private/tmp/preview/Application Support/Streamhub',binDirectory:'/private/tmp/preview/bin'});
  expect(resolveInstallerPaths({arguments:{operation:'install',prefix:'/private/tmp/custom'},packageRoot:'/archive',home,installedPackage:false})).toEqual({applicationRoot:'/private/tmp/custom/Application Support/Streamhub',binDirectory:'/private/tmp/custom/bin'});
  const customPackage='/private/tmp/custom/Application Support/Streamhub/app/0.1.0-preview.1';
  expect(resolveInstallerPaths({arguments:{operation:'uninstall'},packageRoot:customPackage,home,commandPath:'/private/tmp/custom/bin/streamhub',installedPackage:true})).toEqual({applicationRoot:'/private/tmp/custom/Application Support/Streamhub',binDirectory:'/private/tmp/custom/bin'});
});

test('invalid manifests are rejected and a missing owned version is a no-op',async()=>{
  const invalid=await fixture();writeFileSync(join(invalid.packageRoot,'manifest.json'),'{}');await expect(installPreview(invalid.options)).rejects.toThrow('manifest');
  const missing=await fixture(),packageRoot=join(missing.applicationRoot,'app','0.1.0-preview.1');expect(await uninstallPreview({...missing.options,packageRoot})).toEqual({removed:false,dataRoot:missing.dataRoot});
});
