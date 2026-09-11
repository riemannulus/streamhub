import {isAbsolute,join,resolve} from 'node:path';
import {startEditorServer} from '../packages/editor/server';

type Options={assetsDir:string;port?:number;open:boolean;openBrowser?:(url:string)=>Promise<void>};
const openDefaultBrowser=async(url:string)=>{const child=Bun.spawn(['/usr/bin/open',url],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});if(await child.exited!==0)throw new Error('브라우저를 열지 못했습니다.');};
export async function startPackagedStudio(options:Options){
  const assetsDir=resolve(options.assetsDir);if(!isAbsolute(assetsDir))throw new Error('Invalid Studio asset path');const editor=startEditorServer({assetsDir,...(options.port===undefined?{}:{port:options.port})});
  if(options.open)try{await(options.openBrowser??openDefaultBrowser)(editor.url);}catch{console.error(`브라우저에서 ${editor.url} 을 여세요.`);}
  return editor;
}

if(import.meta.main){
  if(process.argv.length>3||(process.argv[2]!==undefined&&process.argv[2]!=='--no-open')){console.error('Usage: streamhub studio [--no-open]');process.exit(2);}
  const root=resolve(process.env.STREAMHUB_PACKAGE_ROOT??'.'),editor=await startPackagedStudio({assetsDir:join(root,'share','studio'),open:process.argv[2]!=='--no-open'});console.log(`Streamhub Studio: ${editor.url}`);
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await editor.stop();process.exit(0);};process.on('SIGINT',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
}
