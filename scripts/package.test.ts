import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {assemblePreview,relativeFiles,verifyChecksums,type PackageOptions} from './package';
import {validateReleaseManifest} from '../packages/release/manifest';

const put=(root:string,path:string,value='fixture')=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
const fixture=({machinePath=false,dependencyReadmeMachinePath=false,dependencyCodeMachinePath=false,dependencyExecutableMachinePath=false}:{machinePath?:boolean;dependencyReadmeMachinePath?:boolean;dependencyCodeMachinePath?:boolean;dependencyExecutableMachinePath?:boolean}={})=>{
  const sandbox=mkdtempSync(join(tmpdir(),'streamhub package test ')),repositoryRoot=join(sandbox,'repository'),outputRoot=join(sandbox,'dist'),tempRoot=join(sandbox,'temp');
  for(const file of ['README.md','DEVELOPMENT.md','packaging/install.sh','packaging/uninstall.sh','packaging/bin/streamhub','packaging/runtime.ts','packages/actions/composite.ts','packages/core/src/index.ts','packages/github-actions/pipeline.ts','packages/host/native/session-monitor.swift','packages/host/src/main.ts','packages/presentation/backend.ts','packages/streamdeck/hid.ts','packages/studio/document.ts','packages/editor/web/index.html','packages/editor/web/style.css','packages/editor/web/icon-library.css','packages/editor/web/display-settings.css'])put(repositoryRoot,file);
  put(repositoryRoot,'package.json',JSON.stringify({name:'streamhub',version:'0.1.0-preview.1',type:'module',dependencies:{sharp:'0.34.5'}}));put(repositoryRoot,'bun.lock','lock');
  put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json',JSON.stringify({Version:'0.2.0.0'}));put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/bin/plugin.js','plugin');put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/logs/private.log','secret');put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/private/credential.txt','secret');
  const options:PackageOptions={repositoryRoot,outputRoot,tempRoot,platform:'darwin',arch:'arm64',gitCommit:'b'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',preparePlugin:async()=>{},buildApplications:async({packageRoot})=>{put(packageRoot,'app/cli.js',machinePath?'const buildRoot="/Users/buildbot/Workspaces/streamhub";':'cli');put(packageRoot,'app/install.js','installer');put(packageRoot,'app/studio.js','studio');put(packageRoot,'app/config.json','config');put(packageRoot,'app/session-token.txt','token');put(packageRoot,'app/private/credential.txt','private');put(packageRoot,'app/com.streamhub.runtime.plist','plist');put(packageRoot,'app/smoke.test.ts','test');put(packageRoot,'app/smoke.js.map','map');put(packageRoot,'app/logs/runtime.log','log');put(packageRoot,'app/.git/HEAD','git');put(packageRoot,'app/.streamhub/config.json','state');put(packageRoot,'share/studio/app.js','browser');},installDependencies:async({appRoot})=>{put(appRoot,'node_modules/sharp/index.js',dependencyCodeMachinePath?'const buildRoot="/Users/buildbot/Workspaces/streamhub";':'dependency');put(appRoot,'node_modules/sharp/bin/tool',dependencyExecutableMachinePath?'#!/bin/sh\nroot=/Users/buildbot/Workspaces/streamhub\n':'#!/bin/sh\n');put(appRoot,'node_modules/sharp/index.test.js','test');put(appRoot,'node_modules/sharp/index.js.map','map');put(appRoot,'node_modules/escalade/readme.md',dependencyReadmeMachinePath?'Example: /Users/example/Project':'readme');},archive:async({archivePath})=>put(dirname(archivePath),archivePath.split('/').at(-1)!,'archive')};
  return{options};
};

test('assembler ships daemon-capable CLI and installer with an unbundled Runtime but no private or development artifacts',async()=>{
  const {options}=fixture(),result=await assemblePreview(options),files=relativeFiles(result.root);
  expect(files).toEqual(expect.arrayContaining(['README.md','DEVELOPMENT.md','manifest.json','SHA256SUMS','install.sh','uninstall.sh','bin/streamhub','app/cli.js','app/install.js','app/runtime.ts','app/studio.js','app/packages/actions/composite.ts','app/packages/core/src/index.ts','app/packages/github-actions/pipeline.ts','app/packages/host/native/session-monitor.swift','app/packages/host/src/main.ts','app/packages/presentation/backend.ts','app/packages/streamdeck/hid.ts','app/packages/studio/document.ts','share/studio/index.html','share/studio/app.js','share/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json']));
  expect(files).not.toContain('app/runtime.js');
  for(const path of ['app/config.json','app/session-token.txt','app/private/credential.txt','app/com.streamhub.runtime.plist','app/smoke.test.ts','app/smoke.js.map','app/logs/runtime.log','app/.git/HEAD','app/.streamhub/config.json','share/streamdeck-plugin/com.streamhub.studio.sdPlugin/logs/private.log','share/streamdeck-plugin/com.streamhub.studio.sdPlugin/private/credential.txt'])expect(files).not.toContain(path);
});

test('assembler rejects build-machine absolute paths in bounded staged text files',async()=>{
  const {options}=fixture({machinePath:true});
  await expect(assemblePreview(options)).rejects.toThrow('Build-machine absolute path');
});

test('assembler allows illustrative build-machine paths in vendored dependency documentation',async()=>{
  const {options}=fixture({dependencyReadmeMachinePath:true});
  await expect(assemblePreview(options)).resolves.toMatchObject({root:expect.any(String)});
});

test('assembler rejects build-machine absolute paths in vendored dependency code',async()=>{
  const {options}=fixture({dependencyCodeMachinePath:true});
  await expect(assemblePreview(options)).rejects.toThrow('Build-machine absolute path');
});

test('assembler rejects build-machine absolute paths in vendored extensionless executables',async()=>{
  const {options}=fixture({dependencyExecutableMachinePath:true});
  await expect(assemblePreview(options)).rejects.toThrow('Build-machine absolute path');
});

test('every payload file has one sorted checksum and a valid manifest',async()=>{
  const {options}=fixture(),result=await assemblePreview(options),verification=verifyChecksums(result.root),lines=readFileSync(join(result.root,'SHA256SUMS'),'utf8').trim().split('\n');
  expect(verification).toEqual({valid:true,missing:[],extra:[]});expect(lines).toEqual([...lines].sort());
  expect(validateReleaseManifest(JSON.parse(readFileSync(join(result.root,'manifest.json'),'utf8'))).target).toBe('macos-arm64');
});

test('assembler rejects unsupported targets before running build hooks',async()=>{
  const {options}=fixture();let called=false;
  await expect(assemblePreview({...options,arch:'x64',buildApplications:async()=>{called=true;}})).rejects.toThrow('macOS arm64');expect(called).toBe(false);
});
