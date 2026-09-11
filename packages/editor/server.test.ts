import {afterEach, expect, test} from 'bun:test';
import {mkdirSync,mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEditorServer} from './server';
import sharp from 'sharp';
import {IconPackCatalog} from './icon-packs';

const original = process.env.STREAMHUB_CONFIG;
let editor: ReturnType<typeof startEditorServer> | undefined;
let directory: string;
const extraDirectories:string[]=[];
afterEach(async () => {
  await editor?.stop(); editor = undefined;
  if (original === undefined) delete process.env.STREAMHUB_CONFIG; else process.env.STREAMHUB_CONFIG = original;
  if (directory) rmSync(directory, {recursive:true,force:true});
  extraDirectories.splice(0).forEach(path=>rmSync(path,{recursive:true,force:true}));
});
const baseConfig = () => ({port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}},future:{keep:true}});
async function setup(serverOptions:Omit<Parameters<typeof startEditorServer>[0],'port'|'assetsDir'>={},config:ReturnType<typeof baseConfig>=baseConfig()) {
  directory = mkdtempSync(join(tmpdir(),'streamhub-editor-'));
  process.env.STREAMHUB_CONFIG = join(directory,'config.json');
  writeFileSync(process.env.STREAMHUB_CONFIG, JSON.stringify(config));
  writeFileSync(join(directory,'index.html'), '<html>Editor</html>');
  editor = startEditorServer({port:0,assetsDir:directory,...serverOptions});
  const bootstrap = await (await fetch(`${editor.url}/api/bootstrap`)).json() as any;
  return {url:editor.url, bootstrap};
}

test('draft checks require editor capability and expose only generated replay reports',async()=>{
  const {url,bootstrap}=await setup();
  const payload={board:{defaultPage:'custom',pages:[{id:'custom',title:'Custom',signals:{}}]}};
  expect((await fetch(`${url}/api/check`,{method:'POST'})).status).toBe(403);
  const response=await fetch(`${url}/api/check`,{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':bootstrap.token},body:JSON.stringify(payload)});
  expect(response.status).toBe(200);
  const result=await response.json();expect(result.passed).toBe(true);
  const replay=await fetch(`${url}${result.report}`);expect(replay.status).toBe(200);
  expect(replay.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts');
  expect((await fetch(`${url}/reports/${'0'.repeat(32)}`)).status).toBe(404);
});

test('bootstrap is credential-free and cannot be read through foreign hosts or origins', async () => {
  const {url,bootstrap} = await setup();
  expect(bootstrap.sources).toEqual(['demo']);
  expect(JSON.stringify(bootstrap)).not.toContain(baseConfig().adminToken);
  expect(JSON.stringify(bootstrap)).not.toContain(baseConfig().sources.demo.token);
  expect(bootstrap.token).toHaveLength(64);
  const cases: Record<string,string>[] = [{host:'attacker.example'},{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'}];
  for (const headers of cases) {
    const response = await fetch(`${url}/api/bootstrap`,{headers});
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
  const page = await fetch(url);
  expect(page.status).toBe(200);
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('Content-Security-Policy')).toContain("img-src 'self' data: blob:");
  expect(page.headers.get('Cache-Control')).toBe('no-store');
});

test('legacy board configuration endpoint is retired',async () => {
  const {url,bootstrap} = await setup();
  expect((await fetch(`${url}/api/config`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:'{}'})).status).toBe(404);
  expect(bootstrap).not.toHaveProperty('board');expect(bootstrap).not.toHaveProperty('version');
});

test('websocket requires exact origin and capability and shuts down with the editor',async () => {
  const {url,bootstrap} = await setup();
  const endpoint = url.replace('http:','ws:')+'/api/simulator';
  const Client = WebSocket as unknown as {new(url:string, options:Bun.WebSocketOptions): WebSocket};
  const rejected = new Client(endpoint,{protocols:['streamhub',bootstrap.token],headers:{Origin:'https://attacker.example'}});
  await new Promise<void>((resolve,reject) => { rejected.onopen = () => reject(new Error('Foreign origin accepted')); rejected.onerror = () => resolve(); });
  const socket = new Client(endpoint,{protocols:['streamhub',bootstrap.token],headers:{Origin:url}});
  await new Promise<void>((resolve,reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
  expect(socket.protocol).toBe('streamhub');
  const error = new Promise<any>(resolve => { socket.onmessage = event => { const value = JSON.parse(String(event.data)); if(value.type==='error') resolve(value); }; });
  socket.send(JSON.stringify({type:'invalid'}));
  expect((await error).message).toBeTruthy();
  const closed = new Promise<void>(resolve => {socket.onclose=()=>resolve();});
  await editor!.stop(); await closed;
});

test('v3 Studio uploads assets, autosaves a draft and applies offline without exposing host credentials',async()=>{
  const {url,bootstrap}=await setup();const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
  const uploaded=await fetch(`${url}/api/assets`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'image/png'},body:new Blob([new Uint8Array(png)])});expect(uploaded.status).toBe(200);const {assetId}=await uploaded.json() as any;
  const document=structuredClone(bootstrap.snapshot.document);document.pages[0].appearance={background:{assetId,fit:'cover'}};
  expect((await fetch(`${url}/api/draft`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({document})})).status).toBe(200);
  const applied=await fetch(`${url}/api/apply`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({document,expectedVersion:bootstrap.snapshot.version})});expect(applied.status).toBe(200);expect((await applied.json() as any).runtimeStatus.connected).toBe(false);
  expect((await fetch(`${url}/api/assets/${assetId}`)).headers.get('Content-Type')).toBe('image/png');expect(JSON.stringify(bootstrap)).not.toContain(baseConfig().adminToken);
});

test('button preview requires capability and returns shared 72px PNG composition',async()=>{
  const {url,bootstrap}=await setup(),png=await sharp({create:{width:8,height:8,channels:4,background:'blue'}}).png().toBuffer();
  const uploaded=await fetch(`${url}/api/assets`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'image/png'},body:new Blob([new Uint8Array(png)])}),{assetId}=await uploaded.json() as any;
  const payload={index:0,pageAppearance:{color:'#112233'},appearance:{contentMode:'icon-only',icon:{assetId,fit:'contain'}}};
  expect((await fetch(`${url}/api/preview/button`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status).toBe(403);
  const response=await fetch(`${url}/api/preview/button`,{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':bootstrap.token},body:JSON.stringify(payload)});
  expect(response.status).toBe(200);expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(await sharp(await response.arrayBuffer()).metadata()).toMatchObject({width:72,height:72});
});

test('catalog and native picker APIs expose only bounded local choices',async()=>{
  const picks:string[]=[],config={...baseConfig(),actions:{build:{exec:['/usr/bin/true','{target}'],args:{target:'[a-z]+'},sources:['demo']}}};
  const {url,bootstrap}=await setup({appCatalog:{apps:async()=>[{name:'Firefox',bundleId:'org.mozilla.firefox',path:'/Applications/Firefox.app'}]},pickPath:async(kind:'file'|'folder')=>{picks.push(kind);return kind==='file'?{path:'/tmp/file.txt'}:{cancelled:true};}},config);
  const headers={'X-Streamhub-Editor':bootstrap.token};
  expect(await (await fetch(`${url}/api/catalog/apps`,{headers})).json()).toEqual([{id:'bundle:org.mozilla.firefox',name:'Firefox',bundleId:'org.mozilla.firefox',path:'/Applications/Firefox.app'}]);
  expect(await (await fetch(`${url}/api/catalog/actions`,{headers})).json()).toEqual([{name:'build',args:['target']}]);
  expect(JSON.stringify(await (await fetch(`${url}/api/catalog/actions`,{headers})).json())).not.toContain(config.adminToken);
  expect((await fetch(`${url}/api/picker/path`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({kind:'file'})})).status).toBe(403);
  const picked=await fetch(`${url}/api/picker/path`,{method:'POST',headers:{...headers,Origin:url,'Content-Type':'application/json'},body:JSON.stringify({kind:'file'})});expect(await picked.json()).toEqual({path:'/tmp/file.txt'});
  const cancelled=await fetch(`${url}/api/picker/path`,{method:'POST',headers:{...headers,Origin:url,'Content-Type':'application/json'},body:JSON.stringify({kind:'folder'})});expect(await cancelled.json()).toEqual({cancelled:true});
  const injected=await fetch(`${url}/api/picker/path`,{method:'POST',headers:{...headers,Origin:url,'Content-Type':'application/json'},body:JSON.stringify({kind:'file',path:'/etc/passwd'})});expect(injected.status).toBe(400);
  expect(picks).toEqual(['file','folder']);
});

test('app icon API resolves an opaque catalog id and stores a normalized Studio asset',async()=>{
  const png=await sharp({create:{width:32,height:32,channels:4,background:{r:255,g:80,b:20,alpha:0.7}}}).png().toBuffer();
  const app={id:'bundle:org.mozilla.firefox',name:'Firefox',bundleId:'org.mozilla.firefox',path:'/Applications/Firefox.app'};
  const reads:string[]=[];
  const {url,bootstrap}=await setup({
    appCatalog:{apps:async()=>[app]},
    appIcons:{read:async(selected:{id:string})=>{reads.push(selected.id);return new Uint8Array(png);}},
  } as never);
  const response=await fetch(`${url}/api/catalog/apps/icon`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({appId:app.id})});
  expect(response.status).toBe(200);
  const {assetId}=await response.json() as {assetId:string};
  expect(assetId).toMatch(/^[a-f0-9]{64}$/);
  expect(reads).toEqual([app.id]);
  expect(await sharp(await (await fetch(`${url}/api/assets/${assetId}`)).arrayBuffer()).metadata()).toMatchObject({format:'png',width:32,height:32});
  expect((await fetch(`${url}/api/catalog/apps/icon`,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({appId:'bundle:missing'})})).status).toBe(404);
});

test('icon pack APIs search, preview and import an installed icon without exposing its path',async()=>{
  const root=mkdtempSync(join(tmpdir(),'streamhub-editor-icon-pack-'));extraDirectories.push(root);const pack=join(root,'com.example.media.sdIconPack');mkdirSync(join(pack,'icons'),{recursive:true});
  writeFileSync(join(pack,'manifest.json'),JSON.stringify({Name:'Media',Version:'1.0.0',Author:'Example',Icon:'icon.png'}));
  writeFileSync(join(pack,'icons.json'),JSON.stringify([{path:'play.svg',name:'Play',tags:['media','재생']}]))
  writeFileSync(join(pack,'icons','play.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="#44cc88"/></svg>');
  const {url,bootstrap}=await setup({iconPacks:new IconPackCatalog({roots:[root]})}),headers={'X-Streamhub-Editor':bootstrap.token};
  expect((await fetch(`${url}/api/icon-packs`)).status).toBe(403);
  const packs=await (await fetch(`${url}/api/icon-packs`,{headers})).json() as any[];expect(packs).toHaveLength(1);expect(JSON.stringify(packs)).not.toContain(root);
  const icons=await (await fetch(`${url}/api/icon-packs/${packs[0].id}/icons?q=${encodeURIComponent('재생')}`,{headers})).json() as any[];expect(icons).toEqual([{id:expect.stringMatching(/^[a-f0-9]{64}$/),name:'Play',tags:['media','재생'],animated:false}]);
  const preview=await fetch(`${url}/api/icon-packs/${packs[0].id}/icons/${icons[0].id}/preview`,{headers});expect(preview.status).toBe(200);expect(preview.headers.get('Content-Type')).toBe('image/png');expect(await sharp(await preview.arrayBuffer()).metadata()).toMatchObject({width:144,height:144});
  const imported=await fetch(`${url}/api/icon-packs/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({packId:packs[0].id,iconId:icons[0].id})});expect(imported.status).toBe(200);const {assetId}=await imported.json() as {assetId:string};expect((await fetch(`${url}/api/assets/${assetId}`)).status).toBe(200);
  expect((await fetch(`${url}/api/icon-packs/import`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({packId:'../bad',iconId:icons[0].id})})).status).toBe(400);
});

test('display mode save is authenticated, versioned, sanitized, and restart gated',async()=>{
  const plugin={port:31417,tokenFile:'/private/plugin-token'},config={...baseConfig(),display:{mode:'plugin' as const,plugin},streamdeckPlugin:{enabled:true,...plugin}};
  const {url,bootstrap}=await setup({},config);
  expect(bootstrap.display).toMatchObject({configuredMode:'plugin',activeMode:'off',state:'unavailable',restartRequired:true});
  expect(JSON.stringify(bootstrap.display)).not.toContain('tokenFile');
  const endpoint=`${url}/api/display-mode`,body={mode:'hid',expectedVersion:bootstrap.configVersion};
  expect((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status).toBe(403);
  expect((await fetch(endpoint,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'text/plain'},body:JSON.stringify(body)})).status).toBe(415);
  expect((await fetch(endpoint,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({...body,mode:'automatic'})})).status).toBe(400);
  expect((await fetch(endpoint,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify({...body,expectedVersion:'stale'})})).status).toBe(409);
  const response=await fetch(endpoint,{method:'POST',headers:{'X-Streamhub-Editor':bootstrap.token,'Content-Type':'application/json'},body:JSON.stringify(body)});expect(response.status).toBe(200);const saved=await response.json() as any;
  expect(saved.display).toEqual({configuredMode:'hid',activeMode:'off',state:'unavailable',restartRequired:true,message:'Runtime이 실행 중이 아닙니다.'});
  expect(JSON.stringify(saved)).not.toContain('tokenFile');
  const file=JSON.parse(readFileSync(process.env.STREAMHUB_CONFIG!,'utf8'));expect(file.display).toEqual({mode:'hid',plugin});expect(file).not.toHaveProperty('streamdeck');expect(file).not.toHaveProperty('streamdeckPlugin');
});
