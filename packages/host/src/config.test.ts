import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, updateConfig, validateConfig } from './config';

const original = process.env.STREAMHUB_CONFIG;
const directories: string[] = [];
afterEach(() => {
  if (original === undefined) delete process.env.STREAMHUB_CONFIG;
  else process.env.STREAMHUB_CONFIG = original;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function path() {
  const directory = mkdtempSync(join(tmpdir(), 'streamhub-config-'));
  directories.push(directory);
  return process.env.STREAMHUB_CONFIG = join(directory, 'config.json');
}
const valid = () => ({ port: 31415, adminToken: 'a'.repeat(32), sources: { demo: { token: 'b'.repeat(32) } } });

test('page configuration validates references before saving and preserves existing configuration', () => {
  const file = path();
  const original = readConfig(true);
  const board = {defaultPage:'home',transition:'fade' as const,durationMs:250,pages:[{id:'home',title:'Home',signals:{},buttons:[{index:13,type:'auto' as const}]}]};
  expect(() => validateConfig({...original,streamdeck:{enabled:true,board}})).not.toThrow();
  updateConfig(config => ({...config,streamdeck:{enabled:true,board}}));
  expect(readConfig().adminToken).toBe(original.adminToken);
  const before = readFileSync(file, 'utf8');
  expect(() => updateConfig(config => ({...config,streamdeck:{enabled:true,board:{...board,defaultPage:'missing'}}}))).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('initialization and registration preserve tokens and unknown settings across repeated updates', () => {
  const file = path();
  const first = readConfig(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const configured = { ...first, port: 31416, future: { setting: true } };
  writeFileSync(file, JSON.stringify(configured));
  for (let i = 0; i < 2; i++) updateConfig(config => ({ ...config, streamdeck: { enabled: true } }));
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...configured, streamdeck: { enabled: true } });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readConfig(true).adminToken).toBe(first.adminToken);
});

test('invalid updates preserve existing file and do not initialize absent files', () => {
  const file = path();
  expect(() => updateConfig(config => ({ ...config, port: 0 }))).toThrow();
  expect(() => readFileSync(file)).toThrow();
  readConfig(true);
  const before = readFileSync(file, 'utf8');
  expect(() => updateConfig(config => ({ ...config, adminToken: 'short' }))).toThrow();
  expect(readFileSync(file, 'utf8')).toBe(before);
});

test('all host configuration is validated before startup resources are created', () => {
  const action = { exec: ['/usr/bin/true'], args: {}, sources: ['demo'] };
  const collector = { source: 'demo', exec: ['/usr/bin/true'], intervalMs: 1000 };
  const invalid: unknown[] = [null, [], { ...valid(), adminToken: 'short' },
    { ...valid(), sources: { demo: { token: 'a'.repeat(32) } } },
    { ...valid(), sources: { 'bad/name': { token: 'b'.repeat(32) } } },
    { ...valid(), sources: { demo: null } },
    { ...valid(), sources: { demo: { token: 'b'.repeat(32), allowedHosts: [2] } } },
    { ...valid(), actions: [] }, { ...valid(), actions: { test: null } },
    ...[{ exec: ['relative'] }, { exec: ['/usr/bin/true', 2] }, { args: { id: '[' } }, { env: { A: 2 } }, { sources: ['missing'] }, { timeoutMs: 0 }].map(change => ({ ...valid(), actions: { test: { ...action, ...change } } })),
    ...[null, { ...collector, exec: [] }, { ...collector, exec: ['relative'] }, { ...collector, timeoutMs: 60001 }, { ...collector, intervalMs: 999 }, { ...collector, source: 'missing' }].map(item => ({ ...valid(), collectors: [item] })),
    { ...valid(), collectors: [collector, collector] },
  ];
  for (const config of invalid) expect(() => validateConfig(config)).toThrow();
  expect(validateConfig({ ...valid(), actions: { test: action }, collectors: [collector] }).port).toBe(31415);
});

test('registration CLI creates configuration and safely repeats using shared update', async () => {
  const file = path();
  const script = new URL('../../../scripts/register-streamdeck.ts', import.meta.url).pathname;
  const run = async (...args:string[]) => {
    const child = Bun.spawn([process.execPath, script, ...args], { env: { ...process.env, STREAMHUB_CONFIG: file }, stdout: 'pipe', stderr: 'pipe' });
    expect(await child.exited).toBe(0);
  };
  await run();
  const first = readConfig();
  expect(first.streamdeck?.enabled).toBe(true);
  await run();
  expect(readConfig()).toEqual(first);
  await run('--pages', new URL('../../../examples/pages.json', import.meta.url).pathname);
  expect(readConfig().streamdeck?.board?.pages).toHaveLength(2);
  expect(readConfig().adminToken).toBe(first.adminToken);
  await run();
  expect(readConfig().streamdeck?.board?.transition).toBe('fade');
});
