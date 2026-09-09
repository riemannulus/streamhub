import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startEditorServer} from './server';
import {PageBoard} from '../streamdeck/pages';

const original = process.env.STREAMHUB_CONFIG;
let editor: ReturnType<typeof startEditorServer> | undefined;
let directory: string;
afterEach(async () => {
  await editor?.stop(); editor = undefined;
  if (original === undefined) delete process.env.STREAMHUB_CONFIG; else process.env.STREAMHUB_CONFIG = original;
  if (directory) rmSync(directory, {recursive:true,force:true});
});
const baseConfig = () => ({port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}},future:{keep:true}});
async function setup() {
  directory = mkdtempSync(join(tmpdir(),'streamhub-editor-'));
  process.env.STREAMHUB_CONFIG = join(directory,'config.json');
  writeFileSync(process.env.STREAMHUB_CONFIG, JSON.stringify(baseConfig()));
  writeFileSync(join(directory,'index.html'), '<html>Editor</html>');
  editor = startEditorServer({port:0,assetsDir:directory});
  const bootstrap = await (await fetch(`${editor.url}/api/bootstrap`)).json() as any;
  return {url:editor.url, bootstrap};
}
const save = (url:string, token:string, body:unknown, extra:Record<string,string> = {}) => fetch(`${url}/api/config`,{method:'POST',headers:{'Content-Type':'application/json','X-Streamhub-Editor':token,...extra},body:JSON.stringify(body)});

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
  expect(page.headers.get('Cache-Control')).toBe('no-store');
});

test('save requires capability and JSON, validates boards, detects conflicts and preserves settings',async () => {
  const {url,bootstrap} = await setup();
  const body = {board:bootstrap.board,version:bootstrap.version};
  expect((await save(url,'wrong',body)).status).toBe(403);
  expect((await save(url,bootstrap.token,body,{Origin:'https://attacker.example'})).status).toBe(403);
  expect((await save(url,bootstrap.token,body,{'Content-Type':'text/plain'})).status).toBe(415);
  expect((await save(url,bootstrap.token,{...body,board:{defaultPage:'missing',pages:[]}})).status).toBe(400);
  const badSource = structuredClone(bootstrap.board); badSource.pages[0].signals = {source:'unknown'};
  expect((await save(url,bootstrap.token,{...body,board:badSource})).status).toBe(400);
  expect((await save(url,bootstrap.token,{...body,version:'old'})).status).toBe(409);
  expect((await save(url,bootstrap.token,body,{Origin:url})).status).toBe(200);
  const config = JSON.parse(readFileSync(process.env.STREAMHUB_CONFIG!, 'utf8'));
  expect(config).toEqual({...baseConfig(),streamdeck:{enabled:false,board:bootstrap.board}});
  expect((await save(url,bootstrap.token,body)).status).toBe(409);
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

test('saving preserves enabled devices and refuses external configuration edits',async () => {
  const {url,bootstrap} = await setup();
  const file = process.env.STREAMHUB_CONFIG!;
  const external = {...baseConfig(),streamdeck:{enabled:true}};
  writeFileSync(file,JSON.stringify(external));
  expect((await save(url,bootstrap.token,{board:bootstrap.board,version:bootstrap.version})).status).toBe(409);
  const current = await (await fetch(`${url}/api/bootstrap`)).json() as any;
  expect((await save(url,current.token,{board:current.board,version:current.version})).status).toBe(200);
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({...external,streamdeck:{enabled:true,board:current.board}});
});

 test('default board keeps list pagination accessible on every outer page',async () => {
  const {bootstrap} = await setup();
  const board = new PageBoard(bootstrap.board);
  board.update(Array.from({length:16}, (_,index) => ({id:String(index),source:'demo',kind:'live' as const,level:'info' as const,label:String(index),revision:1,createdAt:1,updatedAt:1,freshness:'fresh' as const,press:{type:'open' as const,url:'https://example.com'}})));
  board.down(14); board.up(14);
  expect(board.page().index).toBe(1);
  board.down(12); board.up(12);
  expect(board.page().viewId).toBe('terminal');
  board.down(14); board.up(14);
  expect(board.page().index).toBe(1);
  const first = editor!.stop();
  expect(editor!.stop()).toBe(first);
  await first;
});
