import { expect, test } from 'bun:test';
import { parseSessionState, SessionMonitorProtocol, type SessionState } from './session-monitor';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const nativeTest = process.platform === 'darwin' ? test : test.skip;
nativeTest('native lock reconciliation recovers notification races without unlocking on transient absence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'streamhub-lock-test-'));
  const cache = process.env.STREAMHUB_SWIFT_CACHE ?? join(tmpdir(), 'streamhub-swift-test-modules');
  await mkdir(cache, { recursive: true });
  try {
    const binary = join(directory, 'session-monitor');
    const compiler = Bun.spawn(['/usr/bin/swiftc', '-module-cache-path', cache, new URL('../native/session-monitor.swift', import.meta.url).pathname, '-o', binary], { stdout: 'ignore', stderr: 'pipe' });
    const compileTimer = setTimeout(() => compiler.kill('SIGKILL'), 60_000);
    let compilerError: string;
    try { compilerError = await new Response(compiler.stderr).text(); await compiler.exited; }
    finally { clearTimeout(compileTimer); }
    expect(compiler.exitCode, compilerError!).toBe(0);
    const helper = Bun.spawn([binary, '--self-test'], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => helper.kill('SIGKILL'), 2000);
    try {
      const output = await new Response(helper.stdout).text();
      await helper.exited;
      expect(helper.exitCode).toBe(0);
      expect(output.trim()).toBe('lock-state self-test passed');
    } finally { clearTimeout(timer); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 65_000);

test('session monitor schema accepts only consistent full snapshots', () => {
  expect(parseSessionState({ active: true, reason: 'active' })).toEqual({ active: true, reason: 'active' });
  expect(parseSessionState({ active: false, reason: 'locked' })).toEqual({ active: false, reason: 'locked' });
  for (const value of [null, [], {}, { active: 'true', reason: 'active' }, { active: true, reason: 'locked' }, { active: false, reason: 'active' }, { active: false, reason: 'secret' }, { active: true, reason: 'active', extra: true }]) {
    expect(() => parseSessionState(value)).toThrow();
  }
});

test('chunked JSONL emits transitions and every valid heartbeat refreshes liveness', () => {
  const states: SessionState[] = [];
  const protocol = new SessionMonitorProtocol(state => states.push(state), 0);
  protocol.push('{"active":true,', 1);
  expect(states).toEqual([{ active: false, reason: 'monitor-unavailable' }]);
  protocol.push('"reason":"active"}\n', 2);
  protocol.push('{"active":true,"reason":"active"}\n', 2000);
  protocol.check(7999);
  expect(states).toHaveLength(2);
  protocol.check(8000);
  expect(states.at(-1)).toEqual({ active: false, reason: 'monitor-unavailable' });
  protocol.push('{"active":false,"reason":"locked"}\n', 8001);
  expect(states.at(-1)).toEqual({ active: false, reason: 'locked' });
});

test('malformed, oversized and closed monitor streams fail closed without logging input', () => {
  for (const invalid of ['not-json\n', '{"active":true}\n', `${'x'.repeat(1025)}`, '{"active":true,"reason":"active"}\ninvalid\n']) {
    const states: SessionState[] = [];
    const protocol = new SessionMonitorProtocol(state => states.push(state), 0);
    protocol.push('{"active":true,"reason":"active"}\n', 1);
    expect(() => protocol.push(invalid, 2)).toThrow('Invalid session monitor output');
    expect(states.at(-1)).toEqual({ active: false, reason: 'monitor-unavailable' });
  }
  const states: SessionState[] = [];
  const protocol = new SessionMonitorProtocol(state => states.push(state), 0);
  protocol.push('{"active":true,"reason":"active"}\n', 1);
  protocol.fail();
  expect(states.at(-1)).toEqual({ active: false, reason: 'monitor-unavailable' });
});
