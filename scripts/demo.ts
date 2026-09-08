import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from '../packages/host/src/store';
import { startServer } from '../packages/host/src/server';
import { Reconciler } from '../packages/host/src/reconciler';
import { SessionDeck } from '../packages/streamdeck';

const dir = mkdtempSync(join(tmpdir(), 'streamhub-demo-'));
const path = join(dir, 'state.sqlite');
const adminToken = crypto.randomUUID(), token = crypto.randomUUID();
let store = new SignalStore(path);
const server = startServer({ store, port: 0, adminToken, sources: { demo: { token } } });
try {
  const publish = async (id: string, level: 'info' | 'urgent' = 'info') => {
    const response = await fetch(new URL('/v1/sources/demo/signals', server.url), {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: crypto.randomUUID(), signal: { kind: 'live', id, level, label: id } })
    });
    assert.equal(response.status, 200);
  };
  for (let index = 1; index <= 13; index++) await publish(`session-${index}`);
  const deck = new SessionDeck(); deck.update(store.records());
  assert.equal(deck.page().pageCount, 2);
  const thirteenth = deck.page(1).keys[0];
  assert.equal(thirteenth.type, 'signal');
  assert.equal(thirteenth.type === 'signal' && thirteenth.record.id, 'session-13');
  console.log('PASS: HTTP로 입력한 13개 세션 → 12개 + 1개, 두 화면');

  const reconciler = new Reconciler(store);
  let complete!: (value: { ids: string[]; discoveries: [] }) => void;
  const pending = reconciler.run('demo', () => new Promise(resolve => { complete = resolve; }));
  await publish('session-13', 'urgent');
  complete({ ids: Array.from({ length: 12 }, (_, i) => `session-${i + 1}`), discoveries: [] });
  assert.equal((await pending).status, 'ok');
  assert.equal(store.records().find(record => record.id === 'session-13')?.level, 'urgent');
  console.log('PASS: 수집 중 도착한 urgent push가 오래된 목록으로 삭제되지 않음');

  const survivingIds = Array.from({ length: 12 }, (_, i) => `session-${i + 2}`);
  const result = await reconciler.run('demo', async () => { throw new Error('simulated collector failure'); });
  assert.equal(result.status, 'failed'); assert.equal(store.records().length, 13);
  for (let i = 0; i < 2; i++) await reconciler.run('demo', async () => ({ ids: survivingIds, discoveries: [] }));
  assert.equal(store.records().length, 12);
  deck.update(store.records()); deck.page(0);
  assert.equal(deck.page().keys[0].type, 'empty');
  const second = deck.page().keys[1];
  assert.equal(second.type === 'signal' && second.record.id, 'session-2');
  console.log('PASS: 실패한 수집은 삭제하지 않고, 연속 두 번 누락 후 철회; 기존 슬롯 유지');

  const layout = deck.exportLayout();
  await server.stop(true); store.close(); store = new SignalStore(path);
  assert.equal(store.records().length, 12);
  assert.ok(store.records().every(record => record.freshness === 'stale'));
  const restored = new SessionDeck(layout); restored.update(store.records());
  assert.equal(restored.page().keys[0].type, 'empty');
  console.log('PASS: SQLite 재시작 복구 + stale 표시 + 레이아웃 복원');
  console.log('데모 완료. 실제 앱 focus나 HID 장치 전송은 실행하지 않았습니다.');
} finally { await server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); }
