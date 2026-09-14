import {expect,test} from 'bun:test';
import {chmodSync,copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRuntimeDaemon,type CommandResult} from '../packages/release/daemon';
import {resolveInstallerPaths} from '../packages/release/install';
import {createReleaseManifest} from '../packages/release/manifest';
import {packageVersion} from '../packages/release/version';
import {runPreviewInstaller} from './preview-install';

const put=(root:string,path:string,value='fixture')=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
const packageFixture=(root:string)=>{
  put(root,'bin/streamhub','#!/bin/sh\n');put(root,'app/cli.js','cli');put(root,'README.md');put(root,'DEVELOPMENT.md');put(root,'install.sh');put(root,'uninstall.sh');put(root,'SHA256SUMS');put(root,'share/placeholder');
  writeFileSync(join(root,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})));
};

test('the installed uninstall wrapper exports its exact custom command path',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-uninstall-wrapper-')),prefix=join(root,'custom prefix'),packageRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),wrapper=join(packageRoot,'uninstall.sh'),fakeBin=join(root,'fake-bin'),capture=join(root,'capture');
  try{
    packageFixture(packageRoot);copyFileSync(resolve('packaging/uninstall.sh'),wrapper);chmodSync(wrapper,0o700);mkdirSync(fakeBin);
    writeFileSync(join(fakeBin,'bun'),'#!/bin/sh\nprintf "%s\\n" "$STREAMHUB_PACKAGE_ROOT" "$STREAMHUB_COMMAND_PATH" "$1" "$2" > "$STREAMHUB_CAPTURE"\n',{mode:0o700});
    const child=Bun.spawn([wrapper],{env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`,STREAMHUB_CAPTURE:capture},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(0);
    const [capturedPackage,capturedCommand,entry,operation]=readFileSync(capture,'utf8').trim().split('\n');
    expect([capturedPackage,capturedCommand,entry,operation]).toEqual([packageRoot,join(prefix,'bin','streamhub'),join(packageRoot,'app','install.js'),'uninstall']);
    const locations=resolveInstallerPaths({arguments:{operation:'uninstall'},packageRoot:capturedPackage!,home:join(root,'home'),commandPath:capturedCommand,installedPackage:true});
    expect(locations).toEqual({applicationRoot:join(prefix,'Application Support','Streamhub'),binDirectory:join(prefix,'bin')});
    expect(join(locations.applicationRoot,'data')).toBe(join(prefix,'Application Support','Streamhub','data'));
    writeFileSync(join(packageRoot,'.streamhub-preview-install.json'),JSON.stringify({name:'streamhub-preview',version:packageVersion,gitCommit:'a'.repeat(40)}));mkdirSync(join(prefix,'bin'),{recursive:true});symlinkSync(join(packageRoot,'bin','streamhub'),capturedCommand!);
    const commands:string[][]=[],output:string[]=[],runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:113,stdout:'',stderr:'Could not find service'};};
    await runPreviewInstaller({argv:['uninstall'],packageRoot:capturedPackage,home:join(root,'home'),commandPath:capturedCommand,daemonFor:targetRoot=>createRuntimeDaemon({home:join(root,'home'),uid:501,bunPath:'/bin/bun',packageRoot:targetRoot,runner}),write:value=>output.push(value)});
    expect(existsSync(packageRoot)).toBe(false);expect(existsSync(capturedCommand!)).toBe(false);expect(output.at(-1)).toBe(`Data preserved: ${join(prefix,'Application Support','Streamhub','data')}`);
    expect(commands).toEqual([['/bin/launchctl','print','gui/501/com.streamhub.runtime']]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a missing expected plist performs no daemon operation during a fresh install',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-fresh-install-')),packageRoot=join(root,'package'),prefix=join(root,'prefix'),home=join(root,'home'),commands:string[][]=[];
  packageFixture(packageRoot);
  const runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:113,stdout:'',stderr:'Could not find service'};};
  try{
    await runPreviewInstaller({argv:['install','--prefix',prefix],packageRoot,home,daemonFor:root=>createRuntimeDaemon({home,uid:501,bunPath:'/bin/bun',packageRoot:root,runner}),write:()=>{}});
    expect(commands).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a foreign expected plist refuses a fresh install before payload publication',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-foreign-install-')),packageRoot=join(root,'package'),prefix=join(root,'prefix'),home=join(root,'home'),commands:string[][]=[];
  packageFixture(packageRoot);
  const runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:113,stdout:'',stderr:'Could not find service'};};
  const installedRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),daemonFor=(targetRoot:string)=>createRuntimeDaemon({home,uid:501,bunPath:'/bin/bun',packageRoot:targetRoot,runner}),plistPath=daemonFor(installedRoot).paths.plistPath;
  try{
    mkdirSync(dirname(plistPath),{recursive:true});writeFileSync(plistPath,'<plist><dict><key>Label</key><string>foreign</string></dict></plist>');
    await expect(runPreviewInstaller({argv:['install','--prefix',prefix],packageRoot,home,daemonFor,write:()=>{}})).rejects.toThrow('owned LaunchAgent');
    expect(existsSync(installedRoot)).toBe(false);expect(commands).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a dangling expected plist link refuses a fresh install before payload publication',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-linked-install-')),packageRoot=join(root,'package'),prefix=join(root,'prefix'),home=join(root,'home'),commands:string[][]=[];
  packageFixture(packageRoot);
  const runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:113,stdout:'',stderr:'Could not find service'};};
  const installedRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),daemonFor=(targetRoot:string)=>createRuntimeDaemon({home,uid:501,bunPath:'/bin/bun',packageRoot:targetRoot,runner}),plistPath=daemonFor(installedRoot).paths.plistPath;
  try{
    mkdirSync(dirname(plistPath),{recursive:true});symlinkSync(join(root,'missing.plist'),plistPath);
    await expect(runPreviewInstaller({argv:['install','--prefix',prefix],packageRoot,home,daemonFor,write:()=>{}})).rejects.toThrow('symbolic LaunchAgent');
    expect(existsSync(installedRoot)).toBe(false);expect(commands).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
