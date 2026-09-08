import { expect, test } from 'bun:test';
import { SessionDeck } from './index';
import { renderKey } from './render';

test('empty keys render black and signals include a colored level band and text', async () => {
  const deck = new SessionDeck();
  let page = deck.page();
  const empty = await renderKey(page.keys[0], page);
  expect(empty.length).toBe(72*72*3);
  expect([...empty].every(value=>value===0)).toBe(true);
  deck.update([{source:'a',id:'s',kind:'live',level:'urgent',label:'권한 대기',revision:1,createdAt:1,updatedAt:1,freshness:'fresh'}]);
  page = deck.page();
  const visible = await renderKey(page.keys[0],page);
  expect([...visible.subarray((3*72+36)*3,(3*72+36)*3+3)]).toEqual([220,55,65]);
  expect(visible.some((value,index)=>index > 72*12*3 && value>200)).toBe(true);
});

test('untrusted markup is rendered as text and stale looks different', async () => {
  const deck = new SessionDeck();
  const record = {source:'a',id:'s',kind:'live' as const,level:'info' as const,label:'<&"\'>',revision:1,createdAt:1,updatedAt:1,freshness:'fresh' as const};
  deck.update([record]); let page=deck.page();
  const fresh=await renderKey(page.keys[0],page);
  expect(fresh.length).toBe(72*72*3);
  deck.update([{...record,freshness:'stale'}]);page=deck.page();
  expect((await renderKey(page.keys[0],page)).equals(fresh)).toBe(false);
});
