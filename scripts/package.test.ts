import {expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {assemblePreview,relativeFiles,verifyChecksums,type PackageOptions} from './package';
import {validateReleaseManifest} from '../packages/release/manifest';

const put=(root:string,path:string,value='fixture')=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
const fixture=()=>{
  const sandbox=mkdtempSync(join(tmpdir(),'streamhub package test ')),repositoryRoot=join(sandbox,'repository'),outputRoot=join(sandbox,'dist'),tempRoot=join(sandbox,'temp');
  for(const file of ['README.md','DEVELOPMENT.md','packaging/install.sh','packaging/uninstall.sh','packaging/bin/streamhub','packages/host/native/session-monitor.swift','packages/editor/web/index.html','packages/editor/web/style.css','packages/editor/web/icon-library.css','packages/editor/web/display-settings.css'])put(repositoryRoot,file);
  put(repositoryRoot,'package.json',JSON.stringify({name:'streamhub',version:'0.1.0-preview.1',type:'module',dependencies:{sharp:'0.34.5'}}));put(repositoryRoot,'bun.lock','lock');
  put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json',JSON.stringify({Version:'0.2.0.0'}));put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/bin/plugin.js','plugin');put(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin/logs/private.log','secret');
  const options:PackageOptions={repositoryRoot,outputRoot,tempRoot,platform:'darwin',arch:'arm64',gitCommit:'b'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',preparePlugin:async()=>{},buildApplications:async({packageRoot})=>{put(packageRoot,'app/runtime.js','runtime');put(packageRoot,'app/cli.js','cli');put(packageRoot,'app/studio.js','studio');put(packageRoot,'share/studio/app.js','browser');},installDependencies:async({appRoot})=>{put(appRoot,'node_modules/sharp/index.js','dependency');put(appRoot,'node_modules/sharp/index.test.js','test');put(appRoot,'node_modules/sharp/index.js.map','map');},archive:async({archivePath})=>put(dirname(archivePath),archivePath.split('/').at(-1)!,'archive')};
  return{options};
};

test('assembler creates the complete allowlisted payload without private or development files',async()=>{
  const {options}=fixture(),result=await assemblePreview(options),files=relativeFiles(result.root);
  expect(files).toEqual(expect.arrayContaining(['README.md','DEVELOPMENT.md','manifest.json','SHA256SUMS','install.sh','uninstall.sh','bin/streamhub','app/cli.js','app/runtime.js','app/studio.js','app/native/session-monitor.swift','share/studio/index.html','share/studio/app.js','share/streamdeck-plugin/com.streamhub.studio.sdPlugin/manifest.json']));
  expect(files.some(path=>/(^|\/)(\.streamhub|\.git|logs|tests?|__tests__)(\/|$)|\.test\.|\.map$/.test(path))).toBe(false);
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
