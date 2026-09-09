import { timingSafeEqual } from 'node:crypto';
import { SignalStore } from './store';
import { ActionRegistry } from './actions';
import { exact, HttpError, object, parseLive, readJson, text } from './validation';
import { validateAuthConfig, type SourceConfig } from './config';
export type { SourceConfig } from './config';
export type ServerOptions = { store: SignalStore; port?: number; adminToken: string; sources: Record<string, SourceConfig>; actions?: ActionRegistry; health?: () => unknown; display?:()=>unknown };
function authorize(request: Request, token?: string) {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!token || Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new HttpError(401, 'Unauthorized');
}
export function startServer(options: ServerOptions) {
  const { store } = options;
  const actions = options.actions ?? new ActionRegistry();
  validateAuthConfig(options);
  return Bun.serve({
    hostname: '127.0.0.1', port: options.port ?? 31415, maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      try {
        if (request.headers.has('origin')) throw new HttpError(403, 'Browser-origin requests are disabled');
        const path = new URL(request.url).pathname;
        if (path === '/v1/state' && request.method === 'GET') {
          authorize(request, options.adminToken);
          const state = store.state();
          return Response.json({ revision: state.revision, records: state.records, health: options.health?.() ?? [], display:options.display?.() }, { headers: { 'cache-control': 'no-store' } });
        }
        const route = /^\/v1\/sources\/([a-z0-9_-]+)\/signals(?:\/(.+))?$/.exec(path);
        if (!route) throw new HttpError(404, 'Not found');
        const source = route[1];
        const config = Object.hasOwn(options.sources, source) ? options.sources[source] : undefined;
        authorize(request, config?.token);
        if ((request.method !== 'POST' || route[2]) && (request.method !== 'DELETE' || !route[2])) throw new HttpError(405, 'Method not allowed');
        const body = object(await readJson(request));
        let state;
        if (request.method === 'POST') {
          exact(body, ['deliveryId','signal']);
          const signal = parseLive(body.signal, source, actions, config?.allowedHosts);
          const deliveryId = text(body.deliveryId, 128);
          try { state = store.apply({ op: 'upsert', source, signal, deliveryId }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Command rejected'); }
        } else {
          exact(body, ['deliveryId']);
          let id: string;
          try { id = text(decodeURIComponent(route[2]), 128); } catch { throw new HttpError(400, 'Invalid id'); }
          const deliveryId = text(body.deliveryId, 128);
          try { state = store.apply({ op: 'remove', source, id, deliveryId }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Command rejected'); }
        }
        return Response.json({ revision: state.revision });
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return Response.json({ error: error instanceof HttpError ? error.message : 'Internal error' }, { status });
      }
    }
  });
}
