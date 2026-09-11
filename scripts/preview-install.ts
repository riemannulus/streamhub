import {existsSync,lstatSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {installPreview,parseInstallerArguments,resolveInstallerPaths,uninstallPreview} from '../packages/release/install';
import {packageVersion} from '../packages/release/version';

const args=parseInstallerArguments(process.argv.slice(2));
const packageRoot=resolve(process.env.STREAMHUB_PACKAGE_ROOT??'.');
const prefix=args.prefix;
const installedPackage=existsSync(join(packageRoot,'.streamhub-preview-install.json'));
const {applicationRoot,binDirectory}=resolveInstallerPaths({arguments:args,packageRoot,home:homedir(),commandPath:process.env.STREAMHUB_COMMAND_PATH,installedPackage});
const installedRoot=join(applicationRoot,'app',packageVersion);

if(prefix&&args.operation==='install'&&existsSync(prefix)){
  const info=lstatSync(prefix);
  if(info.isSymbolicLink()||!info.isDirectory())throw new Error('Refusing a linked or non-directory install prefix');
  if(readdirSync(prefix).length>0&&!existsSync(join(installedRoot,'.streamhub-preview-install.json')))throw new Error('Refusing an unmarked nonempty install prefix');
}

if(args.operation==='install'){
  const result=await installPreview({packageRoot,applicationRoot,binDirectory});
  console.log(`Streamhub ${packageVersion} installed`);
  console.log(`Command: ${result.commandPath}`);
  console.log(`Data: ${result.dataRoot} (preserved on uninstall)`);
}else{
  const selectedRoot=installedPackage?packageRoot:installedRoot;
  const result=await uninstallPreview({packageRoot:selectedRoot,applicationRoot,binDirectory});
  console.log(result.removed?`Streamhub ${packageVersion} removed`:`Streamhub ${packageVersion} is not installed`);
  console.log(`Data preserved: ${result.dataRoot}`);
}
