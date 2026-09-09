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
  for (const invalid of [new Uint8Array([0xff]), new TextEncoder().encode('x'.repeat(1025)), new TextEncoder().encode('invalid\n'), line({ available: true })]) {
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

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('native context snapshot and monitor shutdown preserve the protocol', async () => {
  const { buildHelper } = await import('./session-monitor');
  const { startAppContextMonitor } = await import('./app-context');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = join(tmpdir(), 'streamhub-context-test-cache');
  const helper = await buildHelper(cacheDir);
  const child = Bun.spawn([helper, '--context-once'], { stdout: 'pipe', stderr: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const context = parseApplicationContext(JSON.parse(await new Response(child.stdout).text()));
    expect(typeof context.available).toBe('boolean');
    expect(await child.exited).toBe(0);
  } finally { clearTimeout(timeout); }
  const states: ApplicationContext[] = [];
  const monitor = await startAppContextMonitor(state => states.push(state), { cacheDir });
  await Promise.all([monitor.stop(), monitor.stop()]);
  expect(states.at(-1)).toEqual(unavailable);
}, 65_000);
