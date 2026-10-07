import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialState, resultFor } from './collection.js';
import type { CreateRun, FinishReason, Run, RunStatus } from './contracts.js';

export class ConflictError extends Error {}
export class CallbackNotDueError extends ConflictError {
  constructor(readonly retryAfter: number) {
    super('The agreed callback time has not arrived');
  }
}

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
      CREATE TABLE IF NOT EXISTS callback_keys (idempotency_key TEXT PRIMARY KEY, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suppression (number TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    `);
  }

  create(request: CreateRun, key: string): { run: Run; created: boolean } {
    const hash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const existing = this.getByKey(key);
    if (existing) {
      if (existing.requestHash !== hash)
        throw new ConflictError(
          'Idempotency-Key was already used for another request',
        );
      return {
        run: existing.run,
        created: false,
      };
    }
    if (this.isSuppressed(request.to))
      throw new ConflictError('Destination has opted out');
    const at = new Date().toISOString();
    const id = randomUUID();
    const run: Run = {
      id,
      status: 'queued',
      request,
      createdAt: at,
      startedAt: null,
      updatedAt: at,
      callSid: null,
      callEndedAt: null,
      state: initialState(),
      transcript: [],
      result: null,
      error: null,
      parentRunId: null,
      rootRunId: id,
      callbackRunId: null,
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
    return row ? hydrateRun(String(row.payload)) : null;
  }

  hasKey(key: string): boolean {
    return this.getByKey(key) !== null;
  }

  private getByKey(key: string): { requestHash: string; run: Run } | null {
    const row = this.db
      .prepare(
        `
      SELECT request_hash, payload FROM runs WHERE idempotency_key = ?
      UNION ALL
      SELECT runs.request_hash, runs.payload FROM callback_keys
      JOIN runs ON runs.id = callback_keys.run_id
      WHERE callback_keys.idempotency_key = ?
      LIMIT 1
    `,
      )
      .get(key, key);
    return row
      ? {
          requestHash: String(row.request_hash),
          run: hydrateRun(String(row.payload)),
        }
      : null;
  }

  createCallback(
    parentId: string,
    key: string,
    now: Date = new Date(),
  ): { run: Run; created: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.createCallbackInTransaction(parentId, key, now);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private createCallbackInTransaction(
    parentId: string,
    key: string,
    now: Date,
  ): { run: Run; created: boolean } {
    const parent = this.get(parentId);
    if (
      !parent ||
      parent.status !== 'completed' ||
      parent.result?.finishReason !== 'callback_requested' ||
      !parent.result.callback
    ) {
      throw new ConflictError('This run has no agreed callback request');
    }
    const keyed = this.getByKey(key);
    if (keyed) {
      const existing = keyed.run;
      if (existing.parentRunId !== parentId)
        throw new ConflictError(
          'Idempotency-Key was already used for another request',
        );
      return { run: existing, created: false };
    }
    if (parent.callbackRunId) {
      const existing = this.get(parent.callbackRunId);
      if (!existing) throw new Error('Linked callback run is missing');
      this.db
        .prepare('INSERT INTO callback_keys VALUES (?, ?)')
        .run(key, existing.id);
      return { run: existing, created: false };
    }
    if (this.isSuppressed(parent.request.to))
      throw new ConflictError('Destination has opted out');
    if (parent.error)
      throw new ConflictError(
        'Resolve the prior call error before placing a callback',
      );
    if (parent.callSid && !parent.callEndedAt)
      throw new ConflictError('The prior call has not been confirmed ended');
    const callbackAt = new Date(parent.result.callback.at).getTime();
    if (!Number.isFinite(callbackAt))
      throw new ConflictError('Callback time is invalid');
    const remaining = callbackAt - now.getTime();
    if (remaining > 0)
      throw new CallbackNotDueError(Math.ceil(remaining / 1000));
    const { run } = this.create(parent.request, key);
    run.parentRunId = parent.id;
    run.rootRunId = parent.rootRunId;
    run.state = {
      ...parent.state,
      responseCounts: { ...parent.state.responseCounts },
      identityConfirmed: false,
      turns: 0,
      offTopicCount: 0,
      informationComplete: false,
      lastDecision: null,
      paused: false,
      awaitingCallbackTime: false,
      pendingCallback: null,
      requiresPaymentRefresh: true,
    };
    parent.callbackRunId = run.id;
    const callbackHash = createHash('sha256')
      .update(JSON.stringify({ parentId, request: run.request }))
      .digest('hex');
    this.db
      .prepare('UPDATE runs SET request_hash = ? WHERE id = ?')
      .run(callbackHash, run.id);
    this.save(run);
    this.save(parent);
    return { run, created: true };
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
    return rows.map((row) => hydrateRun(String(row.payload)));
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

function hydrateRun(payload: string): Run {
  const run = JSON.parse(payload) as Run;
  run.state = { ...initialState(), ...run.state };
  run.parentRunId ??= null;
  run.rootRunId ??= run.id;
  run.callbackRunId ??= null;
  run.callEndedAt ??= null;
  if (run.result) run.result.callback ??= null;
  return run;
}
