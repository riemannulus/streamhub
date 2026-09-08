import type { DeckPage } from './index';

export type DisplayDevice = {
  write(frame: DeckPage, signal: AbortSignal): Promise<void>;
  standby(): Promise<void>;
  close(): Promise<void>;
};
export type LifecycleOptions = { timeoutMs?: number; onError?: (error: unknown) => void };
class DisplayTimeout extends Error {}

/** Serial display owner. Suspend is latched even when resume arrives during a write. */
export class DisplayLifecycle {
  private device?: DisplayDevice;
  private latest?: DeckPage;
  private version = 0;
  private rendered = -1;
  private allowed = false;
  private stopped = false;
  private failed = false;
  private cleanupRequested = false;
  private closeRequested = false;
  private cleared = false;
  private controller?: AbortController;
  private pump?: Promise<void>;
  private dirty = false;
  private held = new Set<number>();
  private armed = new Set<number>();
  private releaseRequired = false;
  private readonly timeoutMs: number;

  constructor(private readonly connect: () => Promise<DisplayDevice>, private readonly options: LifecycleOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new RangeError('Invalid display timeout');
  }
  get inputEnabled(): boolean {
    return this.allowed && !this.stopped && !this.failed && !!this.device && !this.controller
      && !this.cleanupRequested && !this.closeRequested && !this.releaseRequired && this.rendered === this.version;
  }
  setAllowed(allowed: boolean): Promise<void> {
    if (this.stopped) return this.pump ?? Promise.resolve();
    this.allowed = allowed;
    if (!allowed) {
      if (!this.cleared) this.cleanupRequested = true;
      this.invalidate();
    }
    return this.schedule();
  }
  present(frame: DeckPage): Promise<void> {
    if (this.stopped) return this.pump ?? Promise.resolve();
    this.latest = structuredClone(frame);
    this.version++;
    return this.schedule();
  }
  retry(): Promise<void> {
    if (this.stopped) return this.pump ?? Promise.resolve();
    this.failed = false;
    return this.schedule();
  }
  stop(): Promise<void> {
    if (this.stopped) return this.pump ?? Promise.resolve();
    this.stopped = true;
    this.allowed = false;
    if (!this.cleared) this.cleanupRequested = true;
    this.invalidate();
    return this.schedule();
  }
  disconnected(): Promise<void> {
    if (this.stopped) return this.pump ?? Promise.resolve();
    this.failed = true;
    this.closeRequested = true;
    this.invalidate();
    return this.schedule();
  }
  noteKey(index: number, edge: 'down' | 'up'): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= 15) return false;
    if (edge === 'down') {
      if (this.held.has(index)) return false;
      const accepted = this.inputEnabled;
      this.held.add(index);
      if (accepted) this.armed.add(index);
      return accepted;
    }
    const accepted = this.inputEnabled && this.armed.has(index);
    this.held.delete(index);
    this.armed.delete(index);
    if (!this.held.size) this.releaseRequired = false;
    return accepted;
  }
  private invalidate(): void {
    this.controller?.abort();
    this.armed.clear();
    this.releaseRequired = this.held.size > 0;
    this.rendered = -1;
  }
  private schedule(): Promise<void> {
    this.dirty = true;
    if (this.pump) return this.pump;
    let complete!: () => void;
    const pump = new Promise<void>(resolve => { complete = resolve; });
    this.pump = pump;
    queueMicrotask(async () => {
      try {
        do {
          this.dirty = false;
          await this.reconcile();
        } while (this.dirty);
      } catch (error) { this.failed = true; this.invalidate(); this.report(error); }
      finally {
        // Clear and resolve synchronously: no request can land in a completion gap.
        this.pump = undefined;
        complete();
      }
    });
    return pump;
  }
  private report(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* observers cannot break cleanup */ }
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DisplayTimeout('Display operation timed out')), this.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  private async close(device: DisplayDevice): Promise<boolean> {
    try { await this.bounded(device.close()); return true; }
    catch (error) { this.report(error); return false; }
  }
  private async open(): Promise<void> {
    const pending = this.connect();
    try { this.device = await this.bounded(pending); }
    catch (error) {
      // A connection arriving after timeout must never become the active handle.
      void pending.then(device => this.close(device), () => {});
      throw error;
    }
    this.cleared = false;
    this.rendered = -1;
  }
  private async reconcile(): Promise<void> {
    try {
      while (true) {
        if (this.closeRequested) {
          this.closeRequested = false;
          const device = this.device;
          this.device = undefined;
          if (device && !await this.close(device)) this.failed = true;
        }
        // Failed/timed-out handles are quarantined. Stop does not reopen hardware;
        // standby/logo cannot be guaranteed after failure until an explicit retry.
        if (this.failed) return;
        if (this.cleanupRequested) {
          if (!this.device) await this.open();
          await this.bounded(this.device!.standby());
          const device = this.device!;
          this.device = undefined;
          if (!await this.close(device)) this.failed = true;
          this.cleanupRequested = false;
          this.cleared = true;
          continue;
        }
        if (!this.allowed || this.stopped || !this.latest) return;
        if (!this.device) { await this.open(); continue; }
        if (this.rendered === this.version) return;
        const version = this.version;
        const controller = new AbortController();
        this.controller = controller;
        this.armed.clear();
        this.releaseRequired = this.held.size > 0;
        try { await this.bounded(this.device.write(this.latest, controller.signal)); }
        catch (error) {
          if (error instanceof DisplayTimeout) { controller.abort(); throw error; }
          if (!controller.signal.aborted) throw error;
        }
        finally { this.controller = undefined; }
        if (!controller.signal.aborted && this.allowed && !this.cleanupRequested && !this.closeRequested) {
          this.rendered = version;
          this.releaseRequired = this.held.size > 0;
        }
      }
    } catch (error) {
      this.failed = true;
      this.invalidate();
      const device = this.device;
      this.device = undefined;
      this.report(error);
      if (device) await this.close(device);
    }
  }
}
