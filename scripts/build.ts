import {existsSync,mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {buildPreviewApplications} from './package';

const repositoryRoot=resolve('.'),packageRoot=resolve('dist/build');
if(existsSync(packageRoot))rmSync(packageRoot,{recursive:true});
mkdirSync(packageRoot,{recursive:true});
await buildPreviewApplications({repositoryRoot,packageRoot});
console.log(`Built Runtime, CLI, installer, and Studio assets in ${packageRoot}`);
