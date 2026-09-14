import {expect,test} from 'bun:test';
import {lstat,mkdtemp,mkdir,readFile,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createRuntimeDaemon,prepareRuntimeLog,readRuntimeLog,type CommandResult} from './daemon';
import {launchAgentPaths,renderLaunchAgent,type LaunchAgentInput} from './launch-agent';

type Existing='owned'|'foreign'|'symlink';

type Fixture={
  input:LaunchAgentInput;
  paths:ReturnType<typeof launchAgentPaths>;
  recorded:{commands:string[][];loaded:boolean;running:boolean;definition?:string;failBootstrap:number;failBootout:boolean};
  daemon:ReturnType<typeof createRuntimeDaemon>;
  cleanup():Promise<void>;
};

const missingService='Could not find service "com.streamhub.runtime" in domain for system';

async function daemonFixture(options:{existing?:Existing;loaded?:boolean;running?:boolean;input?:Partial<LaunchAgentInput>;failBootstrap?:number;failBootout?:boolean;failPrintOn?:number}={}):Promise<Fixture>{
  const directory=await mkdtemp(join(tmpdir(),'streamhub-daemon-'));
  const input:LaunchAgentInput={
    home:join(directory,'home'),
    uid:501,
    bunPath:'/opt/homebrew/bin/bun',
    packageRoot:join(directory,'Streamhub/app/1.0.0'),
    ...options.input,
  };
  const paths=launchAgentPaths(input);
  await mkdir(join(input.home,'Library/LaunchAgents'),{recursive:true});
  await mkdir(input.packageRoot,{recursive:true});
  if(options.existing==='owned') await writeFile(paths.plistPath,renderLaunchAgent(input));
  if(options.existing==='foreign') await writeFile(paths.plistPath,'<plist><dict><key>Label</key><string>other</string></dict></plist>');
  if(options.existing==='symlink'){
    const target=join(directory,'foreign.plist');
    await writeFile(target,renderLaunchAgent(input));
    await symlink(target,paths.plistPath);
  }
  const recorded={
    commands:[] as string[][],
    loaded:options.loaded??false,
    running:options.running??false,
    definition:options.loaded&&options.existing==='owned'?renderLaunchAgent(input):undefined,
    failBootstrap:options.failBootstrap??0,
    failBootout:options.failBootout??false,
  };
  let printCount=0;
  const runner=async(argv:readonly string[]):Promise<CommandResult>=>{
    recorded.commands.push([...argv]);
    if(argv[0]==='/usr/bin/plutil') return {code:0,stdout:'',stderr:''};
    if(argv[1]==='print'){
      printCount++;
      if(printCount===options.failPrintOn) return {code:1,stdout:'token=private',stderr:'path=/private/secret'};
      return recorded.loaded
        ? {code:0,stdout:`state = ${recorded.running?'running':'exited'}\npid = ${recorded.running?'123':'0'}\nlast exit code = 7`,stderr:''}
        : {code:113,stdout:'',stderr:missingService};
    }
    if(argv[1]==='bootstrap'){
      if(recorded.loaded) return {code:1,stdout:'private conflict',stderr:'same-label service already loaded'};
      if(recorded.failBootstrap>0){
        recorded.failBootstrap--;
        return {code:1,stdout:'private output',stderr:'private failure'};
      }
      recorded.loaded=true;
      recorded.running=true;
      recorded.definition=await readFile(argv[3]!,'utf8');
      return {code:0,stdout:'',stderr:''};
    }
    if(argv[1]==='bootout'){
      if(recorded.failBootout) return {code:1,stdout:'private output',stderr:'private failure'};
      recorded.loaded=false;
      recorded.running=false;
      recorded.definition=undefined;
      return {code:0,stdout:'',stderr:''};
    }
    if(argv[1]==='kickstart'){
      recorded.running=true;
      return {code:0,stdout:'',stderr:''};
    }
    throw new Error(`unexpected command: ${argv.join(' ')}`);
  };
  return {
    input,paths,recorded,
    daemon:createRuntimeDaemon({...input,runner}),
    cleanup:()=>rm(directory,{recursive:true,force:true}),
  };
}

test('enable validates, publishes, bootstraps, and leaves a live identical job untouched',async()=>{
  const h=await daemonFixture();
  try{
    expect(await h.daemon.enable()).toEqual({enabled:true,loaded:true,running:true,pid:123,lastExitStatus:7});
    const temporary=h.recorded.commands[1]?.[2];
    expect(temporary).toMatch(new RegExp(`^${h.paths.plistPath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\..+\\.tmp$`));
    expect(h.recorded.commands).toEqual([
      ['/bin/launchctl','print',h.paths.service],
      ['/usr/bin/plutil','-lint',temporary!],
      ['/bin/launchctl','bootstrap',h.paths.domain,h.paths.plistPath],
      ['/bin/launchctl','print',h.paths.service],
    ]);
    h.recorded.commands.length=0;
    await h.daemon.enable();
    expect(h.recorded.commands).toEqual([['/bin/launchctl','print',h.paths.service]]);
  }finally{await h.cleanup();}
});

test('enable refuses an unowned loaded service when its plist is absent',async()=>{
  const h=await daemonFixture({loaded:true,running:true});
  try{
    await expect(h.daemon.enable()).rejects.toThrow('unowned loaded LaunchAgent');
    expect(h.recorded.commands).toEqual([['/bin/launchctl','print',h.paths.service]]);
    await expect(lstat(h.paths.plistPath)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('disable and restart operate only on an owned loaded definition',async()=>{
  const h=await daemonFixture();
  try{
    await h.daemon.enable();
    h.recorded.commands.length=0;
    await h.daemon.restart();
    expect(h.recorded.commands).toEqual([
      ['/bin/launchctl','print',h.paths.service],
      ['/bin/launchctl','kickstart','-k',h.paths.service],
      ['/bin/launchctl','print',h.paths.service],
    ]);
    h.recorded.commands.length=0;
    await h.daemon.disable();
    expect(h.recorded.commands).toEqual([
      ['/bin/launchctl','print',h.paths.service],
      ['/bin/launchctl','bootout',h.paths.service],
    ]);
    await expect(lstat(h.paths.plistPath)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('foreign and linked definitions cause no launchctl mutation',async()=>{
  for(const existing of ['foreign','symlink'] as const){
    const h=await daemonFixture({existing});
    try{
      await expect(h.daemon.enable()).rejects.toThrow(existing==='foreign'?'owned':'symbolic');
      expect(h.recorded.commands).toEqual([]);
    }finally{await h.cleanup();}
  }
});

test('failed replacement bootstrap restores prior bytes and its loaded job',async()=>{
  const h=await daemonFixture({loaded:true,running:true,failBootstrap:1});
  const oldInput={...h.input,packageRoot:h.input.packageRoot.replace('/1.0.0','/0.9.0')};
  const previous=renderLaunchAgent(oldInput);
  try{
    await writeFile(h.paths.plistPath,previous);
    await expect(h.daemon.enable()).rejects.toThrow('Unable to enable Streamhub runtime service');
    expect(await readFile(h.paths.plistPath,'utf8')).toBe(previous);
    expect(h.recorded.loaded).toBe(true);
    expect(h.recorded.commands.map(command=>command[1])).toEqual(['print','bootout','-lint','bootstrap','bootstrap']);
  }finally{await h.cleanup();}
});

test('failed post-bootstrap status verification restores prior bytes and loaded state',async()=>{
  const h=await daemonFixture({loaded:true,running:true,failPrintOn:2});
  const oldInput={...h.input,packageRoot:h.input.packageRoot.replace('/1.0.0','/0.9.0')};
  const previous=renderLaunchAgent(oldInput);
  try{
    await writeFile(h.paths.plistPath,previous);
    h.recorded.definition=previous;
    await expect(h.daemon.enable()).rejects.toThrow('Unable to enable Streamhub runtime service');
    expect(await readFile(h.paths.plistPath,'utf8')).toBe(previous);
    expect(h.recorded.loaded).toBe(true);
    expect(h.recorded.definition).toBe(previous);
    expect(h.recorded.commands.map(command=>command[1])).toEqual(['print','bootout','-lint','bootstrap','print','bootout','bootstrap']);
  }finally{await h.cleanup();}
});

test('failed bootout preserves the owned plist',async()=>{
  const h=await daemonFixture({existing:'owned',loaded:true,running:true,failBootout:true});
  try{
    const original=await readFile(h.paths.plistPath,'utf8');
    await expect(h.daemon.disable()).rejects.toThrow('Unable to disable Streamhub runtime service');
    expect(await readFile(h.paths.plistPath,'utf8')).toBe(original);
  }finally{await h.cleanup();}
});

test('restart rejects a disabled runtime without bootstrapping it',async()=>{
  const h=await daemonFixture();
  try{
    await expect(h.daemon.restart()).rejects.toThrow('not enabled');
    expect(h.recorded.commands).toEqual([['/bin/launchctl','print',h.paths.service]]);
  }finally{await h.cleanup();}
});

test('status reports an enabled but exited job and normalizes a missing job',async()=>{
  const active=await daemonFixture({existing:'owned',loaded:true,running:false});
  const missing=await daemonFixture();
  try{
    expect(await active.daemon.status()).toEqual({enabled:true,loaded:true,running:false,lastExitStatus:7});
    expect(await missing.daemon.status()).toEqual({enabled:false,loaded:false,running:false});
  }finally{await active.cleanup();await missing.cleanup();}
});

test('published and prepared runtime logs use mode 0600',async()=>{
  const h=await daemonFixture();
  try{
    await h.daemon.enable();
    expect((await stat(h.paths.plistPath)).mode&0o777).toBe(0o600);
    expect((await stat(h.paths.logPath)).mode&0o777).toBe(0o600);
  }finally{await h.cleanup();}
});

test('enable rolls an oversized managed runtime log once',async()=>{
  const h=await daemonFixture();
  try{
    await mkdir(join(h.input.home,'Library/Application Support/Streamhub/data/logs'),{recursive:true});
    const oversized='x'.repeat(5*1024*1024+1);
    await writeFile(h.paths.logPath,oversized);
    await writeFile(h.paths.previousLogPath,'old managed log');
    await h.daemon.enable();
    expect(await readFile(h.paths.previousLogPath,'utf8')).toBe(oversized);
    expect(await readFile(h.paths.logPath,'utf8')).toBe('');
  }finally{await h.cleanup();}
});

test('enable does not roll a runtime log at the five MiB boundary',async()=>{
  const h=await daemonFixture();
  try{
    await mkdir(join(h.input.home,'Library/Application Support/Streamhub/data/logs'),{recursive:true});
    const boundary='y'.repeat(5*1024*1024);
    await writeFile(h.paths.logPath,boundary);
    await h.daemon.enable();
    expect(await readFile(h.paths.logPath,'utf8')).toBe(boundary);
    await expect(lstat(h.paths.previousLogPath)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('readRuntimeLog returns no more than the trailing two hundred lines and sixty four KiB',async()=>{
  const h=await daemonFixture();
  try{
    await mkdir(join(h.input.home,'Library/Application Support/Streamhub/data/logs'),{recursive:true});
    await writeFile(h.paths.logPath,Array.from({length:300},(_,index)=>`line-${index}`).join('\n')+'\n');
    const output=readRuntimeLog(h.paths);
    expect(output.startsWith('line-100\n')).toBe(true);
    expect(output.includes('line-99\n')).toBe(false);
    expect(output.endsWith('line-299\n')).toBe(true);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64*1024);
  }finally{await h.cleanup();}
});

test('managed log helpers reject symbolic links',async()=>{
  const h=await daemonFixture();
  try{
    await mkdir(join(h.input.home,'Library/Application Support/Streamhub/data/logs'),{recursive:true});
    const target=join(h.input.home,'outside.log');
    await writeFile(target,'unmanaged');
    await symlink(target,h.paths.logPath);
    expect(()=>prepareRuntimeLog(h.paths)).toThrow('symbolic');
    expect(()=>readRuntimeLog(h.paths)).toThrow('symbolic');
  }finally{await h.cleanup();}
});

test('managed log helpers reject forged paths without touching arbitrary files',async()=>{
  const h=await daemonFixture();
  const target=join(tmpdir(),`streamhub-forged-${crypto.randomUUID()}.log`);
  const forged={...h.paths,logPath:target,previousLogPath:`${target}.1`};
  try{
    expect(()=>prepareRuntimeLog(forged)).toThrow('managed runtime log paths');
    expect(()=>readRuntimeLog(forged)).toThrow('managed runtime log paths');
    await expect(lstat(target)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('managed log helpers reject a fully forged traversal-bearing path bundle',async()=>{
  const h=await daemonFixture();
  const home=`${tmpdir()}/streamhub-forged/../outside-home`;
  const data=`${home}/Library/Application Support/Streamhub/data`;
  const forged={
    label:h.paths.label,
    domain:h.paths.domain,
    service:h.paths.service,
    plistPath:`${home}/Library/LaunchAgents/com.streamhub.runtime.plist`,
    configPath:`${data}/config.json`,
    logPath:`${data}/logs/runtime.log`,
    previousLogPath:`${data}/logs/runtime.log.1`,
    runtimePath:`${tmpdir()}/streamhub-forged/../outside-app/Streamhub/app/1.0.0/app/runtime.ts`,
  };
  try{
    expect(()=>prepareRuntimeLog(forged)).toThrow('managed runtime log paths');
    expect(()=>readRuntimeLog(forged)).toThrow('managed runtime log paths');
    await expect(lstat(forged.logPath.replace('/../','/'))).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('managed log helpers reject a clean fully forged normalized path bundle',async()=>{
  const h=await daemonFixture();
  const home=join(tmpdir(),`streamhub-forged-${crypto.randomUUID()}`);
  const data=`${home}/Library/Application Support/Streamhub/data`;
  const forged={
    label:h.paths.label,
    domain:h.paths.domain,
    service:h.paths.service,
    plistPath:`${home}/Library/LaunchAgents/com.streamhub.runtime.plist`,
    configPath:`${data}/config.json`,
    logPath:`${data}/logs/runtime.log`,
    previousLogPath:`${data}/logs/runtime.log.1`,
    runtimePath:`${home}/Streamhub/app/1.0.0/app/runtime.ts`,
  };
  try{
    expect(()=>prepareRuntimeLog(forged)).toThrow('managed runtime log paths');
    expect(()=>readRuntimeLog(forged)).toThrow('managed runtime log paths');
    await expect(lstat(forged.logPath)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('managed log helpers reject clones of legitimate paths',async()=>{
  const h=await daemonFixture();
  const copy={...h.paths};
  try{
    expect(()=>prepareRuntimeLog(copy)).toThrow('managed runtime log paths');
    expect(()=>readRuntimeLog(copy)).toThrow('managed runtime log paths');
    await expect(lstat(h.paths.logPath)).rejects.toThrow();
  }finally{await h.cleanup();}
});

test('public boundaries redact runner failures and path details',async()=>{
  const h=await daemonFixture();
  const runner=async():Promise<CommandResult>=>{throw new Error('Refusing token=private path=/private/secret');};
  const daemon=createRuntimeDaemon({...h.input,runner});
  try{
    for(const operation of [()=>daemon.status(),()=>daemon.enable(),()=>daemon.disable(),()=>daemon.restart()]){
      const error=await operation().then(()=>undefined,error=>error as Error);
      expect(error?.message).not.toContain('private');
      expect(error?.message).not.toContain('/private');
    }
  }finally{await h.cleanup();}
});

test('managed log helpers redact filesystem failures',async()=>{
  const h=await daemonFixture();
  try{
    const logDirectory=join(h.input.home,'Library/Application Support/Streamhub/data/logs');
    await mkdir(dirname(logDirectory),{recursive:true});
    await writeFile(logDirectory,'not a directory');
    const error=(()=>{try{prepareRuntimeLog(h.paths);}catch(value){return value as Error;}})();
    expect(error?.message).toBe('Unable to prepare Streamhub runtime log');
    expect(error?.message).not.toContain(h.input.home);
  }finally{await h.cleanup();}
});
