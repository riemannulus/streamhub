import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SessionState = { active: boolean; reason: string };
const inactiveReasons = new Set(['locked', 'sleeping', 'display-asleep', 'inactive-session', 'shutting-down', 'monitor-unavailable']);

export function parseSessionState(raw: unknown): SessionState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session state');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.active !== 'boolean' || typeof value.reason !== 'string') throw new Error('Invalid session state');
  if (value.active ? value.reason !== 'active' : !inactiveReasons.has(value.reason)) throw new Error('Invalid session state');
  return { active: value.active, reason: value.reason };
}

/** Bounded JSONL decoder and fake-clock-testable heartbeat supervision. */
export class SessionMonitorProtocol {
  private pending = '';
  private lastSeen: number;
  private previous?: SessionState;
  constructor(private readonly onState: (state: SessionState) => void, now: number) {
    this.lastSeen = now;
    this.fail();
  }
  private emit(state: SessionState) {
    if (this.previous?.active === state.active && this.previous.reason === state.reason) return;
    this.previous = { ...state };
    this.onState({ ...state });
  }
  fail() { this.emit({ active: false, reason: 'monitor-unavailable' }); }
  check(now: number) { if (now - this.lastSeen >= 6000) this.fail(); }
  push(chunk: string, now: number) {
    try {
      this.pending += chunk;
      let end: number;
      while ((end = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 1);
        if (Buffer.byteLength(line) > 1024) throw new Error('Oversized line');
        const state = parseSessionState(JSON.parse(line));
        this.lastSeen = now;
        this.emit(state);
      }
      if (Buffer.byteLength(this.pending) > 1024) throw new Error('Oversized line');
    } catch {
      this.pending = '';
      this.fail();
      throw new Error('Invalid session monitor output');
    }
  }
}

async function buildHelper(cacheDir: string): Promise<string> {
  const source = join(dirname(fileURLToPath(import.meta.url)), '../native/session-monitor.swift');
  const compiler = '/usr/bin/swiftc';
  const compilerStat = await stat(compiler);
  const hash = createHash('sha256').update(await readFile(source)).update(`${process.arch}:${release()}:${compilerStat.mtimeMs}`).digest('hex').slice(0, 20);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const binary = join(cacheDir, `session-monitor-${hash}`);
  try { if ((await stat(binary)).isFile()) return binary; } catch {}
  const temporary = `${binary}-${randomUUID()}.tmp`;
  const moduleCache = join(cacheDir, 'swift-modules');
  await mkdir(moduleCache, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([compiler, '-module-cache-path', moduleCache, source, '-o', temporary], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    if (await child.exited !== 0) throw new Error('Session helper compilation failed');
    await rename(temporary, binary);
    return binary;
  } finally { clearTimeout(timeout); await rm(temporary, { force: true }); }
}

/** No privilege elevation or session changes. Missing/dead helpers always disable activity. */
export async function startSessionMonitor(
  onState: (state: SessionState) => void,
  options: { cacheDir?: string } = {},
): Promise<{ stop(): Promise<void> }> {
  const protocol = new SessionMonitorProtocol(onState, performance.now());
  const noop = { stop: async () => {} };
  if (process.platform !== 'darwin') return noop;
  let helper: string;
  try { helper = await buildHelper(options.cacheDir ?? join(homedir(), 'Library/Caches/streamhub')); }
  catch { protocol.fail(); return noop; }
  let child: ReturnType<typeof Bun.spawn>;
  try { child = Bun.spawn([helper], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }); }
  catch { protocol.fail(); return noop; }
  let stopped = false;
  let dead = false;
  const heartbeat = setInterval(() => protocol.check(performance.now()), 500);
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const consuming = (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done || dead || stopped) break;
        protocol.push(decoder.decode(value, { stream: true }), performance.now());
      }
    } catch { child.kill('SIGKILL'); }
    finally { dead = true; child.kill('SIGKILL'); reader.releaseLock(); clearInterval(heartbeat); protocol.fail(); }
  })();
  void child.exited.then(() => { dead = true; clearInterval(heartbeat); protocol.fail(); });
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      child.kill('SIGKILL');
      await Promise.all([child.exited, consuming]);
      protocol.fail();
    },
  };
}
