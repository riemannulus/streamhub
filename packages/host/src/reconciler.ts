import { randomUUID } from 'node:crypto';
import type { LiveSignal } from '../../core/src/index';
import { ActionRegistry } from './actions';
import { SignalStore } from './store';
import { exact, object, parseLive, text } from './validation';

export type Membership = { ids: string[]; discoveries: LiveSignal[] };
export type ReconcileResult = { status: 'ok' | 'failed' | 'skipped'; error?: string };
export type SourceHealth = { source: string; status: 'collecting' | 'ok' | 'degraded'; lastSuccess: number | null; error?: string };

/** Trusted local collectors only. Each collector must return a complete snapshot or reject. */
export class Reconciler {
  private readonly active = new Set<string>();
  private readonly statuses = new Map<string, SourceHealth>();
  private readonly firstAttempts = new Map<string, number>();
  constructor(
    private readonly store: SignalStore,
    private readonly actions: ActionRegistry = new ActionRegistry(),
    private readonly allowedHosts: Record<string, string[]> = {},
    private readonly now: () => number = Date.now,
  ) {}

  health(): SourceHealth[] { return [...this.statuses.values()].map(value => ({ ...value })); }

  /** Call on every scheduler tick, including while a collection remains pending. */
  expireStale(source: string, intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Invalid collection interval');
    const health = this.statuses.get(source);
    const since = health?.lastSuccess ?? this.firstAttempts.get(source);
    if (!health || since === undefined || this.now() - since < Math.max(3 * intervalMs, 60_000)) return;
    this.store.apply({ op: 'markStale', source });
    this.statuses.set(source, { ...health, status: 'degraded', error: health.error ?? 'Collection freshness expired' });
  }

  async run(source: string, collect: () => Promise<Membership>): Promise<ReconcileResult> {
    try { text(source, 128); } catch { return { status: 'failed', error: 'Invalid source' }; }
    if (this.active.has(source)) return { status: 'skipped' };
    if (!this.firstAttempts.has(source)) this.firstAttempts.set(source, this.now());
    const lastSuccess = this.statuses.get(source)?.lastSuccess ?? null;
    this.active.add(source);
    this.statuses.set(source, { source, status: 'collecting', lastSuccess });
    const snapshotId = randomUUID();
    let begun = false;
    let error = 'Snapshot could not start';
    try {
      this.store.apply({ op: 'beginSnapshot', source, snapshotId });
      begun = true;
      error = 'Collector failed';
      const raw: unknown = await collect();
      error = 'Invalid collector output';
      const membership = this.validate(raw, source);
      error = 'Snapshot could not be applied';
      this.store.apply({ op: 'membership', source, snapshotId, ...membership });
      begun = false;
      this.statuses.set(source, { source, status: 'ok', lastSuccess: this.now() });
      return { status: 'ok' };
    } catch {
      // Do not propagate exception text: collectors can include tokens, argv or private output.
      if (begun) {
        try { this.store.apply({ op: 'failSnapshot', source, snapshotId }); }
        catch { error = 'Snapshot failure could not be persisted'; }
      }
      this.statuses.set(source, { source, status: 'degraded', lastSuccess, error });
      return { status: 'failed', error };
    } finally { this.active.delete(source); }
  }

  private validate(raw: unknown, source: string): Membership {
    const value = object(raw);
    exact(value, ['ids', 'discoveries']);
    if (!Array.isArray(value.ids) || !Array.isArray(value.discoveries) || value.ids.length > 1000 || value.discoveries.length > 1000) throw new Error('Invalid snapshot arrays');
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) throw new Error('Snapshot too large');
    const ids = value.ids.map(id => text(id, 128));
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) throw new Error('Duplicate membership ID');
    const hosts = Object.hasOwn(this.allowedHosts, source) ? this.allowedHosts[source]! : [];
    const discoveries = value.discoveries.map(signal => parseLive(signal, source, this.actions, hosts));
    const discoveredIds = new Set<string>();
    for (const signal of discoveries) {
      if (!uniqueIds.has(signal.id) || discoveredIds.has(signal.id)) throw new Error('Invalid discovery membership');
      discoveredIds.add(signal.id);
    }
    return { ids, discoveries };
  }
}
