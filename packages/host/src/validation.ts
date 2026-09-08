import type { LiveSignal } from '../../core/src/index';
import type { ActionRegistry } from './actions';
export class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected object');
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'Unknown field');
}
export function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(400, 'Invalid string');
  return value;
}
export function parseLive(raw: unknown, source: string, actions: ActionRegistry, allowedHosts: string[] = []): LiveSignal {
  const obj = object(raw); exact(obj, ['kind','id','level','label','detail','press']);
  if (obj.kind !== 'live' || (typeof obj.level !== 'string' || !['info','warn','urgent'].includes(obj.level))) throw new HttpError(400, 'Only live signals with a valid level are supported');
  const signal: LiveSignal = { kind: 'live', id: text(obj.id, 128), label: text(obj.label, 80), level: obj.level as LiveSignal['level'] };
  if (obj.detail !== undefined) signal.detail = text(obj.detail, 1024);
  if (obj.press !== undefined) {
    const press = object(obj.press);
    if (press.type === 'action') {
      exact(press, ['type','name','args']);
      const name = text(press.name, 128);
      const values = object(press.args);
      const args = Object.fromEntries(Object.entries(values).map(([key,value]) => [key,text(value,512)]));
      const action = { type: 'action' as const, name, args };
      try { actions.validate(source, action); } catch { throw new HttpError(400, 'Action is not permitted'); }
      signal.press = action;
    } else if (press.type === 'open') {
      exact(press, ['type','url']);
      const rawUrl = text(press.url, 2048);
      let url: URL;
      try { url = new URL(rawUrl); } catch { throw new HttpError(400, 'Invalid URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.includes(url.hostname)) throw new HttpError(400, 'URL is not permitted');
      signal.press = { type: 'open', url: url.href };
    } else throw new HttpError(400, 'Invalid press');
  }
  return signal;
}
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Expected application/json');
  const limit = 1024 * 1024;
  if (Number(request.headers.get('content-length') ?? 0) > limit) throw new HttpError(413, 'Body too large');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing body');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON'); }
}
