import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as settle } from 'node:timers/promises';
import test from 'node:test';
import { loadConfig, type Config } from '../src/config.js';
import { CreateRunSchema, type Run } from '../src/contracts.js';
import { SimulationDecisionEngine } from '../src/providers/jev.js';
import type { Dialer } from '../src/providers/twilio.js';
import { Runner } from '../src/runner.js';
import { ConflictError, RunStore } from '../src/store.js';

const request = CreateRunSchema.parse({
  to: '+14155550123',
  voice: { provider: 'elevenlabs', voiceId: 'test_voice' },
  task: {
    type: 'payment_collection',
    recipientName: 'Jane Doe',
    organization: 'Example Services',
    amountMinor: 12500,
    currency: 'USD',
    reference: 'INV-100',
    deadline: '2030-12-31',
    timezone: 'America/Los_Angeles',
  },
  authorization: { consentToCall: true, consentToTranscribe: true },
});

class DeferredDial {
  private resolve: ((sid: string) => void) | null = null;
  readonly promise = new Promise<string>((resolve) => {
    this.resolve = resolve;
  });

  complete(sid: string): void {
    this.resolve?.(sid);
  }
}

class ControlledDialer implements Dialer {
  readonly calls: string[] = [];
  readonly hangups: string[] = [];
  readonly deferred = new Map<string, DeferredDial>();
  delayDial = false;
  failHangup = false;
  hangupGate: DeferredDial | null = null;

  dial(run: Run): Promise<string> {
    this.calls.push(run.id);
    if (!this.delayDial)
      return Promise.resolve(`CA${run.id.replaceAll('-', '')}`);
    const deferred = new DeferredDial();
    this.deferred.set(run.id, deferred);
    return deferred.promise;
  }

  async hangup(sid: string): Promise<void> {
    this.hangups.push(sid);
    if (this.hangupGate) await this.hangupGate.promise;
    if (this.failHangup) throw new Error('Controlled telephony outage');
  }

  complete(runId: string, sid: string): void {
    assert.ok(
      this.deferred.has(runId),
      'The run must have reached the dial boundary',
    );
    this.deferred.get(runId)!.complete(sid);
    this.deferred.delete(runId);
  }

  releaseAll(): void {
    for (const [id, deferred] of this.deferred)
      deferred.complete(`CA${id.replaceAll('-', '')}`);
    this.deferred.clear();
    this.hangupGate?.complete('cleanup');
  }
}

class RunnerHarness {
  readonly directory = mkdtempSync(join(tmpdir(), 'yapper-runner-'));
  readonly databasePath = join(this.directory, 'runs.sqlite');
  readonly dialer = new ControlledDialer();
  readonly config: Config;
  store: RunStore;
  runner: Runner;

  constructor(concurrency = 2) {
    this.config = loadConfig({
      YAPPER_MODE: 'live',
      YAPPER_API_KEY: 'runner-integration-test-key-at-least-32-chars',
      DATABASE_PATH: this.databasePath,
      PUBLIC_BASE_URL: 'https://yapper.example.test',
      MAX_CONCURRENT_CALLS: String(concurrency),
      ALLOWED_NUMBERS: request.to,
      TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
      TWILIO_AUTH_TOKEN: 'test-only-token',
      TWILIO_FROM_NUMBER: '+14155550124',
      DEEPGRAM_API_KEY: 'test-only-key',
      TYPESAFE_API_KEY: 'test-only-key',
    });
    this.store = new RunStore(this.databasePath);
    this.runner = new Runner(
      this.store,
      this.config,
      new SimulationDecisionEngine(),
      this.dialer,
    );
  }

  create(number = request.to): Run {
    return this.store.create({ ...request, to: number }, randomUUID()).run;
  }

  reopen(): void {
    this.store.close();
    this.store = new RunStore(this.databasePath);
    this.runner = new Runner(
      this.store,
      this.config,
      new SimulationDecisionEngine(),
      this.dialer,
    );
  }

  markConnected(id: string, confirmed = false): void {
    const run = this.store.get(id)!;
    assert.equal(run.status, 'dialing');
    run.status = 'in_progress';
    run.state.identityConfirmed = confirmed;
    this.store.save(run);
  }

  async close(): Promise<void> {
    this.dialer.releaseAll();
    await this.runner.stop();
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

test('queued work survives a closed database and is dispatched exactly once after reopening', async (context) => {
  const harness = new RunnerHarness();
  context.after(() => harness.close());
  const queued = harness.create();
  harness.reopen();
  assert.equal(harness.store.get(queued.id)?.status, 'queued');
  await harness.runner.start();
  await settle();
  harness.runner.tick();
  await settle();
  assert.deepEqual(harness.dialer.calls, [queued.id]);
  const durable = new RunStore(harness.databasePath);
  try {
    const stored = durable.get(queued.id)!;
    assert.equal(stored.status, 'dialing');
    assert.equal(stored.callSid, `CA${queued.id.replaceAll('-', '')}`);
    assert.ok(stored.startedAt);
  } finally {
    durable.close();
  }
});

test('restart fails both interrupted active states without redialing them and resumes queued work', async (context) => {
  const harness = new RunnerHarness();
  context.after(() => harness.close());
  const dialing = harness.create();
  dialing.status = 'dialing';
  harness.store.save(dialing);
  const connected = harness.create('+14155550125');
  connected.status = 'in_progress';
  connected.callSid = `CA${'1'.repeat(32)}`;
  harness.store.save(connected);
  const queued = harness.create('+14155550126');
  harness.reopen();
  await harness.runner.start();
  await settle();
  for (const id of [dialing.id, connected.id]) {
    const recovered = harness.store.get(id)!;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.result?.finishReason, 'restarted');
    assert.equal(recovered.result?.needsHuman, true);
    assert.match(recovered.error ?? '', /restarted/);
  }
  assert.deepEqual(harness.dialer.calls, [queued.id]);
  assert.deepEqual(harness.dialer.hangups, [connected.callSid]);
});

test('concurrency counts unresolved dial requests and dispatches the next queued call only after a slot frees', async (context) => {
  const harness = new RunnerHarness(2);
  harness.dialer.delayDial = true;
  context.after(() => harness.close());
  const runs = [
    harness.create(),
    harness.create('+14155550125'),
    harness.create('+14155550126'),
  ];
  harness.runner.tick();
  harness.runner.tick();
  assert.equal(harness.store.list(['dialing']).length, 2);
  assert.equal(harness.store.list(['queued']).length, 1);
  assert.equal(harness.dialer.calls.length, 2);
  const active = harness.store.list(['dialing'])[0]!;
  await harness.runner.finish(active.id, 'canceled');
  harness.runner.tick();
  assert.equal(harness.store.list(['dialing']).length, 2);
  assert.equal(harness.store.list(['queued']).length, 0);
  assert.equal(harness.dialer.calls.length, 3);
  assert.deepEqual(
    new Set(harness.dialer.calls),
    new Set(runs.map((run) => run.id)),
  );
});

test('an actual opt-out decision durably suppresses queued and newly submitted calls to the same number', async (context) => {
  const harness = new RunnerHarness(1);
  context.after(() => harness.close());
  const first = harness.create();
  const second = harness.create();
  harness.runner.tick();
  await settle();
  harness.markConnected(first.id);
  const optedOut = await harness.runner.simulate(first.id, 'Stop calling me');
  assert.equal(optedOut.result?.finishReason, 'opt_out');
  assert.equal(harness.store.isSuppressed(request.to), true);
  harness.runner.tick();
  assert.deepEqual(harness.dialer.calls, [first.id]);
  assert.equal(harness.store.get(second.id)?.result?.finishReason, 'opt_out');
  assert.equal(harness.store.get(second.id)?.status, 'completed');
  const durable = new RunStore(harness.databasePath);
  try {
    assert.equal(durable.isSuppressed(request.to), true);
    assert.throws(() => durable.create(request, randomUUID()), ConflictError);
  } finally {
    durable.close();
  }
});

test('cancel during an unresolved dial persists the returned call SID and hangs up without reviving the run', async (context) => {
  const harness = new RunnerHarness();
  harness.dialer.delayDial = true;
  context.after(() => harness.close());
  const queued = harness.create();
  harness.runner.tick();
  await harness.runner.finish(queued.id, 'canceled');
  assert.equal(harness.store.get(queued.id)?.callSid, null);
  const sid = `CA${'2'.repeat(32)}`;
  harness.dialer.complete(queued.id, sid);
  await settle();
  const canceled = harness.store.get(queued.id)!;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.result?.finishReason, 'canceled');
  assert.equal(canceled.callSid, sid);
  assert.deepEqual(harness.dialer.hangups, [sid]);
  await harness.runner.finish(queued.id, 'information_complete');
  await harness.runner.finish(
    queued.id,
    'provider_error',
    'Late provider callback',
  );
  assert.deepEqual(harness.store.get(queued.id), canceled);
  const durable = new RunStore(harness.databasePath);
  try {
    assert.equal(durable.get(queued.id)?.callSid, sid);
  } finally {
    durable.close();
  }
});

test('failed hangup after a canceled deferred dial retains the call SID and actionable escalation', async (context) => {
  const harness = new RunnerHarness();
  harness.dialer.delayDial = true;
  harness.dialer.failHangup = true;
  context.after(() => harness.close());
  const queued = harness.create();
  harness.runner.tick();
  await harness.runner.finish(queued.id, 'canceled');
  const sid = `CA${'3'.repeat(32)}`;
  harness.dialer.complete(queued.id, sid);
  await settle();
  const canceled = harness.store.get(queued.id)!;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.callSid, sid);
  assert.equal(canceled.result?.finishReason, 'canceled');
  assert.equal(canceled.result?.needsHuman, true);
  assert.match(canceled.error ?? '', /Could not confirm call hangup/);
});

test('failed hangup escalates an otherwise complete real decision while retaining its payment report', async (context) => {
  const harness = new RunnerHarness();
  harness.dialer.failHangup = true;
  context.after(() => harness.close());
  const queued = harness.create();
  harness.runner.tick();
  await settle();
  harness.markConnected(queued.id, true);
  const completed = await harness.runner.simulate(queued.id, 'I already paid');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result?.finishReason, 'information_complete');
  assert.equal(completed.result?.informationComplete, true);
  assert.equal(completed.result?.paymentStatus, 'reported_paid');
  assert.equal(completed.result?.paymentVerified, false);
  assert.equal(completed.result?.needsHuman, true);
  assert.match(completed.error ?? '', /Could not confirm call hangup/);
  assert.deepEqual(harness.dialer.hangups, [completed.callSid]);
});

test('a natural provider completion records the outcome without issuing an unnecessary hangup', async (context) => {
  const harness = new RunnerHarness();
  context.after(() => harness.close());
  const queued = harness.create();
  harness.runner.tick();
  await settle();
  await harness.runner.finish(queued.id, 'call_ended', undefined, false);
  const ended = harness.store.get(queued.id)!;
  assert.equal(ended.status, 'completed');
  assert.equal(ended.result?.finishReason, 'call_ended');
  assert.equal(ended.result?.needsHuman, true);
  assert.deepEqual(harness.dialer.hangups, []);
  await harness.runner.finish(queued.id, 'information_complete');
  assert.deepEqual(harness.store.get(queued.id), ended);
});

test('shutdown waits for an already terminal run to finish hanging up and persist a delayed failure before database close', async (context) => {
  const harness = new RunnerHarness();
  context.after(() => harness.close());
  const queued = harness.create();
  harness.runner.tick();
  await settle();
  harness.dialer.hangupGate = new DeferredDial();
  harness.dialer.failHangup = true;
  const finishing = harness.runner.finish(queued.id, 'call_ended');
  assert.equal(harness.store.get(queued.id)?.status, 'completed');
  assert.equal(harness.dialer.hangups.length, 1);
  let shutdownComplete = false;
  const stopping = harness.runner.stop().then(() => {
    shutdownComplete = true;
  });
  await settle();
  assert.equal(
    shutdownComplete,
    false,
    'Shutdown must wait for the pending telephony response',
  );
  assert.equal(harness.store.get(queued.id)?.error, null);
  harness.dialer.hangupGate.complete('telephony response');
  await Promise.all([stopping, finishing]);
  assert.equal(shutdownComplete, true);
  harness.reopen();
  const durable = harness.store.get(queued.id)!;
  assert.equal(durable.status, 'completed');
  assert.equal(durable.result?.finishReason, 'call_ended');
  assert.equal(durable.result?.needsHuman, true);
  assert.match(durable.error ?? '', /Could not confirm call hangup/);
});
