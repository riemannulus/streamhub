import { afterEach, expect, test } from 'bun:test';
import { SignalStore } from './store';
import { Reconciler } from './reconciler';
import type { LiveSignal } from '../../core/src/index';
import { ActionRegistry } from './actions';

const stores: SignalStore[] = [];
const live = (id: string): LiveSignal => ({ id, kind: 'live', label: id, level: 'info' });
function setup() {
  const store = new SignalStore(':memory:'); stores.push(store);
  const reconciler = new Reconciler(store);
  store.apply({ op: 'upsert', source: 'a', signal: live('x'), deliveryId: '1' });
  return { store, reconciler };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

test('failure degrades immediately and becomes stale at the bounded deadline after success', async () => {
  let now = 0;
  const store = new SignalStore(':memory:', () => now); stores.push(store);
  const reconciler = new Reconciler(store, undefined, undefined, () => now);
  store.apply({ op: 'upsert', source: 'a', signal: live('x'), deliveryId: '1' });
  store.apply({ op: 'upsert', source: 'b', signal: live('y'), deliveryId: '1' });
  await reconciler.run('a', async () => ({ ids: ['x'], discoveries: [] }));
  now = 100;
  await reconciler.run('a', async () => { throw new Error('offline'); });
  expect(reconciler.health()[0]!.status).toBe('degraded');
  expect(store.records()[0]!.freshness).toBe('fresh');
  now = 59_999; reconciler.expireStale('a', 20_000);
  expect(store.records()[0]!.freshness).toBe('fresh');
  now = 60_000; reconciler.expireStale('a', 20_000);
  expect(store.records()[0]!.freshness).toBe('stale');
  expect(store.records()[1]!.freshness).toBe('fresh');
  expect(store.records()).toHaveLength(2);
  const revision = store.state().revision;
  now = 80_000; reconciler.expireStale('a', 20_000);
  expect(store.state().revision).toBe(revision);
  await reconciler.run('a', async () => ({ ids: ['x'], discoveries: [] }));
  expect(reconciler.health()[0]).toMatchObject({ status: 'ok', lastSuccess: 80_000 });
  expect(store.records()[0]!.freshness).toBe('stale');
});

test('first pending attempt also expires with three-interval minimum and no deletion', async () => {
  let now = 1000;
  const store = new SignalStore(':memory:', () => now); stores.push(store);
  const reconciler = new Reconciler(store, undefined, undefined, () => now);
  store.apply({ op: 'upsert', source: 'a', signal: live('x'), deliveryId: '1' });
  let finish!: (value: { ids: string[]; discoveries: LiveSignal[] }) => void;
  const pending = reconciler.run('a', () => new Promise(resolve => { finish = resolve; }));
  now = 90_999; reconciler.expireStale('a', 30_000);
  expect(store.records()[0]!.freshness).toBe('fresh');
  now = 91_000; reconciler.expireStale('a', 30_000);
  expect(store.records()[0]!.freshness).toBe('stale');
  expect(reconciler.health()[0]!.status).toBe('degraded');
  expect(store.state().snapshots).toHaveLength(1);
  expect(() => reconciler.expireStale('a', NaN)).toThrow();
  finish({ ids: ['x'], discoveries: [] });
  await pending;
  expect(store.records()).toHaveLength(1);
});

test('two complete collections remove a missing session and expose source health', async () => {
  const { store, reconciler } = setup();
  expect(await reconciler.run('a', async () => ({ ids: [], discoveries: [] }))).toEqual({ status: 'ok' });
  expect(store.records()).toHaveLength(1);
  await reconciler.run('a', async () => ({ ids: [], discoveries: [] }));
  expect(store.records()).toHaveLength(0);
  expect(reconciler.health()[0]).toMatchObject({ source: 'a', status: 'ok' });
  expect(reconciler.health()[0]!.lastSuccess).toBeNumber();
});

test('failed collection resets misses and does not expose raw errors', async () => {
  const { store, reconciler } = setup();
  await reconciler.run('a', async () => ({ ids: [], discoveries: [] }));
  const successTime = reconciler.health()[0]!.lastSuccess;
  const result = await reconciler.run('a', async () => { throw new Error('secret-token-abc'); });
  expect(result.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('secret-token');
  expect(reconciler.health()[0]).toMatchObject({ status: 'degraded', lastSuccess: successTime });
  expect(JSON.stringify(reconciler.health())).not.toContain('secret-token');
  expect(store.state().snapshots).toEqual([]);
  await reconciler.run('a', async () => ({ ids: [], discoveries: [] }));
  expect(store.records()).toHaveLength(1);
});

test('watermark predates awaited collection and overlapping runs are skipped', async () => {
  const { store, reconciler } = setup();
  await reconciler.run('a', async () => ({ ids: [], discoveries: [] }));
  let finish!: (value: { ids: string[]; discoveries: LiveSignal[] }) => void;
  const pending = reconciler.run('a', () => new Promise(resolve => { finish = resolve; }));
  expect(store.state().snapshots).toHaveLength(1);
  expect(reconciler.health()[0]!.status).toBe('collecting');
  let invoked = false;
  expect(await reconciler.run('a', async () => { invoked = true; return { ids: [], discoveries: [] }; })).toEqual({ status: 'skipped' });
  expect(invoked).toBe(false);
  store.apply({ op: 'upsert', source: 'a', signal: { ...live('x'), level: 'urgent' }, deliveryId: '2' });
  finish({ ids: [], discoveries: [] });
  expect(await pending).toEqual({ status: 'ok' });
  expect(store.records()[0]!.level).toBe('urgent');
  await reconciler.run('a', async () => ({ ids: [], discoveries: [] }));
  expect(store.records()).toHaveLength(1);
});

test('malformed or partial output cannot delete sessions or add discoveries', async () => {
  const { store, reconciler } = setup();
  const malformed: unknown[] = [
    null, { ids: [] }, { ids: [1], discoveries: [] },
    { ids: ['x', 'x'], discoveries: [] },
    { ids: [], discoveries: [live('new')] },
    { ids: ['new'], discoveries: [{ ...live('new'), kind: 'event' }] },
    { ids: ['new'], discoveries: [{ ...live('new'), ttlMs: 10 }] },
    { ids: ['new'], discoveries: [{ ...live('new'), press: { type: 'action', name: 'unknown', args: {} } }] },
    { ids: [], discoveries: [], incomplete: true },
    { ids: Array.from({ length: 1001 }, (_, i) => String(i)), discoveries: [] },
  ];
  for (const value of malformed) {
    expect((await reconciler.run('a', async () => value as { ids: string[]; discoveries: LiveSignal[] })).status).toBe('failed');
    expect(store.records().map(r => r.id)).toEqual(['x']);
    expect(store.state().snapshots).toEqual([]);
  }
});

test('authorized discoveries use registry; health is returned as an independent value', async () => {
  const { store } = setup();
  const actions = new ActionRegistry({ focus: { exec: ['/usr/bin/true', '{target}'], args: { target: '[a-z]+' }, sources: ['a'] } });
  const reconciler = new Reconciler(store, actions);
  expect(await reconciler.run('a', async () => ({ ids: ['x', 'new'], discoveries: [{ ...live('new'), press: { type: 'action', name: 'focus', args: { target: 'new' } } }] }))).toEqual({ status: 'ok' });
  expect(store.records()).toHaveLength(2);
  const health = reconciler.health(); health[0]!.source = 'mutated';
  expect(reconciler.health()[0]!.source).toBe('a');
});
