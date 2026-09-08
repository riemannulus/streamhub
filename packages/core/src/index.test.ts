import { describe, expect, test } from 'bun:test';
import { applyCommand, initialState, type CoreState, type LiveSignal } from './index';

const live = (id: string, level: LiveSignal['level'] = 'info'): LiveSignal => ({ id, kind: 'live', level, label: id });
const push = (s: CoreState, id: string, deliveryId = id, source = 'a', level: LiveSignal['level'] = 'info') => applyCommand(s, { op: 'upsert', source, signal: live(id, level), deliveryId }, 100);
const begin = (s: CoreState, snapshotId: string, source = 'a') => applyCommand(s, { op: 'beginSnapshot', source, snapshotId }, 101);
const member = (s: CoreState, snapshotId: string, ids: string[] = [], discoveries: LiveSignal[] = []) => applyCommand(s, { op: 'membership', source: 'a', snapshotId, ids, discoveries }, 102);

describe('live state', () => {
  test('markStale invalidates only fresh records from that source and is idempotent', () => {
    const first = push(push(initialState(), 'x'), 'y', 'y', 'b');
    const stale = applyCommand(first, { op: 'markStale', source: 'a' }, 300);
    expect(stale.records[0]!.freshness).toBe('stale');
    expect(stale.records[0]!.revision).toBeGreaterThan(first.records[0]!.revision);
    expect(stale.records[0]!.updatedAt).toBe(first.records[0]!.updatedAt);
    expect(stale.records[1]).toEqual(first.records[1]);
    expect(first.records[0]!.freshness).toBe('fresh');
    expect(applyCommand(stale, { op: 'markStale', source: 'a' }, 400)).toEqual(stale);
  });
  test('source isolation, immutable inputs and full replacement', () => {
    const original = initialState();
    const signal = { ...live('same'), detail: 'old', press: { type: 'action' as const, name: 'focus', args: { target: '1' } } };
    const first = applyCommand(original, { op: 'upsert', source: 'a', signal, deliveryId: '1' }, 1);
    signal.press.args.target = 'mutated';
    expect(first.records[0]!.press).toEqual({ type: 'action', name: 'focus', args: { target: '1' } });
    const second = push(push(first, 'same', '1', 'b'), 'same', '2');
    expect(original.records).toEqual([]);
    expect(second.records).toHaveLength(2);
    expect(second.records[0]!.detail).toBeUndefined();
    expect(second.records[0]!.press).toBeUndefined();
    expect(second.records[0]!.createdAt).toBe(1);
    expect(second.records[0]!.revision).toBeGreaterThan(first.records[0]!.revision);
  });
  test('delivery retries are no-ops and conflicting reuse rejects', () => {
    const first = push(initialState(), 'x');
    expect(push(first, 'x')).toEqual(first);
    expect(() => push(first, 'y', 'x')).toThrow();
    expect(() => applyCommand(first, { op: 'remove', source: 'a', id: 'x', deliveryId: 'x' }, 101)).toThrow();
    expect(push(first, 'x', 'x', 'b').records).toHaveLength(2);
  });
  test('dedupe handles semantic object key order and prunes at 24 hours', () => {
    const first = applyCommand(initialState(), { op: 'upsert', source: 'a', signal: live('x'), deliveryId: 'd' }, 1);
    expect(applyCommand(first, { op: 'upsert', source: 'a', signal: { label: 'x', level: 'info', kind: 'live', id: 'x' }, deliveryId: 'd' }, 2)).toEqual(first);
    expect(applyCommand(first, { op: 'upsert', source: 'a', signal: live('y'), deliveryId: 'd' }, 86_400_001).records).toHaveLength(2);
  });
  test('source capacity rejects atomically but updates still work', () => {
    let state = initialState();
    for (let n = 0; n < 1000; n++) state = push(state, String(n));
    expect(() => push(state, 'overflow')).toThrow();
    expect(state.records).toHaveLength(1000);
    expect(push(state, '0', 'update', 'a', 'urgent').records[0]!.level).toBe('urgent');
  });
  test('total capacity and delivery retention cap reject without evicting state', () => {
    const s = initialState();
    s.records = Array.from({ length: 10000 }, (_, i) => ({ ...live(String(i)), source: `s${Math.floor(i / 1000)}`, revision: i + 1, createdAt: 1, updatedAt: 1, freshness: 'fresh' }));
    s.revision = 10000;
    expect(() => push(s, 'overflow', 'overflow', 'new')).toThrow('Total active');
    expect(s.records).toHaveLength(10000);
    const fullHistory = initialState();
    fullHistory.deliveries = Array.from({ length: 100000 }, (_, i) => ({ source: 'a', deliveryId: String(i), fingerprint: 'old', acceptedAt: 1 }));
    expect(() => push(fullHistory, 'new')).toThrow('Delivery retention');
    expect(fullHistory.records).toEqual([]);
    expect(applyCommand(fullHistory, { op: 'upsert', source: 'a', signal: live('new'), deliveryId: 'new' }, 86_400_001).records).toHaveLength(1);
  });
});

describe('membership reconciliation', () => {
  test('two consecutive successful misses remove only the owner records', () => {
    const first = push(push(initialState(), 'x'), 'x', 'x', 'b');
    const once = member(begin(first, '1'), '1');
    expect(once.records).toHaveLength(2);
    const twice = member(begin(once, '2'), '2');
    expect(twice.records.map(r => r.source)).toEqual(['b']);
  });
  test('failure resets misses and never deletes records', () => {
    let s = member(begin(push(initialState(), 'x'), '1'), '1');
    s = applyCommand(begin(s, '2'), { op: 'failSnapshot', source: 'a', snapshotId: '2' }, 103);
    s = member(begin(s, '3'), '3');
    expect(s.records).toHaveLength(1);
    expect(member(begin(s, '4'), '4').records).toHaveLength(0);
  });
  test('presence and discovery never overwrite urgent; new discovery is unconfirmed', () => {
    const s = member(begin(push(initialState(), 'x', 'x', 'a', 'urgent'), '1'), '1', ['x', 'y'], [live('x'), live('y')]);
    expect(s.records[0]!.level).toBe('urgent');
    expect(s.records[1]!.freshness).toBe('stale');
  });
  test('push during collection resets previous miss and is protected from absence', () => {
    let s = member(begin(push(initialState(), 'x'), '1'), '1');
    s = member(push(begin(s, '2'), 'x', 'new'), '2');
    expect(s.records).toHaveLength(1);
    s = member(begin(s, '3'), '3');
    expect(s.records).toHaveLength(1);
  });
  test('remove during collection prevents resurrection including unknown key removal', () => {
    let s = begin(push(initialState(), 'x'), '1');
    for (const id of ['x', 'y']) s = applyCommand(s, { op: 'remove', source: 'a', id, deliveryId: `remove-${id}` }, 102);
    expect(member(s, '1', ['x', 'y'], [live('x'), live('y')]).records).toEqual([]);
  });
  test('invalid, overlapping, old and malformed snapshots reject atomically', () => {
    const s = begin(push(initialState(), 'x'), '1');
    expect(() => begin(s, '2')).toThrow();
    expect(() => member(s, 'unknown')).toThrow();
    expect(() => member(s, '1', ['x', 'x'])).toThrow();
    expect(() => member(s, '1', ['x'], [live('y')])).toThrow();
    expect(() => member(s, '1', ['x'], [live('x'), live('x')])).toThrow();
    expect(s.records).toHaveLength(1);
    const done = member(s, '1', ['x']);
    expect(() => member(done, '1')).toThrow();
    expect(() => begin(done, '1')).toThrow();
  });
  test('restore marks stale, changes record revisions and resets collection state', () => {
    let s = member(begin(push(initialState(), 'x'), '1'), '1');
    s = begin(s, '2');
    const restored = applyCommand(JSON.parse(JSON.stringify(s)), { op: 'restore' }, 200);
    expect(restored.records[0]!.freshness).toBe('stale');
    expect(restored.records[0]!.revision).toBeGreaterThan(s.records[0]!.revision);
    expect(() => member(restored, '2')).toThrow();
    const next = member(begin(restored, '3'), '3');
    expect(next.records).toHaveLength(1);
    expect(member(begin(next, '4'), '4').records).toHaveLength(0);
  });
  test('discovery transaction exceeding source capacity leaves pending snapshot untouched', () => {
    let s = initialState();
    for (let n = 0; n < 1000; n++) s = push(s, String(n));
    s = begin(s, '1');
    expect(() => member(s, '1', ['new'], [live('new')])).toThrow('Source active');
    expect(s.records).toHaveLength(1000);
    expect(s.misses).toEqual([]);
    expect(s.snapshots).toHaveLength(1);
  });
  test('unusual string keys do not collide in JSON restored state', () => {
    let s = push(push(initialState(), '__proto__', 'constructor', '__proto__'), 'constructor', '__proto__', '__proto__');
    s = JSON.parse(JSON.stringify(s));
    expect(s.records).toHaveLength(2);
    expect(push(s, '__proto__', 'constructor', '__proto__')).toEqual(s);
  });
});
