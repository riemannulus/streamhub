import {expect,test} from 'bun:test';
import {chmodSync,copyFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {createRuntimeDaemon,type CommandResult,type RuntimeDaemon} from '../packages/release/daemon';
import {resolveInstallerPaths} from '../packages/release/install';
import {launchAgentPaths,renderLaunchAgent} from '../packages/release/launch-agent';
import {createReleaseManifest} from '../packages/release/manifest';
import {packageVersion} from '../packages/release/version';
import {runPreviewInstaller} from './preview-install';

const put=(root:string,path:string,value='fixture')=>{const target=join(root,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,value);};
const packageFixture=(root:string)=>{
  put(root,'bin/streamhub','#!/bin/sh\n');put(root,'app/cli.js','cli');put(root,'README.md');put(root,'DEVELOPMENT.md');put(root,'install.sh');put(root,'uninstall.sh');put(root,'SHA256SUMS');put(root,'share/placeholder');
  writeFileSync(join(root,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit:'a'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})));
};

test('the direct uninstall wrapper maps the normal install layout to the default command',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-uninstall-wrapper-')),home=join(root,'home'),packageRoot=join(home,'Library','Application Support','Streamhub','app',packageVersion),wrapper=join(packageRoot,'uninstall.sh'),fakeBin=join(root,'fake-bin'),capture=join(root,'capture');
  try{
    packageFixture(packageRoot);copyFileSync(resolve('packaging/uninstall.sh'),wrapper);chmodSync(wrapper,0o700);mkdirSync(fakeBin);
    writeFileSync(join(fakeBin,'bun'),'#!/bin/sh\nprintf "%s\\n" "$STREAMHUB_PACKAGE_ROOT" "$STREAMHUB_COMMAND_PATH" "$1" "$2" > "$STREAMHUB_CAPTURE"\n',{mode:0o700});
    const child=Bun.spawn([wrapper],{env:{...process.env,HOME:home,PATH:`${fakeBin}:${process.env.PATH}`,STREAMHUB_CAPTURE:capture},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(0);
    const [capturedPackage,capturedCommand,entry,operation]=readFileSync(capture,'utf8').trim().split('\n');
    expect([capturedPackage,capturedCommand,entry,operation]).toEqual([packageRoot,join(home,'.local','bin','streamhub'),join(packageRoot,'app','install.js'),'uninstall']);
    expect(resolveInstallerPaths({arguments:{operation:'uninstall'},packageRoot:capturedPackage!,home,commandPath:capturedCommand,installedPackage:true})).toEqual({applicationRoot:join(home,'Library','Application Support','Streamhub'),binDirectory:join(home,'.local','bin')});
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('the direct uninstall wrapper keeps the explicit custom-prefix command path',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-uninstall-wrapper-')),prefix=join(root,'custom prefix'),packageRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),wrapper=join(packageRoot,'uninstall.sh'),fakeBin=join(root,'fake-bin'),capture=join(root,'capture');
  try{
    packageFixture(packageRoot);copyFileSync(resolve('packaging/uninstall.sh'),wrapper);chmodSync(wrapper,0o700);mkdirSync(fakeBin);
    writeFileSync(join(fakeBin,'bun'),'#!/bin/sh\nprintf "%s\\n" "$STREAMHUB_PACKAGE_ROOT" "$STREAMHUB_COMMAND_PATH" "$1" "$2" "$3" "$4" > "$STREAMHUB_CAPTURE"\n',{mode:0o700});
    const child=Bun.spawn([wrapper,'--prefix',prefix],{env:{...process.env,PATH:`${fakeBin}:${process.env.PATH}`,STREAMHUB_CAPTURE:capture},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(0);
    const [capturedPackage,capturedCommand,entry,operation,option,capturedPrefix]=readFileSync(capture,'utf8').trim().split('\n');
    expect([capturedPackage,capturedCommand,entry,operation,option,capturedPrefix]).toEqual([packageRoot,join(prefix,'bin','streamhub'),join(packageRoot,'app','install.js'),'uninstall','--prefix',prefix]);
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

test('uninstalling a plist-absent custom-prefix package preserves data without constructing a daemon',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-prefix-uninstall-')),prefix=join(root,'custom prefix'),packageRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),commandPath=join(prefix,'bin','streamhub'),dataRoot=join(prefix,'Application Support','Streamhub','data');
  try{
    packageFixture(packageRoot);writeFileSync(join(packageRoot,'.streamhub-preview-install.json'),JSON.stringify({name:'streamhub-preview',version:packageVersion,gitCommit:'a'.repeat(40)}));mkdirSync(dirname(commandPath),{recursive:true});symlinkSync(join(packageRoot,'bin','streamhub'),commandPath);mkdirSync(dataRoot,{recursive:true});writeFileSync(join(dataRoot,'sentinel'),'keep');
    await runPreviewInstaller({argv:['uninstall','--prefix',prefix],packageRoot,home:join(root,'home'),commandPath,daemonFor:()=>{throw new Error('daemon construction must not occur');},write:()=>{}});
    expect(existsSync(packageRoot)).toBe(false);expect(existsSync(commandPath)).toBe(false);expect(readFileSync(join(dataRoot,'sentinel'),'utf8')).toBe('keep');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('normal installed uninstall refuses to remove a package when the same-label job is loaded without its plist',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-normal-uninstall-')),home=join(root,'home'),packageRoot=join(home,'Library','Application Support','Streamhub','app',packageVersion),commandPath=join(home,'.local','bin','streamhub'),commands:string[][]=[];
  try{
    packageFixture(packageRoot);writeFileSync(join(packageRoot,'.streamhub-preview-install.json'),JSON.stringify({name:'streamhub-preview',version:packageVersion,gitCommit:'a'.repeat(40)}));mkdirSync(dirname(commandPath),{recursive:true});symlinkSync(join(packageRoot,'bin','streamhub'),commandPath);
    const runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:0,stdout:'state = running\npid = 123',stderr:''};};
    await expect(runPreviewInstaller({argv:['uninstall'],packageRoot,home,commandPath,daemonFor:targetRoot=>createRuntimeDaemon({home,uid:501,bunPath:'/bin/bun',packageRoot:targetRoot,runner}),write:()=>{}})).rejects.toThrow('unowned loaded LaunchAgent');
    expect(existsSync(packageRoot)).toBe(true);expect(existsSync(commandPath)).toBe(true);expect(commands).toEqual([['/bin/launchctl','print','gui/501/com.streamhub.runtime']]);
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

test('enabled update does not publish or re-enable while old runtime disable is still waiting for physical exit',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-update-wait-')),home=join(root,'home'),source=join(root,'package'),installedRoot=join(home,'Library','Application Support','Streamhub','app',packageVersion),commandPath=join(home,'.local','bin','streamhub'),events:string[]=[];
  let releaseDisable:(()=>void)|undefined,enteredDisable:(()=>void)|undefined;
  const disabled=new Promise<void>(resolve=>{releaseDisable=resolve;}),entered=new Promise<void>(resolve=>{enteredDisable=resolve;});
  try{
    packageFixture(source);writeFileSync(join(source,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit:'b'.repeat(40),builtAt:'2026-09-11T00:00:00.000Z',pluginVersion:'0.2.0.0'})));
    packageFixture(installedRoot);writeFileSync(join(installedRoot,'.streamhub-preview-install.json'),JSON.stringify({name:'streamhub-preview',version:packageVersion,gitCommit:'a'.repeat(40)}));mkdirSync(dirname(commandPath),{recursive:true});symlinkSync(join(installedRoot,'bin','streamhub'),commandPath);
    const input={home,uid:501,bunPath:'/bin/bun',packageRoot:installedRoot},paths=launchAgentPaths(input);mkdirSync(dirname(paths.plistPath),{recursive:true});writeFileSync(paths.plistPath,renderLaunchAgent(input));
    const daemon:RuntimeDaemon={
      paths,
      status:async()=>({enabled:true,loaded:true,running:true,pid:123}),
      disable:async()=>{events.push('disable-old');enteredDisable?.();await disabled;events.push('old-exited');return{enabled:false,loaded:false,running:false};},
      enable:async()=>{events.push('enable-new');return{enabled:true,loaded:true,running:true,pid:456};},
      restart:async()=>({enabled:true,loaded:true,running:true,pid:456}),
    };
    const installing=runPreviewInstaller({argv:['install'],packageRoot:source,home,commandPath,daemonFor:()=>daemon,write:()=>{}});
    await entered;
    expect(events).toEqual(['disable-old']);
    expect(JSON.parse(readFileSync(join(installedRoot,'manifest.json'),'utf8')).gitCommit).toBe('a'.repeat(40));
    releaseDisable?.();
    await installing;
    expect(events).toEqual(['disable-old','old-exited','enable-new']);
    expect(JSON.parse(readFileSync(join(installedRoot,'manifest.json'),'utf8')).gitCommit).toBe('b'.repeat(40));
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

test('a legacy plist from another Streamhub application root refuses fresh install before payload publication',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-legacy-foreign-install-')),packageRoot=join(root,'package'),prefix=join(root,'prefix'),home=join(root,'home'),commands:string[][]=[];
  packageFixture(packageRoot);
  const runner=async(argv:readonly string[]):Promise<CommandResult>=>{commands.push([...argv]);return{code:113,stdout:'',stderr:'Could not find service'};};
  const installedRoot=join(prefix,'Application Support','Streamhub','app',packageVersion),daemonFor=(targetRoot:string)=>createRuntimeDaemon({home,uid:501,bunPath:'/bin/bun',packageRoot:targetRoot,runner}),plistPath=daemonFor(installedRoot).paths.plistPath;
  const legacy={home,uid:501,bunPath:'/opt/legacy/bin/bun',packageRoot:join(home,'Library/Application Support/Streamhub/app/0.9.0')};
  try{
    mkdirSync(dirname(plistPath),{recursive:true});writeFileSync(plistPath,renderLaunchAgent(legacy));
    await expect(runPreviewInstaller({argv:['install','--prefix',prefix],packageRoot,home,daemonFor,write:()=>{}})).rejects.toThrow('unowned LaunchAgent');
    expect(existsSync(installedRoot)).toBe(false);expect(readFileSync(plistPath,'utf8')).toBe(renderLaunchAgent(legacy));expect(commands).toEqual([]);
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
