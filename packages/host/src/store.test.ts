import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlreadyRunningError, SignalStore } from './store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const live = { kind: 'live' as const, id: 'session', level: 'urgent' as const, label: 'waiting' };

test('durable upsert and dedupe survive reopen while product state becomes stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamhub-store-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite');
  let store = new SignalStore(path);
  store.apply({ op: 'upsert', source: 'claude', signal: live, deliveryId: 'one' });
  store.close();
  store = new SignalStore(path);
  try {
    expect(store.records()).toMatchObject([{ id: 'session', level: 'urgent', freshness: 'stale' }]);
    const rev = store.state().revision;
    store.apply({ op: 'upsert', source: 'claude', signal: live, deliveryId: 'one' });
    expect(store.state().revision).toBe(rev);
  } finally { store.close(); }
});

test('failed command preserves last committed state', () => {
  const store = new SignalStore(':memory:');
  try {
    store.apply({ op: 'upsert', source: 'a', signal: live, deliveryId: 'one' });
    const before = store.state();
    expect(() => store.apply({ op: 'membership', source: 'a', snapshotId: 'unknown', ids: [], discoveries: [] })).toThrow();
    expect(store.state()).toEqual(before);
  } finally { store.close(); }
});

test('membership removal remains removed after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamhub-store-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite');
  let store = new SignalStore(path);
  store.apply({ op: 'upsert', source: 'a', signal: live, deliveryId: 'one' });
  for (const snapshotId of ['first', 'second']) {
    store.apply({ op: 'beginSnapshot', source: 'a', snapshotId });
    store.apply({ op: 'membership', source: 'a', snapshotId, ids: [], discoveries: [] });
  }
  store.close();
  store = new SignalStore(path);
  try { expect(store.records()).toEqual([]); } finally { store.close(); }
});

test('only one host may own a persistent store, and close releases ownership', () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamhub-store-')); dirs.push(dir);
  const path = join(dir, 'state.sqlite');
  const first = new SignalStore(path);
  let unexpected: SignalStore | undefined;
  try { expect(() => { unexpected = new SignalStore(path); }).toThrow(AlreadyRunningError); }
  finally { unexpected?.close(); first.close(); }
  const reopened = new SignalStore(path);
  reopened.close();
});

test('unrelated SQLite open failures are not reported as another running host',()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-store-error-'));dirs.push(dir);
  let error:unknown;
  try{new SignalStore(join(dir,'missing','state.sqlite'));}catch(caught){error=caught;}
  expect(error).toBeDefined();
  expect(error).not.toBeInstanceOf(AlreadyRunningError);
});

test('device layout is durable independently of signal state',()=>{
  const dir=mkdtempSync(join(tmpdir(),'streamhub-layout-'));dirs.push(dir);
  const path=join(dir,'state.sqlite');let store=new SignalStore(path);
  const layout={version:1,slots:[null,{source:'a',id:'x'}],currentPage:0};
  store.setViewState('deck',layout);store.close();store=new SignalStore(path);
  try{expect(store.getViewState('deck')).toEqual(layout);expect(store.getViewState('absent')).toBeUndefined();expect(store.records()).toEqual([]);}finally{store.close();}
});
