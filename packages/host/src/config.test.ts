import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuredDisplay, readConfig, updateConfig, validateConfig } from './config';

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
  for (let i = 0; i < 2; i++) updateConfig(config => ({ ...config,display:{...config.display,mode:'hid'},streamdeck: { enabled: true } }));
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...configured,display:{mode:'hid'},streamdeck: { enabled: true } });
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

test('fixed action buttons validate registered names and arguments before startup',()=>{
  const config={...valid(),actions:{build:{exec:['/usr/bin/true','{target}'],args:{target:'[a-z]+'},sources:['demo']}},streamdeck:{enabled:true,board:{defaultPage:'home',pages:[{id:'home',title:'Home',buttons:[{index:0,type:'action' as const,label:'Build',name:'build',args:{target:'main'}}]}]}}};
  expect(()=>validateConfig(config)).not.toThrow();
  expect(()=>validateConfig({...config,actions:{}})).toThrow();
  const invalid=structuredClone(config);invalid.streamdeck.board.pages[0].buttons[0].args.target='bad;value';
  expect(()=>validateConfig(invalid)).toThrow();
  expect(config.actions.build.sources).toEqual(['demo']);
});

test('plugin-only config requires an absolute private token path and valid port',()=>{
  const base={port:31415,adminToken:'a'.repeat(32),sources:{demo:{token:'b'.repeat(32)}}};
  expect(validateConfig({...base,streamdeckPlugin:{enabled:true,port:31417,tokenFile:'/tmp/streamhub-token'}}).streamdeckPlugin?.enabled).toBe(true);
  expect(()=>validateConfig({...base,streamdeckPlugin:{enabled:true,port:31417,tokenFile:'relative'}})).toThrow();
  expect(()=>validateConfig({...base,streamdeckPlugin:{enabled:true,port:0,tokenFile:'/tmp/token'}})).toThrow();
});

test('canonical display mode is authoritative and keeps legacy owners mutually exclusive',()=>{
  const plugin={port:31417,tokenFile:'/tmp/streamhub-token'};
  const canonical=validateConfig({...valid(),display:{mode:'plugin',plugin},streamdeck:{enabled:true}});
  expect(configuredDisplay(canonical)).toEqual({mode:'plugin',plugin});
  expect(canonical.streamdeck?.enabled).toBe(false);
  expect(canonical.streamdeckPlugin?.enabled).toBe(true);

  const hid=validateConfig({...valid(),display:{mode:'hid'},streamdeckPlugin:{enabled:true,...plugin}});
  expect(configuredDisplay(hid)).toEqual({mode:'hid',plugin});
  expect(hid.streamdeck?.enabled).toBe(true);
  expect(hid.streamdeckPlugin?.enabled).toBe(false);
});

test('legacy display ownership normalizes safely and rejects two enabled owners',()=>{
  const plugin={enabled:true,port:31417,tokenFile:'/tmp/streamhub-token'};
  expect(configuredDisplay(validateConfig({...valid(),streamdeckPlugin:plugin}))).toEqual({mode:'plugin',plugin:{port:31417,tokenFile:plugin.tokenFile}});
  expect(configuredDisplay(validateConfig({...valid(),streamdeck:{enabled:true}}))).toEqual({mode:'hid'});
  expect(configuredDisplay(validateConfig(valid()))).toEqual({mode:'off'});
  expect(()=>validateConfig({...valid(),streamdeck:{enabled:true},streamdeckPlugin:plugin})).toThrow('Display ownership is ambiguous');
});

test('canonical display validation rejects unknown modes and fields',()=>{
  expect(()=>validateConfig({...valid(),display:{mode:'automatic'}})).toThrow('Invalid display config');
  expect(()=>validateConfig({...valid(),display:{mode:'hid',devicePath:'/dev/test'}})).toThrow('Invalid display config');
  expect(()=>validateConfig({...valid(),display:{mode:'plugin'}})).toThrow('Invalid display config');
});
