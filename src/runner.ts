import type { Config } from './config.js';
import type { DecisionEngine, FinishReason, Run } from './contracts.js';
import { opening } from './collection.js';
import { ConflictError, RunStore, terminalStatuses } from './store.js';
import type { Dialer } from './providers/twilio.js';
import type { CallSession } from './session.js';

export class Runner {
  readonly sessions = new Map<string, CallSession>();
  private timer: NodeJS.Timeout | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly simulatedTurns = new Set<string>();
  private stopping = false;

  constructor(
    readonly store: RunStore,
    readonly config: Config,
    readonly engine: DecisionEngine,
    readonly dialer: Dialer | null,
  ) {}

  async start(): Promise<void> {
    if (this.timer || this.stopping) return;
    for (const run of this.store.list(['dialing', 'in_progress'])) {
      await this.finish(
        run.id,
        'restarted',
        'Worker restarted; call requires review',
      );
    }
    this.timer = setInterval(() => {
      this.tick();
    }, 250);
    this.timer.unref();
    this.tick();
  }

  tick(): void {
    if (this.stopping) return;
    const active = this.store.list(['dialing', 'in_progress']);
    for (const run of active) {
      if (
        Date.now() - new Date(run.startedAt ?? run.createdAt).getTime() >
        (run.request.maxDurationSeconds + 60) * 1000
      ) {
        this.track(this.finish(run.id, 'max_duration'));
      }
    }
    let slots = this.config.MAX_CONCURRENT_CALLS - active.length;
    for (const run of this.store.list(['queued'])) {
      if (slots-- <= 0) break;
      if (this.store.isSuppressed(run.request.to)) {
        this.store.finish(run.id, 'opt_out');
        continue;
      }
      run.status =
        this.config.YAPPER_MODE === 'simulation' ? 'in_progress' : 'dialing';
      run.startedAt = new Date().toISOString();
      if (this.config.YAPPER_MODE === 'simulation')
        run.transcript.push({
          role: 'agent',
          text: opening(run.request.task),
          at: new Date().toISOString(),
        });
      this.store.save(run);
      if (this.dialer) this.track(this.dial(run));
    }
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.then(
      () => {
        this.pending.delete(promise);
      },
      () => {
        this.pending.delete(promise);
      },
    );
  }

  private async dial(run: Run): Promise<void> {
    try {
      const callSid = await this.dialer!.dial(run);
      const current = this.store.get(run.id)!;
      if (terminalStatuses.has(current.status)) {
        current.callSid = callSid;
        this.store.save(current);
        await this.hangup(run.id, callSid);
        return;
      }
      if (current.callSid && current.callSid !== callSid) {
        await this.dialer!.hangup(callSid);
        await this.finish(
          run.id,
          'provider_error',
          'Conflicting call identity',
        );
        return;
      }
      current.callSid = callSid;
      this.store.save(current);
    } catch {
      await this.finish(
        run.id,
        'provider_error',
        'Dial request failed or outcome is uncertain; not retried',
      );
    }
  }

  async simulate(id: string, text: string): Promise<Run> {
    const run = this.store.get(id);
    if (!run || run.status !== 'in_progress')
      throw new ConflictError('Run is not in progress');
    if (this.simulatedTurns.has(id))
      throw new ConflictError('A turn is already in progress');
    this.simulatedTurns.add(id);
    try {
      run.transcript.push({
        role: 'recipient',
        text,
        at: new Date().toISOString(),
      });
      this.store.save(run);
      const outcome = await this.engine.respond(
        run.request.task,
        run.state,
        run.transcript,
        new Date(),
      );
      const current = this.store.get(id)!;
      if (terminalStatuses.has(current.status)) return current;
      current.state = outcome.state;
      current.transcript.push({
        role: 'agent',
        text: outcome.text,
        at: new Date().toISOString(),
      });
      this.store.save(current);
      if (outcome.finishReason) await this.finish(id, outcome.finishReason);
      return this.store.get(id)!;
    } catch {
      await this.finish(id, 'provider_error', 'Decision provider failed');
      return this.store.get(id)!;
    } finally {
      this.simulatedTurns.delete(id);
    }
  }

  finish(
    id: string,
    reason: FinishReason,
    error?: string,
    hangup = true,
  ): Promise<void> {
    const promise = this.finishRun(id, reason, error, hangup);
    this.track(promise);
    return promise;
  }

  private async finishRun(
    id: string,
    reason: FinishReason,
    error?: string,
    hangup = true,
  ): Promise<void> {
    const run = this.store.get(id);
    if (!run || terminalStatuses.has(run.status)) return;
    if (reason === 'call_ended')
      reason = this.sessions.get(id)?.stopReason ?? reason;
    if (reason === 'opt_out') this.store.suppress(run.request.to);
    const status =
      reason === 'canceled'
        ? 'canceled'
        : reason === 'provider_error' || reason === 'restarted'
          ? 'failed'
          : 'completed';
    this.store.finish(id, reason, status, error ?? null);
    this.sessions.get(id)?.close();
    if (hangup && run.callSid && this.dialer) {
      await this.hangup(id, run.callSid);
    }
  }

  private async hangup(id: string, callSid: string): Promise<void> {
    try {
      await this.dialer!.hangup(callSid);
    } catch {
      const current = this.store.get(id)!;
      current.error =
        'Could not confirm call hangup; check the telephony provider';
      if (current.result) current.result.needsHuman = true;
      this.store.save(current);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const run of this.store.list(['dialing', 'in_progress']))
      await this.finish(run.id, 'restarted', 'Worker shut down during call');
    await Promise.allSettled([...this.pending]);
  }
}
