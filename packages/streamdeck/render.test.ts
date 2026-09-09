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

test('configured tiles escape text and reject markup in their color',async()=>{
  const page=new SessionDeck().page();
  const bytes=await renderKey({type:'tile',index:0,label:'<img>',subtitle:'&hello',foot:'<script>',color:'red"/><image href="file:///etc/passwd'},page);
  expect(bytes.length).toBe(72*72*3);
  expect([...bytes.subarray((3*72+36)*3,(3*72+36)*3+3)]).toEqual([66,96,135]);
});

test('builtin icons change real pixels while preserving labels and selected color',async()=>{
  const page=new SessionDeck().page();
  const plain={type:'tile' as const,index:0,label:'작업 실행',enabled:false,color:'#123456'};
  const base=await renderKey(plain,page);
  expect([...base.subarray((3*72+36)*3,(3*72+36)*3+3)]).toEqual([18,52,86]);
  const outputs:Buffer[]=[];
  for(const icon of ['terminal','folder','check','alert','play','link'] as const){
    const bytes=await renderKey({...plain,icon},page);outputs.push(bytes);
    expect(bytes.equals(base)).toBe(false);
    expect(bytes.subarray(30*72*3).equals(base.subarray(30*72*3))).toBe(true);
  }
  expect(new Set(outputs.map(bytes=>bytes.toString('base64'))).size).toBe(6);
});
