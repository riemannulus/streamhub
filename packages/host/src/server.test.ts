import { afterEach, expect, test } from 'bun:test';
import { SignalStore } from './store';
import { startServer } from './server';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const signal = { kind: 'live', id: 'same', level: 'urgent', label: 'waiting' };
const sourceA = 'a'.repeat(32), sourceB = 'b'.repeat(32), admin = 'c'.repeat(32);
function setup() {
  const store = new SignalStore(':memory:');
  const server = startServer({ store, port: 0, adminToken: admin, sources: { a: { token: sourceA }, b: { token: sourceB } } });
  cleanup.push(() => { server.stop(true); store.close(); });
  return { store, server, request: (path: string, token: string, method = 'GET', body?: unknown, extra: Record<string,string> = {}) => fetch(new URL(path, server.url), { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }) };
}

test('source authentication prevents cross-source writes and unauthorized reads', async () => {
  const { request, store } = setup();
  expect((await request('/v1/sources/b/signals', sourceA, 'POST', { deliveryId: 'x', signal })).status).toBe(401);
  expect((await request('/v1/state', sourceA)).status).toBe(401);
  expect((await request('/v1/sources/a/signals', sourceA, 'POST', { deliveryId: 'x', signal })).status).toBe(200);
  expect((await request('/v1/sources/b/signals', sourceB, 'POST', { deliveryId: 'x', signal })).status).toBe(200);
  expect(store.records()).toHaveLength(2);
  expect((await request('/v1/state', admin)).status).toBe(200);
});

test('external payload cannot impersonate source, set live TTL, ack, or register an action', async () => {
  const { request, store } = setup();
  for (const invalid of [{ ...signal, level: ['urgent'] }, { ...signal, source: 'b' }, { ...signal, ttlMs: 100 }, { ...signal, press: { type: 'ack' } }, { ...signal, press: { type: 'action', name: 'exec', args: {} } }, { ...signal, kind: 'event' }]) {
    expect((await request('/v1/sources/a/signals', sourceA, 'POST', { deliveryId: crypto.randomUUID(), signal: invalid })).status).toBe(400);
  }
  expect(store.records()).toEqual([]);
});

test('origin requests and oversized bodies are rejected without changing state', async () => {
  const { request, store } = setup();
  expect((await request('/v1/sources/a/signals', sourceA, 'POST', { deliveryId: 'x', signal }, { origin: 'https://evil.example' })).status).toBe(403);
  expect((await request('/v1/sources/a/signals', sourceA, 'POST', { junk: 'x'.repeat(1024 * 1024) })).status).toBe(413);
  expect(store.records()).toEqual([]);
});

test('delete is source-scoped and duplicated delivery is idempotent', async () => {
  const { request, store } = setup();
  await request('/v1/sources/a/signals', sourceA, 'POST', { deliveryId: 'x', signal });
  const revision = store.state().revision;
  await request('/v1/sources/a/signals', sourceA, 'POST', { deliveryId: 'x', signal });
  expect(store.state().revision).toBe(revision);
  expect((await request('/v1/sources/a/signals/same', sourceB, 'DELETE', { deliveryId: 'rm' })).status).toBe(401);
  expect((await request('/v1/sources/a/signals/same', sourceA, 'DELETE', { deliveryId: 'rm' })).status).toBe(200);
  expect(store.records()).toEqual([]);
});
