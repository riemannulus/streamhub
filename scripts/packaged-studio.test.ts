import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPackagedStudio} from './packaged-studio';

const cleanup:Array<()=>Promise<void>|void>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
test('packaged Studio serves prebuilt assets and opens its exact loopback URL once',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub packaged studio ')),assets=join(root,'assets'),config=join(root,'config.json');mkdirSync(assets);
  for(const file of ['index.html','app.js','style.css','icon-library.css','display-settings.css'])writeFileSync(join(assets,file),file==='index.html'?'<h1>Preview Studio</h1>':'');
  writeFileSync(config,JSON.stringify({port:31415,adminToken:'a'.repeat(64),sources:{demo:{token:'b'.repeat(64)}},display:{mode:'off'}}));const previous=process.env.STREAMHUB_CONFIG;process.env.STREAMHUB_CONFIG=config;
  const opened:string[]=[];const studio=await startPackagedStudio({assetsDir:assets,port:0,open:true,openBrowser:async url=>{opened.push(url);}});cleanup.push(async()=>{await studio.stop();process.env.STREAMHUB_CONFIG=previous;rmSync(root,{recursive:true,force:true});});
  expect(opened).toEqual([studio.url]);expect(await (await fetch(studio.url)).text()).toBe('<h1>Preview Studio</h1>');
});

test('packaged Studio no-open mode never invokes the browser',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-studio-')),assets=join(root,'assets'),config=join(root,'config.json');mkdirSync(assets);writeFileSync(join(assets,'index.html'),'ok');writeFileSync(config,JSON.stringify({port:31415,adminToken:'a'.repeat(64),sources:{demo:{token:'b'.repeat(64)}},display:{mode:'off'}}));const previous=process.env.STREAMHUB_CONFIG;process.env.STREAMHUB_CONFIG=config;
  let opened=0;const studio=await startPackagedStudio({assetsDir:assets,port:0,open:false,openBrowser:async()=>{opened++;}});cleanup.push(async()=>{await studio.stop();process.env.STREAMHUB_CONFIG=previous;rmSync(root,{recursive:true,force:true});});expect(opened).toBe(0);
});
