import { expect, test } from 'bun:test';
import { SessionDeck, type DeckPage, type DeckKey, type SessionRecord } from './index';

const cell = (page: DeckPage, index: number) => page.keys[index]!;
const record = (page: DeckPage, index: number) => {
  const key = cell(page, index);
  return key.type === 'signal' || key.type === 'pin' ? key.record : undefined;
};
const count = (page: DeckPage, index: number, field: 'hiddenCount' | 'urgentCount') => {
  const key = cell(page, index);
  return field in key ? (key as unknown as Record<string, number>)[field] : undefined;
};

const signal = (id: string, source = 'sessions', revision = 1) => ({
  source, id, kind: 'live' as const, level: 'info' as const, label: id,
  revision, createdAt: 1, updatedAt: revision, freshness: 'fresh' as const,
  press: { type: 'action' as const, name: 'focus', args: { id } },
});

test('thirteenth session gets another page with reserved navigation positions', () => {
  const deck = new SessionDeck();
  deck.update(Array.from({ length: 13 }, (_, i) => signal(`${i}`)));
  const first = deck.page();
  expect(first.keys).toHaveLength(15);
  expect(first.pageCount).toBe(2);
  expect(cell(first, 10).type).toBe('previous');
  expect(cell(first, 13).type).toBe('pin');
  expect(cell(first, 14).type).toBe('next');
  expect(record(first, 12)?.id).toBe('11');
  expect(record(deck.page(1), 0)?.id).toBe('12');
});

test('removal leaves holes and new sessions reuse holes without moving survivors', () => {
  const deck = new SessionDeck();
  const records: SessionRecord[] = [signal('a'), signal('b'), signal('c')];
  deck.update(records);
  deck.update([records[0]!, records[2]!]);
  expect(cell(deck.page(), 1).type).toBe('empty');
  expect(record(deck.page(), 2)?.id).toBe('c');
  deck.update([records[0]!, records[2]!, signal('d')]);
  expect(record(deck.page(), 1)?.id).toBe('d');
  expect(record(deck.page(), 2)?.id).toBe('c');
});

test('identical ids from different sources occupy different slots', () => {
  const deck = new SessionDeck();
  deck.update([signal('id', 'a'), signal('id', 'b')]);
  expect(record(deck.page(), 0)?.source).toBe('a');
  expect(record(deck.page(), 1)?.source).toBe('b');
});

test('release returns the displayed effect once and repeated down cannot replace it', () => {
  const deck = new SessionDeck();
  deck.update([signal('a')]);
  deck.down(0);
  expect(deck.up(0)).toEqual({ type: 'effect', key: { source: 'sessions', id: 'a' }, revision: 1,
    effect: { type: 'action', name: 'focus', args: { id: 'a' } } });
  expect(deck.up(0)).toBeUndefined();
  deck.down(0);
  deck.update([signal('a', 'sessions', 2)]);
  deck.down(0);
  expect(deck.up(0)).toBeUndefined();
});

test('release after revision change, replacement, or page switch cannot target anything', () => {
  const deck = new SessionDeck();
  deck.update([signal('a')]);
  deck.down(0);
  deck.update([signal('a', 'sessions', 2)]);
  expect(deck.up(0)).toBeUndefined();
  deck.down(0);
  deck.update([signal('b')]);
  expect(deck.up(0)).toBeUndefined();
  deck.update(Array.from({ length: 13 }, (_, i) => signal(`${i}`)));
  deck.down(0);
  deck.page(1);
  deck.page(0);
  expect(deck.up(0)).toBeUndefined();
});

test('next and previous presses navigate without wrapping', () => {
  const deck = new SessionDeck();
  deck.update(Array.from({ length: 13 }, (_, i) => signal(`${i}`)));
  deck.down(14);
  expect(deck.up(14)).toEqual({ type: 'navigate', page: 1 });
  expect(deck.page().index).toBe(1);
  deck.down(14);
  expect(deck.up(14)).toBeUndefined();
  deck.down(10);
  expect(deck.up(10)).toEqual({ type: 'navigate', page: 0 });
});

test('current empty final page stays until navigation leaves it', () => {
  const deck = new SessionDeck();
  const records = Array.from({ length: 13 }, (_, i) => signal(`${i}`));
  deck.update(records);
  deck.page(1);
  deck.update(records.slice(0, 12));
  expect(deck.page().index).toBe(1);
  expect(deck.page().pageCount).toBe(2);
  expect(cell(deck.page(), 0).type).toBe('empty');
  expect(deck.page(0).pageCount).toBe(1);
});

test('urgent pin stays stable and navigates to its original page without running its action', () => {
  const deck = new SessionDeck();
  const records = Array.from({ length: 13 }, (_, i) => signal(`${i}`));
  const urgent = { ...records[12]!, level: 'urgent' as const };
  deck.update([...records.slice(0, 12), urgent]);
  expect(record(deck.page(), 13)?.id).toBe('12');
  deck.update([{ ...records[0]!, level: 'urgent' }, ...records.slice(1, 12), urgent]);
  expect(record(deck.page(), 13)?.id).toBe('12');
  expect(count(deck.page(), 13, 'hiddenCount')).toBe(1);
  expect(count(deck.page(), 14, 'urgentCount')).toBe(1);
  deck.down(13);
  expect(deck.up(13)).toEqual({ type: 'navigate', page: 1, highlight: { source: 'sessions', id: '12' } });
  expect(count(deck.page(), 10, 'urgentCount')).toBe(1);
  deck.update([{ ...records[0]!, level: 'urgent' }, ...records.slice(1)]);
  expect(record(deck.page(), 13)?.id).toBe('0');
});

test('saved layout restores holes and current page even with reversed source enumeration', () => {
  const deck = new SessionDeck();
  const records = Array.from({ length: 13 }, (_, i) => signal(`${i}`));
  deck.update(records);
  deck.update(records.filter(item => item.id !== '1'));
  deck.page(1);
  const saved = deck.exportLayout();
  const restored = new SessionDeck(JSON.parse(JSON.stringify(saved)));
  restored.update(records.filter(item => item.id !== '1').reverse());
  expect(restored.page().index).toBe(1);
  expect(record(restored.page(), 0)?.id).toBe('12');
  expect(cell(restored.page(0), 1).type).toBe('empty');
  expect(record(restored.page(), 2)?.id).toBe('2');
});

test('page transition requires every previously held key to release before fresh input', () => {
  const deck = new SessionDeck();
  deck.update(Array.from({ length: 13 }, (_, i) => signal(`${i}`)));
  deck.down(1);
  deck.page(1);
  deck.down(0);
  expect(deck.up(0)).toBeUndefined();
  expect(deck.up(1)).toBeUndefined();
  deck.down(0);
  expect(deck.up(0)?.type).toBe('effect');
});

test('invalid page numbers are rejected instead of corrupting the current page', () => {
  const deck = new SessionDeck();
  expect(() => deck.page(NaN)).toThrow();
  expect(() => deck.page(Infinity)).toThrow();
  expect(deck.page().index).toBe(0);
});

test('invalid saved layout cannot assign a target twice or restore another device layout', () => {
  expect(() => new SessionDeck({ version: 1, slots: [{ source: 's', id: 'a' }, { source: 's', id: 'a' }], currentPage: 0 })).toThrow();
  expect(() => new SessionDeck({ version: 2, slots: [], currentPage: 0 } as never)).toThrow();
  expect(() => new SessionDeck({ version: 1, slots: [], currentPage: -1 })).toThrow();
  expect(() => new SessionDeck({ version: 1, slots: [], currentPage: 100 })).toThrow();
});

test('cancelInput discards bindings across OS session suspension',()=>{
  const deck=new SessionDeck();
  deck.update([signal('held')]);
  deck.down(0);deck.cancelInput();
  expect(deck.up(0)).toBeUndefined();
  deck.down(0);expect(deck.up(0)?.type).toBe('effect');
});
