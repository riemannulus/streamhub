import { expect, test } from 'bun:test';
import { ApplicationContextProtocol, parseApplicationContext, type ApplicationContext } from './app-context';
const unavailable = { available: false, appBundleId: null };
const active = { available: true, appBundleId: 'com.example.Editor' };
const line = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');

test('application context accepts full consistent snapshots only', () => {
  expect(parseApplicationContext(active)).toEqual(active);
  expect(parseApplicationContext(unavailable)).toEqual(unavailable);
  expect(parseApplicationContext({ available: true, appBundleId: null })).toEqual({ available: true, appBundleId: null });
  for (const invalid of [null, [], {}, { ...active, extra: 1 }, { available: false, appBundleId: 'app' }, { available: true, appBundleId: '' }, { available: true, appBundleId: 1 }, { available: true, appBundleId: 'x'.repeat(513) }]) expect(() => parseApplicationContext(invalid)).toThrow();
});
test('context deduplicates heartbeats and recovers after heartbeat loss', () => {
  const states: ApplicationContext[] = [];
  const protocol = new ApplicationContextProtocol(state => states.push(state), 0);
  const bytes = line(active);
  protocol.push(bytes.slice(0, 10), 1);
  expect(states).toEqual([unavailable]);
  protocol.push(bytes.slice(10), 2);
  protocol.push(bytes, 2000);
  protocol.check(7999);
  expect(states).toHaveLength(2);
  protocol.check(8000);
  expect(states.at(-1)).toEqual(unavailable);
  protocol.push(bytes, 8001);
  expect(states.at(-1)).toEqual(active);
});
test('bounded UTF8 decoder rejects malformed streams and EOF partial lines', () => {
  for (const invalid of [new Uint8Array([0xff]), new TextEncoder().encode('x'.repeat(8193)), new TextEncoder().encode('invalid\n'), line({ available: true })]) {
    const states: ApplicationContext[] = [];
    const protocol = new ApplicationContextProtocol(state => states.push(state), 0);
    protocol.push(line(active), 1);
    expect(() => protocol.push(invalid, 2)).toThrow('Invalid application context output');
    expect(states.at(-1)).toEqual(unavailable);
  }
  const states: ApplicationContext[] = [];
  const protocol = new ApplicationContextProtocol(state => states.push(state), 0);
  protocol.push(line(active), 1);
  protocol.push(new Uint8Array([0xe2]), 2);
  protocol.end();
  expect(states.at(-1)).toEqual(unavailable);
});
test('multibyte bundle identifiers survive chunk boundaries', () => {
  const states: ApplicationContext[] = [];
  const protocol = new ApplicationContextProtocol(state => states.push(state), 0);
  const context = { available: true, appBundleId: 'com.example.한글' };
  for (const byte of line(context)) protocol.push(new Uint8Array([byte]), 1);
  expect(states.at(-1)).toEqual(context);
});

test('optional window context preserves legacy snapshots and rejects invalid known fields',()=>{
  const window={...active,windowTitle:'streamhub — 편집기',displayId:'DISPLAY-UUID'};
  expect(parseApplicationContext(window)).toEqual(window);
  expect(parseApplicationContext({...active,windowTitle:null,displayId:null})).toEqual({...active,windowTitle:null,displayId:null});
  for(const change of [{windowTitle:1},{windowTitle:undefined},{windowTitle:'x'.repeat(513)},{displayId:''},{displayId:1},{displayId:'x'.repeat(129)}])expect(()=>parseApplicationContext({...active,...change})).toThrow();
  expect(()=>parseApplicationContext({...unavailable,windowTitle:'private'})).toThrow();
  expect(()=>parseApplicationContext({...unavailable,displayId:'display'})).toThrow();
});
test('window-only changes emit updates and bounded multibyte titles survive fragmentation',()=>{
  const states:ApplicationContext[]=[];
  const protocol=new ApplicationContextProtocol(state=>states.push(state),0);
  const context={...active,windowTitle:'한'.repeat(512),displayId:'UUID'};
  for(const byte of line(context))protocol.push(new Uint8Array([byte]),1);
  expect(states.at(-1)).toEqual(context);
  protocol.push(line(context),2);expect(states).toHaveLength(2);
  protocol.push(line({...context,windowTitle:'Other'}),3);expect(states).toHaveLength(3);
  protocol.push(line({...context,windowTitle:'Other',displayId:null}),4);expect(states).toHaveLength(4);
});

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('native synthetic context self-test compiles and preserves the protocol', async () => {
  const { buildHelper } = await import('./session-monitor');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = join(tmpdir(), 'streamhub-context-test-cache');
  const helper = await buildHelper(cacheDir);
  const child = Bun.spawn([helper, '--context-self-test'], { stdout: 'pipe', stderr: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const context = parseApplicationContext(JSON.parse(await new Response(child.stdout).text()));
    expect(typeof context.available).toBe('boolean');
    expect(await child.exited).toBe(0);
  } finally { clearTimeout(timeout); }
}, 65_000);
