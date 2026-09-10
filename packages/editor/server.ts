import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import {dirname,join} from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import { readConfig, updateConfig, validateConfig, type Config } from '../host/src/config';
import { type PageConfig } from '../streamdeck/pages';
import { SimulatorSession } from './simulator';
import { checkDraft } from '../simulator/draft-check';
import { validateSimulatorBoard } from './simulator';
import {StudioRepository,StudioVersionConflictError} from '../studio/repository';
import {validateStudioDocument} from '../studio/document';
import {streamDeckClassicGeometry} from '../presentation/geometry';

const LIMIT = 9 * 1024 * 1024;
const ASSETS = new Map([['/','index.html'],['/app.js','app.js'],['/style.css','style.css']]);
const version = (config: Config) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
function boardOf(config: Config): PageConfig {
  return config.streamdeck?.board ?? {
    defaultPage: 'home', transition: 'fade', durationMs: 250,
    pages: [
      { id: 'home', title: 'Home', signals: {}, buttons: [{index: 12, type: 'page', pageId: 'terminal', label: 'Terminal'}, {index: 13, type: 'auto', label: 'Auto'}] },
      { id: 'terminal', title: 'Terminal', match: {appBundleId: 'com.apple.Terminal'}, signals: Object.keys(config.sources).length ? {source: Object.keys(config.sources)[0]} : {}, buttons: [{index: 13, type: 'auto', label: 'Auto'}, {index: 12, type: 'page', pageId: 'home', label: 'Home'}] },
    ],
  };
}
class Conflict extends Error {}
type Client = {session?: SimulatorSession};

/** Local editor capabilities are separate from host/source credentials. No real hardware or actions are opened. */
export function startEditorServer(options: {port?: number; assetsDir?: string} = {}) {
  readConfig(true);
  const studioDirectory=join(dirname(process.env.STREAMHUB_CONFIG??resolve('.streamhub/config.json')),'studio');
  const repository=new StudioRepository(studioDirectory);
  const draftPath=join(studioDirectory,'draft.json');
  const token = randomBytes(32).toString('hex');
  const assets = resolve(options.assetsDir ?? '.streamhub/editor');
  const clients = new Set<Bun.ServerWebSocket<Client>>();
  const reports=new Map<string,string>();
  let checking:Promise<unknown>|undefined;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers});
  const server = Bun.serve<Client>({
    hostname: '127.0.0.1', port: options.port ?? 31416, maxRequestBodySize: LIMIT,
    async fetch(request, server) {
      const origin = `http://127.0.0.1:${server.port}`;
      const url = new URL(request.url);
      if (request.headers.get('host') !== `127.0.0.1:${server.port}`) return json({error:'Forbidden'}, 403);
      if (request.headers.has('origin') && request.headers.get('origin') !== origin) return json({error:'Forbidden'}, 403);
      if (url.pathname.startsWith('/api/') && request.headers.get('sec-fetch-site') === 'cross-site') return json({error:'Forbidden'}, 403);
      const report=/^\/reports\/([a-f0-9]{32})$/.exec(url.pathname);
      if(report&&request.method==='GET'){
        const path=reports.get(report[1]);
        if(!path)return json({error:'Not found'},404);
        return new Response(Bun.file(path),{headers:{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; sandbox allow-scripts"}});
      }
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        try { const config = readConfig(),snapshot=repository.snapshot();let runtimeStatus:unknown={connected:false,message:'Runtime이 실행 중이 아닙니다.'};try{const response=await fetch(`http://127.0.0.1:${config.port}/v1/studio`,{headers:{Authorization:`Bearer ${config.adminToken}`}});if(response.ok){const live=await response.json() as any;runtimeStatus=live.runtimeStatus;snapshot.document=live.document;snapshot.version=live.version;}}catch{}let draft;try{draft=validateStudioDocument(JSON.parse(readFileSync(draftPath,'utf8')));}catch{}return json({token, board: boardOf(config), sources: Object.keys(config.sources), actions:Object.entries(config.actions??{}).map(([name,definition])=>({name,args:Object.keys(definition.args)})), version: version(config),snapshot,draft,runtimeStatus,geometry:streamDeckClassicGeometry}); }
        catch { return json({error:'Could not read configuration'}, 500); }
      }
      const visualAsset=/^\/api\/assets\/([a-f0-9]{64})$/.exec(url.pathname);if(visualAsset&&request.method==='GET'){try{const bytes=await repository.assets.read(visualAsset[1]);return new Response(new Blob([new Uint8Array(bytes)]),{headers:{...headers,'Content-Type':'image/png'}});}catch{return json({error:'Not found'},404);}}
      if (url.pathname === '/api/simulator') {
        const protocols = request.headers.get('sec-websocket-protocol')?.split(',').map(value => value.trim()) ?? [];
        if (request.method !== 'GET' || request.headers.get('origin') !== origin || protocols.length !== 2 || protocols[0] !== 'streamhub' || protocols[1] !== token) return json({error:'Forbidden'},403);
        if (server.upgrade(request, {data: {}, headers: {...headers, 'Sec-WebSocket-Protocol':'streamhub'}})) return;
        return json({error:'WebSocket upgrade required'},400);
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.get('x-streamhub-editor') !== token) return json({error:'Forbidden'},403);
        if(url.pathname==='/api/assets'&&request.method==='POST'){
          try{const bytes=new Uint8Array(await request.arrayBuffer());return json({assetId:await repository.putAsset(bytes)});}catch(error){return json({error:error instanceof Error?error.message:'이미지를 저장하지 못했습니다.'},400);}
        }
        if(url.pathname==='/api/draft'&&request.method==='POST'){
          if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);try{const payload=await request.json() as any,document=validateStudioDocument(payload.document,{sources:Object.keys(readConfig().sources)});writeFileSync(draftPath,JSON.stringify(document,null,2)+'\n',{mode:0o600});return json({document});}catch(error){return json({error:error instanceof Error?error.message:'초안을 저장하지 못했습니다.'},400);}
        }
        if(url.pathname==='/api/apply'&&request.method==='POST'){
          if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);try{const payload=await request.json() as any,config=readConfig(),document=validateStudioDocument(payload.document,{sources:Object.keys(config.sources)});if(typeof payload.expectedVersion!=='string')return json({error:'Invalid expectedVersion'},400);try{const response=await fetch(`http://127.0.0.1:${config.port}/v1/studio/apply`,{method:'POST',headers:{Authorization:`Bearer ${config.adminToken}`,'Content-Type':'application/json'},body:JSON.stringify({document,expectedVersion:payload.expectedVersion})});if(response.ok)return json({...await response.json() as object,runtimeStatus:{connected:true}});if(response.status===409)return json({error:'다른 곳에서 변경되었습니다. 다시 불러오세요.'},409);}catch{}const saved=repository.apply(document,payload.expectedVersion);return json({...saved,runtimeStatus:{connected:false,message:'Runtime이 꺼져 있어 다음 시작 때 적용됩니다.'}});}catch(error){return error instanceof StudioVersionConflictError?json({error:error.message},409):json({error:error instanceof Error?error.message:'적용하지 못했습니다.'},400);}
        }
        if(url.pathname==='/api/check'&&request.method==='POST'){
          if(checking)return json({error:'A check is already running'},409);
          if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return json({error:'JSON required'},415);
          let owned:Promise<unknown>|undefined;
          try{
            const payload=await request.json(),sources=Object.keys(readConfig().sources),board=validateSimulatorBoard(payload.board,sources);
            if(checking||stopped)return json({error:'A check is already running or editor stopped'},409);
            const id=randomBytes(16).toString('hex'),directory=resolve('.streamhub/editor-checks',id);
            checking=owned=checkDraft(board,sources,directory);
            const result=await checking;
            reports.set(id,resolve(directory,'replay.html'));
            return json({...result as object,report:`/reports/${id}`});
          }catch{return json({error:'Draft check failed'},400);}finally{if(owned&&checking===owned)checking=undefined;}
        }
        if (url.pathname === '/api/config' && request.method === 'POST') {
          if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({error:'JSON required'},415);
          try {
            const raw = await request.text();
            if (Buffer.byteLength(raw) > LIMIT) return json({error:'Request too large'},413);
            const payload = JSON.parse(raw);
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.version !== 'string' || !payload.board || Object.keys(payload).some(key => !['version','board'].includes(key))) return json({error:'Invalid configuration request'},400);
            const saved = updateConfig(current => {
              if (version(current) !== payload.version) throw new Conflict();
              return validateConfig({...current, streamdeck: {...current.streamdeck, enabled: current.streamdeck?.enabled ?? false, board: payload.board}});
            });
            return json({board: boardOf(saved), version: version(saved)});
          } catch (error) {
            return error instanceof Conflict ? json({error:'Configuration changed. Reload before saving.'},409) : json({error:'Configuration could not be saved. Check the page settings.'},400);
          }
        }
        return json({error:'Not found'},404);
      }
      if (request.method !== 'GET') return json({error:'Not found'},404);
      const filename = ASSETS.get(url.pathname);
      if (!filename) return json({error:'Not found'},404);
      const file = Bun.file(resolve(assets,filename));
      if (!(await file.exists())) return json({error:'Editor assets are missing. Run bun run editor.'},503);
      return new Response(file,{headers});
    },
    websocket: {
      maxPayloadLength: LIMIT,
      open(socket) {
        if (stopped) { socket.close(); return; }
        clients.add(socket);
        try {
          const config = readConfig();
          socket.data.session = new SimulatorSession(boardOf(config), Object.keys(config.sources), event => {
            if (socket.readyState === 1) socket.send(JSON.stringify(event));
          });
        } catch { socket.send(JSON.stringify({type:'error',message:'Could not start simulator'})); socket.close(1011); }
      },
      async message(socket, message) {
        try {
          if (typeof message !== 'string') throw new Error();
          await socket.data.session?.command(JSON.parse(message));
        } catch { socket.send(JSON.stringify({type:'error',message:'Invalid simulator command'})); }
      },
      close(socket) { clients.delete(socket); void socket.data.session?.stop(); },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      stopping = (async () => {
      const pending = [...clients].map(socket => { socket.close(1001,'Editor stopped'); return socket.data.session?.stop(); });
      clients.clear();
      await Promise.allSettled(pending);
      await checking?.catch(()=>{});
      await server.stop(true);
      })();
      return stopping;
    },
  };
}
