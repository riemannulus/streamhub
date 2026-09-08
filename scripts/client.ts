import { readFileSync } from 'node:fs';
import { readConfig } from '../packages/host/src/config';
import { SessionDeck } from '../packages/streamdeck';
const config = readConfig();
const [command = 'list', source = 'demo', input, delivery = crypto.randomUUID()] = process.argv.slice(2);
let path = '/v1/state', method = 'GET', body: string | undefined, token = config.adminToken;
if (command === 'push' || command === 'remove') {
  if (!Object.hasOwn(config.sources, source) || !input) throw new Error('Usage: bun run client push SOURCE FILE [DELIVERY_ID] | remove SOURCE ID [DELIVERY_ID]');
  token = config.sources[source].token;
  method = command === 'push' ? 'POST' : 'DELETE';
  path = `/v1/sources/${source}/signals` + (command === 'remove' ? `/${encodeURIComponent(input)}` : '');
  body = JSON.stringify(command === 'push' ? { deliveryId: delivery, signal: JSON.parse(readFileSync(input, 'utf8')) } : { deliveryId: delivery });
} else if (command !== 'list' && command !== 'deck') throw new Error('Commands: list, deck, push, remove');
const response = await fetch(`http://127.0.0.1:${config.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
const result = await response.json();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
if (command === 'deck') {
  const deck = new SessionDeck(); deck.update(result.records);
  for (let page = 0; page < deck.page().pageCount; page++) {
    const view = deck.page(page);
    console.log(`Page ${page + 1}/${view.pageCount}`);
    for (let row = 0; row < 3; row++) console.log(view.keys.slice(row * 5, row * 5 + 5).map(key => key.type === 'signal' ? key.record.label : `[${key.type}]`).join(' | '));
  }
} else console.log(JSON.stringify(result, null, 2));
