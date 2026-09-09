import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildHelper } from './session-monitor';

/** App identity only. Window titles and project identity require separate adapters. */
export type ApplicationContext = { available: boolean; appBundleId: string | null };
export function parseApplicationContext(raw: unknown): ApplicationContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid application context');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.available !== 'boolean'
    || (value.appBundleId !== null && (typeof value.appBundleId !== 'string' || !value.appBundleId.length || Buffer.byteLength(value.appBundleId) > 512))
    || (!value.available && value.appBundleId !== null)) throw new Error('Invalid application context');
  return { available: value.available, appBundleId: value.appBundleId as string | null };
}

export class ApplicationContextProtocol {
  private pending: number[] = [];
  private previous?: ApplicationContext;
  private lastSeen: number;
  constructor(private readonly onContext: (context: ApplicationContext) => void, now: number) {
    this.lastSeen = now;
    this.fail();
  }
  private emit(context: ApplicationContext) {
    if (this.previous?.available === context.available && this.previous.appBundleId === context.appBundleId) return;
    this.previous = { ...context };
    this.onContext({ ...context });
  }
  fail() { this.emit({ available: false, appBundleId: null }); }
  check(now: number) { if (now - this.lastSeen >= 6000) this.fail(); }
  end() { this.pending = []; this.fail(); }
  push(chunk: Uint8Array, now: number) {
    try {
      for (const byte of chunk) {
        // Reject invalid leading bytes even before a newline; the full decoder
        // verifies continuation sequences once the bounded line is complete.
        if (byte >= 0xf5 || byte === 0xc0 || byte === 0xc1) throw new Error('Invalid UTF8');
        if (byte !== 10) {
          this.pending.push(byte);
          if (this.pending.length > 1024) throw new Error('Oversized line');
          continue;
        }
        const context = parseApplicationContext(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(this.pending))));
        this.pending = [];
        this.lastSeen = now;
        this.emit(context);
      }
    } catch {
      this.pending = [];
      this.fail();
      throw new Error('Invalid application context output');
    }
  }
}

/** Read-only NSWorkspace observer; failure preserves unknown context for routing. */
export async function startAppContextMonitor(
  onContext: (context: ApplicationContext) => void,
  options: { cacheDir?: string } = {},
): Promise<{ stop(): Promise<void> }> {
  const protocol = new ApplicationContextProtocol(onContext, performance.now());
  const noop = { stop: async () => {} };
  if (process.platform !== 'darwin') return noop;
  let helper: string;
  try { helper = await buildHelper(options.cacheDir ?? join(homedir(), 'Library/Caches/streamhub')); }
  catch { return noop; }
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([helper, '--context'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }); }
  catch { return noop; }
  let stopped = false;
  let dead = false;
  let stopping: Promise<void> | undefined;
  const heartbeat = setInterval(() => protocol.check(performance.now()), 500);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const consuming = (async () => {
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done || dead || stopped) break;
        protocol.push(value, performance.now());
      }
    } catch { child.kill('SIGKILL'); }
    finally {
      dead = true;
      child.kill('SIGKILL');
      reader.releaseLock();
      clearInterval(heartbeat);
      protocol.end();
    }
  })();
  void child.exited.then(() => { dead = true; clearInterval(heartbeat); protocol.fail(); });
  return {
    stop() {
      return stopping ??= (async () => {
        stopped = true;
        clearInterval(heartbeat);
        child.kill('SIGKILL');
        await Promise.all([child.exited, consuming]);
        protocol.end();
      })();
    },
  };
}
