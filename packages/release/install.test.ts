import {expect,test} from 'bun:test';
import {existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createReleaseManifest} from './manifest';
import {installPreview,parseInstallerArguments,resolveInstallerPaths,uninstallPreview} from './install';

const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'streamhub preview install ')),packageRoot=join(root,'extracted'),applicationRoot=join(root,'Application Support','Streamhub'),binDirectory=join(root,'.local','bin'),dataRoot=join(applicationRoot,'data');mkdirSync(join(packageRoot,'bin'),{recursive:true});mkdirSync(join(packageRoot,'app'),{recursive:true});mkdirSync(join(packageRoot,'share'),{recursive:true});writeFileSync(join(packageRoot,'bin','streamhub'),'#!/bin/sh\n');writeFileSync(join(packageRoot,'app','cli.js'),'cli');writeFileSync(join(packageRoot,'README.md'),'user');writeFileSync(join(packageRoot,'DEVELOPMENT.md'),'dev');writeFileSync(join(packageRoot,'install.sh'),'install');writeFileSync(join(packageRoot,'uninstall.sh'),'uninstall');writeFileSync(join(packageRoot,'SHA256SUMS'),'hashes');writeFileSync(join(packageRoot,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})));return{root,packageRoot,applicationRoot,binDirectory,dataRoot,options:{packageRoot,applicationRoot,binDirectory}};};

test('install is repeatable and never creates or copies user data',async()=>{
  const h=fixture(),first=await installPreview(h.options),second=await installPreview(h.options),command=join(h.binDirectory,'streamhub');
  expect(second).toEqual(first);expect(realpathSync(command)).toBe(realpathSync(join(first.installRoot,'bin','streamhub')));expect(lstatSync(command).isSymbolicLink()).toBe(true);
  expect(existsSync(join(first.installRoot,'.streamhub'))).toBe(false);expect(existsSync(h.dataRoot)).toBe(false);
});

test('uninstall removes only its marked version and command while preserving data',async()=>{
  const h=fixture(),installed=await installPreview(h.options);mkdirSync(h.dataRoot,{recursive:true});writeFileSync(join(h.dataRoot,'studio.json'),'keep');
  const result=await uninstallPreview({packageRoot:installed.installRoot,applicationRoot:h.applicationRoot,binDirectory:h.binDirectory});
  expect(result).toEqual({removed:true,dataRoot:h.dataRoot});expect(existsSync(installed.installRoot)).toBe(false);expect(existsSync(join(h.binDirectory,'streamhub'))).toBe(false);expect(readFileSync(join(h.dataRoot,'studio.json'),'utf8')).toBe('keep');
});

test('install refuses unowned, linked, and broad destinations',async()=>{
  const unowned=fixture(),destination=join(unowned.applicationRoot,'app','0.1.0-preview.1');mkdirSync(destination,{recursive:true});writeFileSync(join(destination,'foreign'),'keep');await expect(installPreview(unowned.options)).rejects.toThrow('owned');expect(readFileSync(join(destination,'foreign'),'utf8')).toBe('keep');
  const linked=fixture(),outside=join(linked.root,'outside');mkdirSync(outside);mkdirSync(join(linked.applicationRoot,'app'),{recursive:true});symlinkSync(outside,join(linked.applicationRoot,'app','0.1.0-preview.1'));await expect(installPreview(linked.options)).rejects.toThrow('symbolic link');
  const broad=fixture();for(const applicationRoot of ['/',broad.root])await expect(installPreview({...broad.options,applicationRoot})).rejects.toThrow('install root');
});

test('uninstall refuses foreign command links and unmarked payloads',async()=>{
  const foreign=fixture(),installed=await installPreview(foreign.options),command=join(foreign.binDirectory,'streamhub'),other=join(foreign.root,'other');writeFileSync(other,'foreign');unlinkSync(command);symlinkSync(other,command);
  await expect(uninstallPreview({packageRoot:installed.installRoot,applicationRoot:foreign.applicationRoot,binDirectory:foreign.binDirectory})).rejects.toThrow('command');expect(existsSync(installed.installRoot)).toBe(true);
  const unmarked=fixture(),payload=join(unmarked.applicationRoot,'app','0.1.0-preview.1');mkdirSync(payload,{recursive:true});await expect(uninstallPreview({packageRoot:payload,applicationRoot:unmarked.applicationRoot,binDirectory:unmarked.binDirectory})).rejects.toThrow('owned');
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
});

test('invalid manifests are rejected and a missing owned version is a no-op',async()=>{
  const invalid=fixture();writeFileSync(join(invalid.packageRoot,'manifest.json'),'{}');await expect(installPreview(invalid.options)).rejects.toThrow('manifest');
  const missing=fixture(),packageRoot=join(missing.applicationRoot,'app','0.1.0-preview.1');expect(await uninstallPreview({...missing.options,packageRoot})).toEqual({removed:false,dataRoot:missing.dataRoot});
});
