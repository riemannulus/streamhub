import {createHash,randomUUID} from 'node:crypto';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {createReleaseManifest,validateReleaseManifest} from '../packages/release/manifest';
import {packageVersion,releaseTarget} from '../packages/release/version';

type BuildContext={repositoryRoot:string;packageRoot:string};
type InstallContext={repositoryRoot:string;appRoot:string};
type ArchiveContext={sourceRoot:string;directoryName:string;archivePath:string};
export type PackageOptions={
  repositoryRoot?:string;outputRoot?:string;tempRoot?:string;platform?:string;arch?:string;gitCommit?:string;builtAt?:string;
  preparePlugin?:(context:{repositoryRoot:string})=>Promise<void>;
  buildApplications?:(context:BuildContext)=>Promise<void>;
  installDependencies?:(context:InstallContext)=>Promise<void>;
  archive?:(context:ArchiveContext)=>Promise<void>;
};
export type PackageResult={root:string;archive:string;archiveSha256:string;version:string;target:typeof releaseTarget};

const packageDirectory=`streamhub-${packageVersion}-${releaseTarget}`;
const forbidden=/(^|\/)(\.streamhub|\.git|logs|tests?|__tests__)(\/|$)|\.test\.|\.map$/;
const checksum=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const copy=(source:string,target:string)=>{mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,preserveTimestamps:true});};
const run=async(command:string[],cwd:string)=>{const child=Bun.spawn(command,{cwd,stdout:'pipe',stderr:'pipe',env:process.env});const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);if(code!==0)throw new Error(`Package command failed: ${command.slice(0,3).join(' ')}\n${stderr||stdout}`);};
const assertTarget=(platform:string,arch:string)=>{if(platform!=='darwin'||arch!=='arm64')throw new Error('This preview package supports macOS arm64 only');};

export function relativeFiles(root:string):string[]{
  const files:string[]=[];
  const visit=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,entry.name),name=relative(root,path);if(entry.isDirectory())visit(path);else files.push(name);}};
  visit(root);return files.sort();
}

const prune=(root:string)=>{
  const visit=(directory:string)=>{for(const entry of readdirSync(directory,{withFileTypes:true})){const path=join(directory,entry.name),name=relative(root,path);if(forbidden.test(name)){rmSync(path,{recursive:entry.isDirectory()&&!entry.isSymbolicLink()});continue;}if(entry.isDirectory())visit(path);}};
  visit(root);
};

const writeChecksums=(root:string)=>{
  const lines=relativeFiles(root).filter(path=>path!=='SHA256SUMS').map(path=>`${checksum(join(root,path))}  ${path}`);
  writeFileSync(join(root,'SHA256SUMS'),lines.sort().join('\n')+'\n');
};

export function verifyChecksums(root:string):{valid:boolean;missing:string[];extra:string[]}{
  const expected=new Map<string,string>();
  for(const line of readFileSync(join(root,'SHA256SUMS'),'utf8').trim().split('\n')){const match=/^([a-f0-9]{64})  (.+)$/.exec(line);if(match)expected.set(match[2]!,match[1]!);}
  const actual=relativeFiles(root).filter(path=>path!=='SHA256SUMS'),missing=actual.filter(path=>!expected.has(path)||expected.get(path)!==checksum(join(root,path))),extra=[...expected.keys()].filter(path=>!actual.includes(path));
  return{valid:missing.length===0&&extra.length===0,missing,extra};
}

const buildOne=async(source:string,target:string,targetKind:'bun'|'browser')=>{mkdirSync(dirname(target),{recursive:true});const result=await Bun.build({entrypoints:[source],outdir:dirname(target),naming:basename(target),target:targetKind,packages:targetKind==='bun'?'external':undefined,minify:false,sourcemap:'none'});if(!result.success)throw new Error(`Build failed: ${result.logs.map(String).join('\n')}`);};

export async function buildPreviewApplications({repositoryRoot,packageRoot}:BuildContext){
  await buildOne(join(repositoryRoot,'packages/host/src/main.ts'),join(packageRoot,'app/runtime.js'),'bun');
  await buildOne(join(repositoryRoot,'scripts/preview-cli.ts'),join(packageRoot,'app/cli.js'),'bun');
  await buildOne(join(repositoryRoot,'scripts/packaged-studio.ts'),join(packageRoot,'app/studio.js'),'bun');
  await buildOne(join(repositoryRoot,'scripts/preview-install.ts'),join(packageRoot,'app/install.js'),'bun');
  await buildOne(join(repositoryRoot,'packages/editor/web/app.ts'),join(packageRoot,'share/studio/app.js'),'browser');
}

const defaultPreparePlugin=async({repositoryRoot}:{repositoryRoot:string})=>run([process.execPath,'run','streamdeck:plugin:check'],repositoryRoot);
const defaultInstallDependencies=async({repositoryRoot,appRoot}:InstallContext)=>{copy(join(repositoryRoot,'package.json'),join(appRoot,'package.json'));copy(join(repositoryRoot,'bun.lock'),join(appRoot,'bun.lock'));await run([process.execPath,'install','--production','--frozen-lockfile','--cwd',appRoot],repositoryRoot);};
const defaultArchive=async({sourceRoot,directoryName,archivePath}:ArchiveContext)=>run(['/usr/bin/tar','-czf',archivePath,'-C',sourceRoot,directoryName],sourceRoot);

export async function assemblePreview(options:PackageOptions={}):Promise<PackageResult>{
  const repositoryRoot=resolve(options.repositoryRoot??'.'),outputRoot=resolve(options.outputRoot??join(repositoryRoot,'dist')),temporaryRoot=resolve(options.tempRoot??tmpdir()),platform=options.platform??process.platform,arch=options.arch??process.arch;
  assertTarget(platform,arch);
  const gitCommit=options.gitCommit??(await Bun.$`git -C ${repositoryRoot} rev-parse HEAD`.quiet().text()).trim(),builtAt=options.builtAt??new Date().toISOString();
  if(!/^[a-f0-9]{40}$/.test(gitCommit))throw new Error('Invalid package Git commit');
  mkdirSync(temporaryRoot,{recursive:true});const staging=mkdtempSync(join(temporaryRoot,'streamhub-package-')),stagedRoot=join(staging,packageDirectory),stagedArchive=join(staging,`${packageDirectory}.tar.gz`);
  try{
    await (options.preparePlugin??defaultPreparePlugin)({repositoryRoot});
    mkdirSync(stagedRoot,{recursive:true});
    await (options.buildApplications??buildPreviewApplications)({repositoryRoot,packageRoot:stagedRoot});
    for(const [source,target] of [['README.md','README.md'],['DEVELOPMENT.md','DEVELOPMENT.md'],['packaging/install.sh','install.sh'],['packaging/uninstall.sh','uninstall.sh'],['packaging/bin/streamhub','bin/streamhub'],['packages/host/native/session-monitor.swift','app/native/session-monitor.swift']] as const)copy(join(repositoryRoot,source),join(stagedRoot,target));
    for(const file of ['index.html','style.css','icon-library.css','display-settings.css'])copy(join(repositoryRoot,'packages/editor/web',file),join(stagedRoot,'share/studio',file));
    const pluginSource=join(repositoryRoot,'packages/streamdeck-plugin/com.streamhub.studio.sdPlugin'),pluginTarget=join(stagedRoot,'share/streamdeck-plugin/com.streamhub.studio.sdPlugin');copy(pluginSource,pluginTarget);
    const pluginManifest=JSON.parse(readFileSync(join(pluginTarget,'manifest.json'),'utf8')) as {Version?:unknown};
    if(typeof pluginManifest.Version!=='string')throw new Error('Invalid bundled plugin manifest');
    writeFileSync(join(stagedRoot,'manifest.json'),JSON.stringify(createReleaseManifest({gitCommit,builtAt,pluginVersion:pluginManifest.Version}),null,2)+'\n');
    await (options.installDependencies??defaultInstallDependencies)({repositoryRoot,appRoot:join(stagedRoot,'app')});
    prune(stagedRoot);
    const leaked=relativeFiles(stagedRoot).find(path=>forbidden.test(path));if(leaked)throw new Error(`Forbidden package file: ${leaked}`);
    validateReleaseManifest(JSON.parse(readFileSync(join(stagedRoot,'manifest.json'),'utf8')));writeChecksums(stagedRoot);
    const verified=verifyChecksums(stagedRoot);if(!verified.valid)throw new Error('Package checksum verification failed');
    await (options.archive??defaultArchive)({sourceRoot:staging,directoryName:packageDirectory,archivePath:stagedArchive});
    mkdirSync(outputRoot,{recursive:true});const finalRoot=join(outputRoot,packageDirectory),finalArchive=join(outputRoot,`${packageDirectory}.tar.gz`),suffix=randomUUID(),rootBackup=`${finalRoot}.${suffix}.previous`,archiveBackup=`${finalArchive}.${suffix}.previous`;
    let rootBackedUp=false,archiveBackedUp=false;
    try{
      if(existsSync(finalRoot)){if(lstatSync(finalRoot).isSymbolicLink())throw new Error('Refusing linked package output');renameSync(finalRoot,rootBackup);rootBackedUp=true;}
      if(existsSync(finalArchive)){if(lstatSync(finalArchive).isSymbolicLink())throw new Error('Refusing linked archive output');renameSync(finalArchive,archiveBackup);archiveBackedUp=true;}
      renameSync(stagedRoot,finalRoot);renameSync(stagedArchive,finalArchive);
      if(rootBackedUp)rmSync(rootBackup,{recursive:true});if(archiveBackedUp)rmSync(archiveBackup);
    }catch(error){
      if(existsSync(finalRoot)&&rootBackedUp)rmSync(finalRoot,{recursive:true});if(existsSync(finalArchive)&&archiveBackedUp)rmSync(finalArchive);
      if(rootBackedUp&&existsSync(rootBackup))renameSync(rootBackup,finalRoot);if(archiveBackedUp&&existsSync(archiveBackup))renameSync(archiveBackup,finalArchive);throw error;
    }
    return{root:finalRoot,archive:finalArchive,archiveSha256:checksum(finalArchive),version:packageVersion,target:releaseTarget};
  }finally{if(existsSync(staging))rmSync(staging,{recursive:true});}
}

if(import.meta.main){const result=await assemblePreview();console.log(`Package: ${result.root}`);console.log(`Archive: ${result.archive}`);console.log(`Version: ${result.version}`);console.log(`Target: ${result.target}`);console.log(`SHA-256: ${result.archiveSha256}`);}
