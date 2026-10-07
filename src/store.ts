import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialState, resultFor } from './collection.js';
import type { CreateRun, FinishReason, Run, RunStatus } from './contracts.js';

export class ConflictError extends Error {}

export const terminalStatuses = new Set<RunStatus>([
  'completed',
  'failed',
  'canceled',
]);

export class RunStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:')
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_status_created ON runs(status, created_at);
      CREATE TABLE IF NOT EXISTS suppression (number TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    `);
  }

  create(request: CreateRun, key: string): { run: Run; created: boolean } {
    const hash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const existing = this.db
      .prepare(
        'SELECT request_hash, payload FROM runs WHERE idempotency_key = ?',
      )
      .get(key);
    if (existing) {
      if (existing.request_hash !== hash)
        throw new ConflictError(
          'Idempotency-Key was already used for another request',
        );
      return {
        run: JSON.parse(String(existing.payload)) as Run,
        created: false,
      };
    }
    if (this.isSuppressed(request.to))
      throw new ConflictError('Destination has opted out');
    const at = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      status: 'queued',
      request,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      callSid: null,
      state: initialState(),
      transcript: [],
      result: null,
      error: null,
    };
    this.db
      .prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, key, hash, run.status, at, JSON.stringify(run));
    return { run, created: true };
  }

  get(id: string): Run | null {
    const row = this.db
      .prepare('SELECT payload FROM runs WHERE id = ?')
      .get(id);
    return row ? (JSON.parse(String(row.payload)) as Run) : null;
  }

  hasKey(key: string): boolean {
    return Boolean(
      this.db.prepare('SELECT id FROM runs WHERE idempotency_key = ?').get(key),
    );
  }

  save(run: Run): void {
    run.updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE runs SET status = ?, payload = ? WHERE id = ?')
      .run(run.status, JSON.stringify(run), run.id);
  }

  list(statuses: RunStatus[]): Run[] {
    if (!statuses.length) return [];
    const rows = this.db
      .prepare(
        `SELECT payload FROM runs WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`,
      )
      .all(...statuses);
    return rows.map((row) => JSON.parse(String(row.payload)) as Run);
  }

  finish(
    id: string,
    reason: FinishReason,
    status: RunStatus = 'completed',
    error: string | null = null,
  ): Run | null {
    const run = this.get(id);
    if (!run || terminalStatuses.has(run.status)) return run;
    run.status = status;
    run.result = resultFor(run.request.task, run.state, reason);
    run.error = error;
    this.save(run);
    return run;
  }

  suppress(number: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO suppression VALUES (?, ?)')
      .run(number, new Date().toISOString());
  }

  isSuppressed(number: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT number FROM suppression WHERE number = ?')
        .get(number),
    );
  }

  close(): void {
    this.db.close();
  }
}
