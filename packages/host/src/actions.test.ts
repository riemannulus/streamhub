import { expect, test } from 'bun:test';
import { ActionRegistry } from './actions';

test('registered action passes literal argv and verifies source and argument constraints', async () => {
  const registry = new ActionRegistry({ echo: { exec: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '{target}'], args: { target: '^.{1,100}$' }, sources: ['a'] } });
  const args = { target: '$(touch /tmp/never-execute); spaces' };
  const result = await registry.run('a', { type: 'action', name: 'echo', args });
  expect(result.stdout).toBe(args.target);
  expect(() => registry.validate('b', { type: 'action', name: 'echo', args })).toThrow();
  expect(() => registry.validate('a', { type: 'action', name: 'unknown', args })).toThrow();
  expect(() => registry.validate('a', { type: 'action', name: 'echo', args: { ...args, surprise: 'value' } })).toThrow();
});

test('timeout and output limits stop child execution and report failure', async () => {
  const registry = new ActionRegistry({
    wait: { exec: [process.execPath, '-e', 'setTimeout(()=>{}, 30000)'], args: {}, sources: ['a'], timeoutMs: 40 },
    flood: { exec: [process.execPath, '-e', 'process.stdout.write("x".repeat(100000))'], args: {}, sources: ['a'], maxOutputBytes: 128 }
  });
  await expect(registry.run('a', { type: 'action', name: 'wait', args: {} })).rejects.toThrow('timed out');
  await expect(registry.run('a', { type: 'action', name: 'flood', args: {} })).rejects.toThrow('output limit');
});

test('nonzero action exit is failure and template cannot form an option name', async () => {
  const registry = new ActionRegistry({ fail: { exec: [process.execPath, '-e', 'process.exit(2)'], args: {}, sources: ['a'] } });
  await expect(registry.run('a', { type: 'action', name: 'fail', args: {} })).rejects.toThrow('exit 2');
  expect(() => new ActionRegistry({ bad: { exec: ['/bin/echo', '--{verdict}'], args: { verdict: '.*' }, sources: ['a'] } })).toThrow();
});

test('timeout also stops descendants holding inherited output pipes', async () => {
  const registry = new ActionRegistry({ descendants: {
    exec: [process.execPath, '-e', 'Bun.spawn(["/bin/sleep", "2"], {stdout:"inherit", stderr:"inherit"}); setTimeout(()=>{}, 30000)'],
    args: {}, sources: ['a'], timeoutMs: 50
  } });
  const start = performance.now();
  await expect(registry.run('a', {type:'action', name:'descendants', args:{}})).rejects.toThrow('timed out');
  expect(performance.now() - start).toBeLessThan(1000);
});

test('cancellation terminates active process groups and pre-aborted actions never start',async()=>{
  const registry=new ActionRegistry({wait:{exec:[process.execPath,'-e','setTimeout(()=>{},30000)'],args:{},sources:['a'],timeoutMs:5000}});
  const controller=new AbortController();
  const result=registry.run('a',{type:'action',name:'wait',args:{}},controller.signal).catch(error=>error);
  await Bun.sleep(20);const started=performance.now();controller.abort();
  expect((await result).message).toContain('cancelled');expect(performance.now()-started).toBeLessThan(1000);
  await expect(registry.run('a',{type:'action',name:'wait',args:{}},controller.signal)).rejects.toThrow('cancelled');
});
