import { isAbsolute } from 'node:path';
export type ActionPress = { type: 'action'; name: string; args: Record<string, string> };
export type ActionDefinition = {
  exec: string[]; args: Record<string, string>; sources: string[];
  cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number;
};
type Registered = ActionDefinition & { patterns: Map<string, RegExp> };

/** Trusted local configuration, never supplied by a signal. No shell evaluation. */
export class ActionRegistry {
  private readonly definitions = new Map<string, Registered>();
  constructor(definitions: Record<string, ActionDefinition> = {}) {
    for (const [name, def] of Object.entries(definitions)) {
      if (!Array.isArray(def.exec) || !def.exec.length || !isAbsolute(def.exec[0])) throw new Error('Action executable must be absolute');
      if (!Array.isArray(def.sources) || !def.sources.every(s => typeof s === 'string')) throw new Error('Action sources are required');
      if (def.cwd && !isAbsolute(def.cwd)) throw new Error('Action cwd must be absolute');
      if (def.timeoutMs !== undefined && (!Number.isInteger(def.timeoutMs) || def.timeoutMs < 1 || def.timeoutMs > 60000)) throw new Error('Invalid timeout');
      if (def.maxOutputBytes !== undefined && (!Number.isInteger(def.maxOutputBytes) || def.maxOutputBytes < 1 || def.maxOutputBytes > 1048576)) throw new Error('Invalid output limit');
      const patterns = new Map(Object.entries(def.args).map(([key, pattern]) => [key, new RegExp(`^(?:${pattern})$`)]));
      const used = new Set<string>();
      for (const arg of def.exec.slice(1)) {
        if (!/\{[A-Za-z][A-Za-z0-9_]*\}/.test(arg)) continue;
        const match = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(arg);
        if (!match || !patterns.has(match[1])) throw new Error('Template parameters must occupy an entire argv element');
        used.add(match[1]);
      }
      if ([...patterns.keys()].some(key => !used.has(key))) throw new Error('Unused action argument');
      this.definitions.set(name, { ...def, exec: [...def.exec], sources: [...def.sources], patterns });
    }
  }
  validate(source: string, press: ActionPress) {
    const def = this.definitions.get(press.name);
    if (!def || !def.sources.includes(source)) throw new Error('Action is not allowed for source');
    if (Object.keys(press.args).length !== def.patterns.size) throw new Error('Invalid action arguments');
    for (const [key, pattern] of def.patterns) {
      const value = press.args[key];
      if (typeof value !== 'string' || value.length > 512 || value.includes('\0') || !pattern.test(value)) throw new Error('Invalid action arguments');
    }
    return def;
  }
  async run(source: string, press: ActionPress) {
    const def = this.validate(source, press);
    const argv = def.exec.map(arg => /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.test(arg) ? press.args[arg.slice(1, -1)] : arg);
    const proc = Bun.spawn(argv, { cwd: def.cwd ?? process.cwd(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...def.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32' });
    const stop = () => {
      try {
        if (process.platform !== 'win32') process.kill(-proc.pid, 'SIGKILL');
        else proc.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    let timedOut = false;
    let bytes = 0;
    const timer = setTimeout(() => { timedOut = true; stop(); }, def.timeoutMs ?? 3000);
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > (def.maxOutputBytes ?? 65536)) { stop(); throw new Error('Action output limit exceeded'); }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf8');
    };
    try {
      const [stdout, stderr, exitCode] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
      if (timedOut) throw new Error('Action timed out');
      if (exitCode !== 0) throw new Error(`Action failed with exit ${exitCode}`);
      return { stdout, stderr, exitCode };
    } finally { clearTimeout(timer); stop(); await proc.exited; }
  }
}
