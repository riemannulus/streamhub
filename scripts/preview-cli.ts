import {createInterface} from 'node:readline/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {readConfig} from '../packages/host/src/config';
import {main,sanitizeRuntimeStatus} from '../packages/release/cli';
import {setupDisplayMode} from '../packages/release/setup';
import {packageVersion} from '../packages/release/version';

const packageRoot=resolve(process.env.STREAMHUB_PACKAGE_ROOT??'.');if(!isAbsolute(packageRoot))throw new Error('Invalid package root');
const applicationSupport=join(homedir(),'Library','Application Support');
process.env.STREAMHUB_CONFIG??=join(applicationSupport,'Streamhub','data','config.json');
const runChild=async(entry:string,args:string[])=>{const child=Bun.spawn([process.execPath,entry,...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit',env:process.env});return await child.exited;};
const chooseMode=async()=>{const input=createInterface({input:process.stdin,output:process.stdout});try{const answer=(await input.question('연결 방식 선택 (1: HID, 2: Plugin): ')).trim();if(answer==='1'||answer.toLowerCase()==='hid')return'hid' as const;if(answer==='2'||answer.toLowerCase()==='plugin')return'plugin' as const;throw new Error('HID 또는 Plugin을 선택하세요.');}finally{input.close();}};
const status=async()=>{const config=readConfig(true);try{const response=await fetch(`http://127.0.0.1:${config.port}/v1/state`,{headers:{authorization:`Bearer ${config.adminToken}`},signal:AbortSignal.timeout(1000)});if(!response.ok)throw new Error();const body=await response.json() as {display?:unknown};return sanitizeRuntimeStatus(config.display.mode,body.display);}catch{return sanitizeRuntimeStatus(config.display.mode,undefined);}};
const code=await main(process.argv.slice(2),{chooseMode,setup:mode=>setupDisplayMode({mode,packageRoot,applicationSupport}),runChild,status,uninstall:()=>runChild(join(packageRoot,'app','install.js'),['uninstall']),write:value=>console.log(value),runtimeEntry:join(packageRoot,'app','runtime.js'),studioEntry:join(packageRoot,'app','studio.js'),version:packageVersion});
process.exitCode=code;
