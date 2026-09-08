export type LiveSignal = {
  id: string;
  kind: 'live';
  level: 'info' | 'warn' | 'urgent';
  label: string;
  detail?: string;
  press?: { type: 'action'; name: string; args: Record<string, string> } | { type: 'open'; url: string };
};

export type SignalRecord = LiveSignal & {
  source: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  freshness: 'fresh' | 'stale';
};

export type CoreCommand =
  | { op: 'upsert'; source: string; signal: LiveSignal; deliveryId: string }
  | { op: 'remove'; source: string; id: string; deliveryId: string }
  | { op: 'beginSnapshot'; source: string; snapshotId: string }
  | { op: 'failSnapshot'; source: string; snapshotId: string }
  | { op: 'membership'; source: string; snapshotId: string; ids: string[]; discoveries: LiveSignal[] }
  | { op: 'markStale'; source: string }
  | { op: 'restore' };

type Key = { source: string; id: string };
export type CoreState = {
  records: SignalRecord[];
  revision: number;
  deliveries: { source: string; deliveryId: string; fingerprint: string; acceptedAt: number }[];
  snapshots: { source: string; snapshotId: string; watermark: number }[];
  snapshotHistory: { source: string; snapshotId: string; acceptedAt: number }[];
  tombstones: (Key & { revision: number })[];
  misses: (Key & { count: number })[];
};

const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY = 100_000;
const MAX_SOURCE = 1_000;
const MAX_TOTAL = 10_000;

export function initialState(): CoreState {
  return { records: [], revision: 0, deliveries: [], snapshots: [], snapshotHistory: [], tombstones: [], misses: [] };
}

const sameKey = (key: Key, source: string, id: string) => key.source === source && key.id === id;

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

function enforceCapacity(records: SignalRecord[]): void {
  if (records.length > MAX_TOTAL) throw new Error('Total active signal limit exceeded');
  const counts = new Map<string, number>();
  for (const record of records) {
    const count = (counts.get(record.source) ?? 0) + 1;
    if (count > MAX_SOURCE) throw new Error('Source active signal limit exceeded');
    counts.set(record.source, count);
  }
}

/** Pure transition. The host validates raw input and persists this result before acknowledging. */
export function applyCommand(state: CoreState, command: CoreCommand, now: number): CoreState {
  if (!Number.isFinite(now)) throw new Error('Invalid host timestamp');
  const next: CoreState = {
    ...state,
    records: [...state.records],
    deliveries: state.deliveries.filter(d => now - d.acceptedAt < RETENTION_MS),
    snapshots: [...state.snapshots],
    snapshotHistory: state.snapshotHistory.filter(s => now - s.acceptedAt < RETENTION_MS),
    tombstones: [...state.tombstones],
    misses: [...state.misses],
  };
  const revision = () => {
    if (next.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision limit exceeded');
    return ++next.revision;
  };
  const clearMiss = (source: string, id: string) => {
    next.misses = next.misses.filter(m => !sameKey(m, source, id));
  };
  const remove = (source: string, id: string) => {
    next.records = next.records.filter(r => !sameKey(r, source, id));
    clearMiss(source, id);
    next.tombstones = next.tombstones.filter(t => !sameKey(t, source, id));
    next.tombstones.push({ source, id, revision: revision() });
  };

  if (command.op === 'markStale') {
    next.records = next.records.map(r => r.source !== command.source || r.freshness === 'stale' ? r : { ...r, freshness: 'stale', revision: revision() });
  } else if (command.op === 'restore') {
    next.snapshots = [];
    next.misses = [];
    next.tombstones = [];
    next.records = next.records.map(r => r.freshness === 'stale' ? r : { ...r, freshness: 'stale', revision: revision() });
  } else if (command.op === 'upsert' || command.op === 'remove') {
    const { source, deliveryId } = command;
    const fingerprint = canonical(command);
    const prior = next.deliveries.find(d => d.source === source && d.deliveryId === deliveryId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Delivery ID reused with different content');
      return next;
    }
    if (next.deliveries.length >= MAX_HISTORY) throw new Error('Delivery retention capacity exceeded');
    if (command.op === 'upsert') {
      const signal = structuredClone(command.signal);
      const index = next.records.findIndex(r => sameKey(r, source, signal.id));
      const previous = next.records[index];
      const record: SignalRecord = { ...signal, source, revision: revision(), createdAt: previous?.createdAt ?? now, updatedAt: now, freshness: 'fresh' };
      if (index < 0) next.records.push(record);
      else next.records[index] = record;
      clearMiss(source, signal.id);
    } else remove(source, command.id);
    next.deliveries.push({ source, deliveryId, fingerprint, acceptedAt: now });
  } else if (command.op === 'beginSnapshot') {
    if (next.snapshots.some(s => s.source === command.source)) throw new Error('Source already has an active snapshot');
    if (next.snapshotHistory.some(s => s.source === command.source && s.snapshotId === command.snapshotId)) throw new Error('Snapshot ID already used');
    if (next.snapshotHistory.length >= MAX_HISTORY) throw new Error('Snapshot retention capacity exceeded');
    if (next.snapshots.length >= MAX_TOTAL) throw new Error('Pending snapshot capacity exceeded');
    next.snapshots.push({ source: command.source, snapshotId: command.snapshotId, watermark: next.revision });
    next.snapshotHistory.push({ source: command.source, snapshotId: command.snapshotId, acceptedAt: now });
  } else {
    const { source, snapshotId } = command;
    const snapshot = next.snapshots.find(s => s.source === source && s.snapshotId === snapshotId);
    if (!snapshot) throw new Error('Unknown or completed snapshot');
    if (command.op === 'failSnapshot') {
      next.misses = next.misses.filter(m => m.source !== source);
    } else {
      if (command.ids.length > MAX_SOURCE || command.discoveries.length > MAX_SOURCE) throw new Error('Snapshot source capacity exceeded');
      const ids = new Set(command.ids);
      if (ids.size !== command.ids.length) throw new Error('Duplicate membership ID');
      const discoveries = new Set<string>();
      for (const signal of command.discoveries) {
        if (signal.kind !== 'live' || !ids.has(signal.id) || discoveries.has(signal.id)) throw new Error('Invalid discovery membership');
        discoveries.add(signal.id);
      }
      for (const record of [...next.records]) {
        if (record.source !== source) continue;
        if (ids.has(record.id) || record.revision > snapshot.watermark) {
          clearMiss(source, record.id);
          continue;
        }
        const count = (next.misses.find(m => sameKey(m, source, record.id))?.count ?? 0) + 1;
        clearMiss(source, record.id);
        if (count >= 2) remove(source, record.id);
        else next.misses.push({ source, id: record.id, count });
      }
      for (const signal of command.discoveries) {
        if (next.records.some(r => sameKey(r, source, signal.id))) continue;
        if (next.tombstones.some(t => sameKey(t, source, signal.id) && t.revision > snapshot.watermark)) continue;
        next.records.push({ ...structuredClone(signal), source, revision: revision(), createdAt: now, updatedAt: now, freshness: 'stale' });
      }
    }
    next.snapshots = next.snapshots.filter(s => s !== snapshot);
  }
  // Live tombstones only protect in-flight collections; delivery IDs retain retry protection.
  next.tombstones = next.tombstones.filter(t => next.snapshots.some(s => s.source === t.source && t.revision > s.watermark));
  if (next.tombstones.length > MAX_HISTORY) throw new Error('In-flight tombstone capacity exceeded');
  enforceCapacity(next.records);
  return next;
}
