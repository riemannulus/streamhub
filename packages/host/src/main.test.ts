import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('daemon and CLI accept a session and shut down cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'streamhub-main-'));
  const probe = Bun.serve({ hostname:'127.0.0.1', port:0, fetch: () => new Response() });
  const port = probe.port!; await probe.stop(true);
  const config = join(dir, 'config.json'), signal = join(dir, 'signal.json');
  writeFileSync(config, JSON.stringify({ port, adminToken:'a'.repeat(32), sources:{demo:{token:'b'.repeat(32)}} }), {mode:0o600});
  writeFileSync(signal, JSON.stringify({kind:'live',id:'smoke',level:'info',label:'smoke'}));
  const env = {...process.env, STREAMHUB_CONFIG:config};
  const proc = Bun.spawn([process.execPath, 'packages/host/src/main.ts'], {env,stdout:'ignore',stderr:'pipe'});
  try {
    let ready = false;
    for (let attempt=0; attempt<100; attempt++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/v1/state`, {headers:{authorization:`Bearer ${'a'.repeat(32)}`}, signal:AbortSignal.timeout(100)})).ok) { ready = true; break; } } catch {}
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    const push = Bun.spawn([process.execPath,'scripts/client.ts','push','demo',signal,'smoke-delivery'],{env,stdout:'pipe',stderr:'pipe'});
    expect(await push.exited).toBe(0);
    const list = Bun.spawn([process.execPath,'scripts/client.ts','list'],{env,stdout:'pipe',stderr:'pipe'});
    const output = await new Response(list.stdout).json();
    expect(await list.exited).toBe(0);
    expect(output.records).toMatchObject([{source:'demo',id:'smoke',label:'smoke'}]);
    proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
  } finally { proc.kill('SIGKILL'); await proc.exited; rmSync(dir,{recursive:true,force:true}); }
}, 10000);
