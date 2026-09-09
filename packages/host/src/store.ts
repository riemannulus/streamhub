import { Database } from 'bun:sqlite';
import { applyCommand, initialState, type CoreCommand, type CoreState } from '../../core/src/index';

export class AlreadyRunningError extends Error {
  constructor(readonly path: string, cause: unknown) {
    super('Another host owns this database', { cause });
    this.name = 'AlreadyRunningError';
  }
}

function isOwnershipConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code);
}

/** Single-process durable host. Core remains independent of SQLite and Bun. */
export class SignalStore {
  private readonly db: Database;
  private readonly owner?: Database;
  constructor(path: string, private readonly now: () => number = Date.now) {
    if (path !== ':memory:') {
      this.owner = new Database(`${path}.owner`, { create: true });
      try { this.owner.exec('BEGIN EXCLUSIVE'); }
      catch (error) {
        this.owner.close();
        if (isOwnershipConflict(error)) throw new AlreadyRunningError(path, error);
        throw error;
      }
    }
    try { this.db = new Database(path, { create: true, strict: true }); }
    catch (error) { this.owner?.close(); throw error; }
    try {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS view_state (name TEXT PRIMARY KEY, body TEXT NOT NULL)');
      const row = this.db.query<{ version: number; body: string }, []>('SELECT version, body FROM state WHERE id = 1').get();
      if (row && row.version !== 1) throw new Error('Unsupported database version');
      const state = row ? applyCommand(JSON.parse(row.body), { op: 'restore' }, now()) : initialState();
      this.save(state);
    } catch (error) { this.db.close(); this.owner?.close(); throw error; }
  }
  state(): CoreState {
    const row = this.db.query<{ body: string }, []>('SELECT body FROM state WHERE id = 1').get();
    if (!row) throw new Error('Missing database state');
    return JSON.parse(row.body);
  }
  records() { return this.state().records; }
  apply(command: CoreCommand): CoreState {
    return this.db.transaction(() => {
      const state = applyCommand(this.state(), command, this.now());
      this.save(state);
      return state;
    })();
  }
  private save(state: CoreState) {
    this.db.query('INSERT INTO state (id, version, body) VALUES (1, 1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(JSON.stringify(state));
  }
  getViewState(name:string):unknown {
    const row=this.db.query<{body:string},[string]>('SELECT body FROM view_state WHERE name = ?').get(name);
    return row ? JSON.parse(row.body) : undefined;
  }
  setViewState(name:string,value:unknown):void {
    this.db.query('INSERT INTO view_state (name,body) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name,JSON.stringify(value));
  }
  close() { try { this.db.close(); } finally { this.owner?.close(); } }
}
