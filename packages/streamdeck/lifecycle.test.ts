import { expect, test } from 'bun:test';
import { SessionDeck } from './index';
import { DisplayLifecycle, type DisplayDevice } from './lifecycle';

const frame = (epoch = 1) => ({ ...new SessionDeck().page(), epoch });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function hardware() {
  const commands: string[] = [];
  let writeGate: ReturnType<typeof deferred> | undefined;
  let writing: ReturnType<typeof deferred> | undefined;
  let abortSignal: AbortSignal | undefined;
  const device: DisplayDevice = {
    async write(page, signal) {
      commands.push(`write:${page.epoch}`);
      abortSignal = signal;
      writing?.resolve();
      await writeGate?.promise;
    },
    async standby() { commands.push('standby'); },
    async close() { commands.push('close'); },
  };
  return {
    commands,
    connect: async () => { commands.push('open'); return device; },
    holdWrite() { writeGate = deferred(); writing = deferred(); return { started: writing.promise, finish: writeGate.resolve }; },
    get aborted() { return abortSignal?.aborted; },
  };
}

test('unknown state emits nothing; explicit suspend clears leftovers once and stop is terminal', async () => {
  const hw = hardware();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame());
  expect(hw.commands).toEqual([]);
  await life.setAllowed(false);
  await life.setAllowed(false);
  expect(hw.commands).toEqual(['open', 'standby', 'close']);
  await life.stop();
  await life.stop();
  await life.setAllowed(true);
  await life.retry();
  expect(hw.commands).toEqual(['open', 'standby', 'close']);
});

test('resume renders latest full frame and suspend closes before a later reopen', async () => {
  const hw = hardware();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame(1));
  await life.setAllowed(true);
  expect(life.inputEnabled).toBe(true);
  await life.setAllowed(false);
  await life.present(frame(2));
  expect(life.inputEnabled).toBe(false);
  expect(hw.commands).toEqual(['open', 'write:1', 'standby', 'close']);
  await life.setAllowed(true);
  expect(hw.commands).toEqual(['open', 'write:1', 'standby', 'close', 'open', 'write:2']);
  await life.stop();
});

test('suspend aborts pending write and resumes only after standby/close with newest frame', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame(1));
  const opening = life.setAllowed(true);
  await gate.started;
  const suspending = life.setAllowed(false);
  expect(hw.aborted).toBe(true);
  const updating = life.present(frame(2));
  const resuming = life.setAllowed(true);
  expect(life.inputEnabled).toBe(false);
  gate.finish();
  await Promise.all([opening, suspending, updating, resuming]);
  expect(hw.commands).toEqual(['open', 'write:1', 'standby', 'close', 'open', 'write:2']);
  expect(life.inputEnabled).toBe(true);
  await life.stop();
});

test('a held key across suspend cannot execute and all holds must release after redraw', async () => {
  const hw = hardware();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame());
  await life.setAllowed(true);
  expect(life.noteKey(0, 'down')).toBe(true);
  await life.setAllowed(false);
  await life.setAllowed(true);
  expect(life.inputEnabled).toBe(false);
  expect(life.noteKey(1, 'down')).toBe(false);
  expect(life.noteKey(0, 'up')).toBe(false);
  expect(life.inputEnabled).toBe(false);
  expect(life.noteKey(1, 'up')).toBe(false);
  expect(life.inputEnabled).toBe(true);
  expect(life.noteKey(0, 'up')).toBe(false);
  expect(life.noteKey(0, 'down')).toBe(true);
  expect(life.noteKey(0, 'up')).toBe(true);
  await life.stop();
});

test('disconnect closes handle and only explicit retry reconnects and redraws', async () => {
  const hw = hardware();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame(1));
  await life.setAllowed(true);
  await life.disconnected();
  await life.present(frame(2));
  expect(life.inputEnabled).toBe(false);
  expect(hw.commands).toEqual(['open', 'write:1', 'close']);
  await life.retry();
  expect(hw.commands).toEqual(['open', 'write:1', 'close', 'open', 'write:2']);
  expect(life.inputEnabled).toBe(true);
  await life.stop();
});

test('suspended nonresponsive write times out without reusing handle for standby', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const errors: unknown[] = [];
  const life = new DisplayLifecycle(hw.connect, { timeoutMs: 15, onError: error => errors.push(error) });
  await life.present(frame());
  const opening = life.setAllowed(true);
  await gate.started;
  const suspending = life.setAllowed(false);
  await Promise.all([opening, suspending]);
  expect(hw.commands).toEqual(['open', 'write:1', 'close']);
  expect(errors).toHaveLength(1);
  expect(life.inputEnabled).toBe(false);
  gate.finish();
  await life.retry();
  expect(hw.commands).toEqual(['open', 'write:1', 'close', 'open', 'standby', 'close']);
  await life.stop();
});

test('write timeout aborts its signal and requires explicit retry before any reconnect', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const life = new DisplayLifecycle(hw.connect, { timeoutMs: 15 });
  await life.present(frame());
  await life.setAllowed(true);
  expect(hw.aborted).toBe(true);
  expect(hw.commands).toEqual(['open', 'write:1', 'close']);
  await life.present(frame(2));
  expect(hw.commands).toEqual(['open', 'write:1', 'close']);
  gate.finish();
  await life.retry();
  expect(hw.commands).toEqual(['open', 'write:1', 'close', 'open', 'write:2']);
  await life.stop();
});

test('late connection after timeout is closed without ever writing', async () => {
  const gate = deferred();
  const closed = deferred();
  const commands: string[] = [];
  const life = new DisplayLifecycle(async () => {
    commands.push('open');
    await gate.promise;
    return { async write() { commands.push('write'); }, async standby() { commands.push('standby'); }, async close() { commands.push('close'); closed.resolve(); } };
  }, { timeoutMs: 15 });
  await life.present(frame());
  await life.setAllowed(true);
  expect(life.inputEnabled).toBe(false);
  gate.resolve();
  await closed.promise;
  expect(commands).toEqual(['open', 'close']);
  await life.stop();
});

test('suspend during connect performs standby before any frame can reach hardware', async () => {
  const gate = deferred();
  const started = deferred();
  const hw = hardware();
  const life = new DisplayLifecycle(async () => { started.resolve(); await gate.promise; return hw.connect(); });
  await life.present(frame());
  const opening = life.setAllowed(true);
  await started.promise;
  const suspending = life.setAllowed(false);
  gate.resolve();
  await Promise.all([opening, suspending]);
  expect(hw.commands).toEqual(['open', 'standby', 'close']);
  await life.stop();
});

test('a close failure blocks reopening until explicit retry', async () => {
  const commands: string[] = [];
  let failClose = true;
  const life = new DisplayLifecycle(async () => {
    commands.push('open');
    return {
      async write() { commands.push('write'); },
      async standby() { commands.push('standby'); },
      async close() { commands.push('close'); if (failClose) throw new Error('Disconnected during close'); },
    };
  });
  await life.present(frame());
  await life.setAllowed(true);
  await life.setAllowed(false);
  await life.setAllowed(true);
  expect(commands).toEqual(['open', 'write', 'standby', 'close']);
  failClose = false;
  await life.retry();
  expect(commands).toEqual(['open', 'write', 'standby', 'close', 'open', 'write']);
  await life.stop();
});

test('pending frame updates coalesce and input stays blocked until latest write completes', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame(1));
  const opening = life.setAllowed(true);
  await gate.started;
  const second = life.present(frame(2));
  const third = life.present(frame(3));
  expect(life.noteKey(0, 'down')).toBe(false);
  gate.finish();
  await Promise.all([opening, second, third]);
  expect(hw.commands).toEqual(['open', 'write:1', 'write:3']);
  expect(life.inputEnabled).toBe(false);
  expect(life.noteKey(0, 'up')).toBe(false);
  expect(life.inputEnabled).toBe(true);
  await life.stop();
});

test('disconnect during a write aborts and closes without sending standby to a lost device', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame());
  const opening = life.setAllowed(true);
  await gate.started;
  const disconnected = life.disconnected();
  expect(hw.aborted).toBe(true);
  gate.finish();
  await Promise.all([opening, disconnected]);
  expect(hw.commands).toEqual(['open', 'write:1', 'close']);
  expect(life.inputEnabled).toBe(false);
  await life.stop();
});

test('a burst during one pending write shares one bounded pump and renders only its newest frame', async () => {
  const hw = hardware();
  const gate = hw.holdWrite();
  const life = new DisplayLifecycle(hw.connect);
  await life.present(frame(1));
  const opening = life.setAllowed(true);
  await gate.started;
  const completions = new Set<Promise<void>>();
  for (let epoch = 2; epoch <= 1001; epoch++) completions.add(life.present(frame(epoch)));
  expect(completions.size).toBe(1);
  gate.finish();
  await Promise.all([opening, ...completions]);
  expect(hw.commands).toEqual(['open', 'write:1', 'write:1001']);
  await life.stop();
});

test('page supersession aborts the old write and gates held input through the final page',async()=>{
  const started=deferred();const final=deferred();const commands:string[]=[];
  const lifecycle=new DisplayLifecycle(async()=>({
    write:async(page,signal)=>{
      commands.push(page.viewId!);
      if(page.viewId==='b'){
        started.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
      }
      if(page.viewId==='c')await final.promise;
    },standby:async()=>{},close:async()=>{},
  }));
  await lifecycle.present({...frame(),viewId:'a'});await lifecycle.setAllowed(true);
  expect(lifecycle.noteKey(0,'down')).toBe(true);
  const work=lifecycle.present({...frame(),viewId:'b'});await started.promise;
  void lifecycle.present({...frame(),viewId:'c'});
  expect(lifecycle.inputEnabled).toBe(false);
  final.resolve();await work;
  expect(commands).toEqual(['a','b','c']);expect(lifecycle.inputEnabled).toBe(false);
  expect(lifecycle.noteKey(0,'up')).toBe(false);expect(lifecycle.inputEnabled).toBe(true);
  await lifecycle.stop();
});

test('fresh state for the destination page cancels its obsolete transition',async()=>{
  const started=deferred();const received:number[]=[];let aborted=false;
  const lifecycle=new DisplayLifecycle(async()=>({write:async(page,signal)=>{
    received.push(page.epoch);
    if(page.epoch===2){started.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));}
  },standby:async()=>{},close:async()=>{}}));
  await lifecycle.present({...frame(1),viewId:'a'});await lifecycle.setAllowed(true);
  const work=lifecycle.present({...frame(2),viewId:'b'});await started.promise;
  void lifecycle.present({...frame(3),viewId:'b'});
  await work;
  expect(aborted).toBe(true);expect(received).toEqual([1,2,3]);expect(lifecycle.inputEnabled).toBe(true);
  await lifecycle.stop();
});
