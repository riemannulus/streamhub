import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRuntimeDaemon,type RuntimeDaemon} from '../packages/release/daemon';
import {installPreview,parseInstallerArguments,resolveInstallerPaths,uninstallPreview} from '../packages/release/install';
import {launchAgentPaths} from '../packages/release/launch-agent';
import {packageVersion} from '../packages/release/version';

export type PreviewInstallerOptions={
  argv?:string[];
  packageRoot?:string;
  home?:string;
  commandPath?:string;
  daemonFor?:(packageRoot:string)=>RuntimeDaemon;
  write?:(value:string)=>void;
};

function definitionPresent(path:string):boolean{
  try{lstatSync(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

export async function runPreviewInstaller(options:PreviewInstallerOptions={}):Promise<void>{
  const args=parseInstallerArguments(options.argv??process.argv.slice(2));
  const packageRoot=resolve(options.packageRoot??process.env.STREAMHUB_PACKAGE_ROOT??'.');
  const home=options.home??homedir(),prefix=args.prefix;
  const installedPackage=existsSync(join(packageRoot,'.streamhub-preview-install.json'));
  const {applicationRoot,binDirectory}=resolveInstallerPaths({arguments:args,packageRoot,home,commandPath:options.commandPath??process.env.STREAMHUB_COMMAND_PATH,installedPackage});
  const installedRoot=join(applicationRoot,'app',packageVersion);
  const daemonFor=options.daemonFor??((root:string)=>{
    const getuid=process.getuid;if(!getuid)throw new Error('Runtime daemon requires a user account');
    return createRuntimeDaemon({home,uid:getuid(),bunPath:process.execPath,packageRoot:root});
  });
  const write=options.write??(value=>console.log(value));

  if(prefix&&args.operation==='install'&&existsSync(prefix)){
    const info=lstatSync(prefix);
    if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Refusing a linked or non-directory install prefix');
    if(readdirSync(prefix).length>0&&!existsSync(join(installedRoot,'.streamhub-preview-install.json')))throw new Error('Refusing an unmarked nonempty install prefix');
  }

  if(args.operation==='install'){
    const expectedDaemon=daemonFor(installedRoot);
    const service=definitionPresent(expectedDaemon.paths.plistPath)?{
      inspect:async({targetRoot}:{targetRoot:string})=>{await daemonFor(targetRoot).status();},
      prepare:async({currentRoot}:{currentRoot?:string})=>{
        const daemon=daemonFor(currentRoot??installedRoot),status=await daemon.status();
        if(status.enabled)await daemon.disable();
        return{wasEnabled:status.enabled};
      },
      activate:async(state:{wasEnabled:boolean},result:{installRoot:string})=>{if(state.wasEnabled)await daemonFor(result.installRoot).enable();},
      rollback:async(state:{wasEnabled:boolean},{restoredRoot}:{restoredRoot?:string})=>{
        if(!state.wasEnabled)return;
        if(!restoredRoot)throw new Error('Unable to restore Streamhub runtime service without its package');
        await daemonFor(restoredRoot).enable();
      },
    }:undefined;
    const result=await installPreview({packageRoot,applicationRoot,binDirectory,...(service?{service}:{})});
    write(`Streamhub ${packageVersion} installed`);
    write(`Command: ${result.commandPath}`);
    write(`Data: ${result.dataRoot} (preserved on uninstall)`);
  }else{
    const selectedRoot=installedPackage?packageRoot:installedRoot,getuid=process.getuid;
    if(!getuid)throw new Error('Runtime daemon requires a user account');
    const plistPath=launchAgentPaths({home,uid:getuid(),bunPath:process.execPath,packageRoot:selectedRoot}).plistPath;
    const beforeRemove=args.prefix!==undefined&&!definitionPresent(plistPath)?undefined:async()=>{await daemonFor(selectedRoot).disable();};
    const result=await uninstallPreview({packageRoot:selectedRoot,applicationRoot,binDirectory,...(beforeRemove?{beforeRemove}:{})});
    write(result.removed?`Streamhub ${packageVersion} removed`:`Streamhub ${packageVersion} is not installed`);
    write(`Data preserved: ${result.dataRoot}`);
  }
}

if(import.meta.main)await runPreviewInstaller();
