import type { BuiltinIcon } from './pages';
export type SignalKey = { source: string; id: string };
export type Effect = { type: 'action'; name: string; args: Record<string, string> } | { type: 'open'; url: string };
export type SessionRecord = SignalKey & {
  kind: 'live'; level: 'info' | 'warn' | 'urgent'; label: string; detail?: string;
  press?: Effect; revision: number; createdAt: number; updatedAt: number;
  freshness: 'fresh' | 'stale';
};
export type DeckKey =
  | { type: 'tile'; index: number; label: string; subtitle?: string; foot?: string; color?: string; icon?: BuiltinIcon; enabled?: boolean }
  | { type: 'empty'; index: number }
  | { type: 'signal'; index: number; record: SessionRecord }
  | { type: 'previous' | 'next'; index: number; enabled: boolean; urgentCount: number }
  | { type: 'pin'; index: number; record?: SessionRecord; hiddenCount: number };
export type DeckPage = { index: number; pageCount: number; epoch: number; keys: DeckKey[]; viewId?: string; transition?: { type: 'none' | 'fade'; durationMs: number } };
export type ButtonEffect={type:'open';url:string}|{type:'app';bundleId:string}|{type:'action';name:string;args:Record<string,string>};
export type PressIntent = { type: 'effect'; key: SignalKey; revision: number; effect: Effect }
  | { type: 'navigate'; page: number; highlight?: SignalKey }
  | {type:'button-effect';pageId:string;index:number;effect:ButtonEffect};
export type DeckLayout = { version: 1; slots: (SignalKey | null)[]; currentPage: number };
export const CONTENT_KEYS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12] as const;
const keyOf = (key: SignalKey) => JSON.stringify([key.source, key.id]);

/** Pure logical view. A hardware renderer must additionally gate input during writes. */
export class SessionDeck {
  private records = new Map<string, SessionRecord>();
  private slots: (string | null)[] = [];
  private current = 0;
  private epoch = 0;
  private held = new Map<number, { epoch: number; cell: DeckKey }>();
  private urgent = new Set<string>();
  private pinned?: string;
  private blockedUntilRelease = false;

  private readonly contentKeys: readonly number[];
  private get capacity(): number { return this.contentKeys.length; }

  constructor(layout?: DeckLayout, contentKeys: readonly number[] = CONTENT_KEYS) {
    if (!contentKeys.length || new Set(contentKeys).size !== contentKeys.length
      || contentKeys.some(key => !(CONTENT_KEYS as readonly number[]).includes(key))) {
      throw new Error('Content keys must be a nonempty unique subset of content positions');
    }
    this.contentKeys = [...contentKeys];
    if (!layout) return;
    if (layout.version !== 1 || !Array.isArray(layout.slots) || !Number.isInteger(layout.currentPage)
      || layout.currentPage < 0 || layout.currentPage >= Math.max(1, Math.ceil(layout.slots.length / this.capacity))) {
      throw new Error('Invalid or incompatible deck layout');
    }
    const seen = new Set<string>();
    for (const key of layout.slots) {
      if (key === null) continue;
      if (!key || typeof key.source !== 'string' || typeof key.id !== 'string' || seen.has(keyOf(key))) {
        throw new Error('Invalid or duplicate layout key');
      }
      seen.add(keyOf(key));
    }
    this.slots = layout.slots.map(key => key === null ? null : keyOf(key));
    this.current = layout.currentPage;
  }

  exportLayout(): DeckLayout {
    return { version: 1, slots: this.slots.map(key => {
      if (key === null) return null;
      const [source, id] = JSON.parse(key) as [string, string];
      return { source, id };
    }), currentPage: this.current };
  }

  update(records: readonly SessionRecord[]): void {
    this.records = new Map(records.map(record => [keyOf(record), structuredClone(record)]));
    this.slots = this.slots.map(key => key !== null && this.records.has(key) ? key : null);
    const assigned = new Set(this.slots);
    for (const key of this.records.keys()) {
      if (assigned.has(key)) continue;
      const hole = this.slots.indexOf(null);
      if (hole < 0) this.slots.push(key);
      else this.slots[hole] = key;
    }
    for (const key of this.urgent) {
      if (this.records.get(key)?.level !== 'urgent') this.urgent.delete(key);
    }
    for (const [key, record] of this.records) {
      if (record.level === 'urgent') this.urgent.add(key);
    }
    if (!this.pinned || !this.urgent.has(this.pinned)) this.pinned = this.urgent.values().next().value;
    this.trim();
  }

  private trim(): void {
    while (this.slots.length > (this.current + 1) * this.capacity && this.slots.at(-1) === null) this.slots.pop();
  }

  page(index = this.current): DeckPage {
    if (!Number.isFinite(index)) throw new RangeError('Page index must be finite');
    const requested = Math.max(0, Math.min(Math.trunc(index), this.pageCount - 1));
    if (requested !== this.current) {
      this.current = requested;
      this.epoch++;
      this.blockedUntilRelease = this.held.size > 0;
      this.trim();
    }
    const keys: DeckKey[] = Array.from({ length: 15 }, (_, index) => ({ type: 'empty', index }));
    this.contentKeys.forEach((physical, offset) => {
      const key = this.slots[this.current * this.capacity + offset];
      const record = key ? this.records.get(key) : undefined;
      if (record) keys[physical] = { type: 'signal', index: physical, record: structuredClone(record) };
    });
    let before = 0, after = 0;
    this.slots.forEach((key, slot) => {
      if (!key || !this.urgent.has(key)) return;
      if (slot < this.current * this.capacity) before++;
      if (slot >= (this.current + 1) * this.capacity) after++;
    });
    const pinned = this.pinned ? this.records.get(this.pinned) : undefined;
    keys[10] = { type: 'previous', index: 10, enabled: this.current > 0, urgentCount: before };
    keys[13] = { type: 'pin', index: 13, ...(pinned ? { record: structuredClone(pinned) } : {}), hiddenCount: Math.max(0, this.urgent.size - 1) };
    keys[14] = { type: 'next', index: 14, enabled: this.current < this.pageCount - 1, urgentCount: after };
    return { index: this.current, pageCount: this.pageCount, epoch: this.epoch, keys };
  }

  private get pageCount(): number { return Math.max(1, Math.ceil(this.slots.length / this.capacity), this.current + 1); }

  cancelInput(index?: number): void {
    if (index === undefined) this.held.clear();
    else this.held.delete(index);
    if (this.held.size === 0) this.blockedUntilRelease = false;
  }

  down(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= 15 || this.held.has(index)) return;
    this.held.set(index, { epoch: this.blockedUntilRelease ? -1 : this.epoch, cell: this.page().keys[index]! });
  }

  up(index: number): PressIntent | undefined {
    const binding = this.held.get(index);
    const blocked = this.blockedUntilRelease;
    this.held.delete(index);
    if (this.held.size === 0) this.blockedUntilRelease = false;
    if (blocked || !binding || binding.epoch !== this.epoch) return;
    const current = this.page().keys[index];
    const previous = binding.cell;
    if (!current || JSON.stringify(current) !== JSON.stringify(previous)) return;
    if (current.type === 'signal' && current.record.press) {
      const { source, id, revision, press } = current.record;
      return { type: 'effect', key: { source, id }, revision, effect: press };
    }
    if (current.type === 'pin' && current.record) {
      const { source, id } = current.record;
      const page = this.page(Math.floor(this.slots.indexOf(keyOf(current.record)) / this.capacity)).index;
      return { type: 'navigate', page, highlight: { source, id } };
    }
    if ((current.type === 'next' || current.type === 'previous') && current.enabled) {
      const page = this.page(this.current + (current.type === 'next' ? 1 : -1)).index;
      return { type: 'navigate', page };
    }
  }
}
