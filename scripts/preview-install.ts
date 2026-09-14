import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {installPreview,parseInstallerArguments,resolveInstallerPaths,uninstallPreview} from '../packages/release/install';
import {createRuntimeDaemon} from '../packages/release/daemon';
import {packageVersion} from '../packages/release/version';

const args=parseInstallerArguments(process.argv.slice(2));
const packageRoot=resolve(process.env.STREAMHUB_PACKAGE_ROOT??'.');
const prefix=args.prefix;
const installedPackage=existsSync(join(packageRoot,'.streamhub-preview-install.json'));
const {applicationRoot,binDirectory}=resolveInstallerPaths({arguments:args,packageRoot,home:homedir(),commandPath:process.env.STREAMHUB_COMMAND_PATH,installedPackage});
const installedRoot=join(applicationRoot,'app',packageVersion);
const daemonFor=(root:string)=>{
  const getuid=process.getuid;if(!getuid)throw new Error('Runtime daemon requires a user account');
  return createRuntimeDaemon({home:homedir(),uid:getuid(),bunPath:process.execPath,packageRoot:root});
};

if(prefix&&args.operation==='install'&&existsSync(prefix)){
  const info=lstatSync(prefix);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Refusing a linked or non-directory install prefix');
  if(readdirSync(prefix).length>0&&!existsSync(join(installedRoot,'.streamhub-preview-install.json')))throw new Error('Refusing an unmarked nonempty install prefix');
}

if(args.operation==='install'){
  const service=existsSync(join(installedRoot,'.streamhub-preview-install.json'))?{
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
  console.log(`Streamhub ${packageVersion} installed`);
  console.log(`Command: ${result.commandPath}`);
  console.log(`Data: ${result.dataRoot} (preserved on uninstall)`);
}else{
  const selectedRoot=installedPackage?packageRoot:installedRoot;
  const result=await uninstallPreview({packageRoot:selectedRoot,applicationRoot,binDirectory,beforeRemove:async()=>{await daemonFor(selectedRoot).disable();}});
  console.log(result.removed?`Streamhub ${packageVersion} removed`:`Streamhub ${packageVersion} is not installed`);
  console.log(`Data preserved: ${result.dataRoot}`);
}
