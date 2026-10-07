import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  CreateRunSchema,
  type CollectionState,
  type CollectionTask,
  type DecisionEngine,
  type FinishReason,
  type SpeechProvider,
  type TranscriptEntry,
  type Transcriber,
  type TranscriptionCallbacks,
  type TurnOutcome,
} from '../src/contracts.js';
import { CallSession } from '../src/session.js';
import { RunStore } from '../src/store.js';

const accountSid = `AC${'1'.repeat(32)}`;
const callSid = `CA${'2'.repeat(32)}`;
const streamSid = `MZ${'3'.repeat(32)}`;
const openingAudio = Buffer.from([255, 127, 240, 112]);
const responseAudio = Buffer.from([225, 97, 208, 80]);

interface MediaMessage {
  event: string;
  streamSid: string;
  media?: { payload: string };
  mark?: { name: string };
}

class Gate {
  readonly promise: Promise<void>;
  release!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.release = resolve;
    });
  }
}

interface SpeechPlan {
  chunks: Buffer[];
  gate?: Gate;
}

class ControlledSpeech implements SpeechProvider {
  readonly calls: { text: string; signal: AbortSignal; completed: boolean }[] =
    [];
  readonly plans: SpeechPlan[] = [];

  async *synthesize(text: string, _voiceId: string, signal: AbortSignal) {
    const call = { text, signal, completed: false };
    this.calls.push(call);
    const plan = this.plans.shift() ?? { chunks: [responseAudio] };
    try {
      for (let index = 0; index < plan.chunks.length; index += 1) {
        if (index === 1 && plan.gate) await plan.gate.promise;
        yield plan.chunks[index]!;
      }
    } finally {
      call.completed = true;
    }
  }
}

class ControlledEngine implements DecisionEngine {
  readonly calls: {
    signal?: AbortSignal;
    completed: boolean;
    state: CollectionState;
    transcript: TranscriptEntry[];
  }[] = [];
  readonly plans: { outcome: TurnOutcome; gate?: Gate }[] = [];

  async respond(
    _task: CollectionTask,
    state: CollectionState,
    transcript: TranscriptEntry[],
    _now: Date,
    signal?: AbortSignal,
  ): Promise<TurnOutcome> {
    const call = {
      signal,
      completed: false,
      state: structuredClone(state),
      transcript: structuredClone(transcript),
    };
    this.calls.push(call);
    const plan = this.plans.shift();
    assert.ok(plan, 'A response plan must be configured');
    if (plan.gate) await plan.gate.promise;
    call.completed = true;
    return plan.outcome;
  }
}

class SessionHarness implements Transcriber {
  readonly directory = mkdtempSync(join(tmpdir(), 'yapper-session-'));
  readonly store = new RunStore(join(this.directory, 'calls.sqlite'));
  readonly speech = new ControlledSpeech();
  readonly engine = new ControlledEngine();
  readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  readonly frames: MediaMessage[] = [];
  readonly inboundAudio: Buffer[] = [];
  readonly finishes: { reason: FinishReason; error?: string }[] = [];
  readonly runId: string;
  session: CallSession | null = null;
  client: WebSocket | null = null;
  callbacks: TranscriptionCallbacks | null = null;
  transcriberClosed = false;
  sessionClosed = false;

  constructor() {
    const request = CreateRunSchema.parse({
      to: '+15555550123',
      voice: { provider: 'elevenlabs', voiceId: 'test-voice' },
      task: {
        type: 'payment_collection',
        recipientName: 'Alex Example',
        organization: 'Example Services',
        amountMinor: 25000,
        currency: 'USD',
        reference: 'INV-EXAMPLE-001',
        deadline: '2026-10-01',
        timezone: 'America/Los_Angeles',
      },
      authorization: { consentToCall: true, consentToTranscribe: true },
    });
    const { run } = this.store.create(request, 'session-test-001');
    run.status = 'dialing';
    run.callSid = callSid;
    this.store.save(run);
    this.runId = run.id;
    this.server.on('connection', this.connect.bind(this));
  }

  async start(): Promise<void> {
    if (!this.server.address()) await once(this.server, 'listening');
    const port = (this.server.address() as AddressInfo).port;
    this.client = new WebSocket(`ws://127.0.0.1:${port}/media`);
    this.client.on('message', this.record.bind(this));
    await once(this.client, 'open');
    assert.ok(this.session);
  }

  private connect(socket: WebSocket): void {
    this.session = new CallSession({
      id: this.runId,
      socket,
      store: this.store,
      engine: this.engine,
      speech: this.speech,
      accountSid,
      transcriberFactory: this.createTranscriber.bind(this),
      onFinish: this.finish.bind(this),
      onClosed: this.closed.bind(this),
    });
  }

  private createTranscriber(callbacks: TranscriptionCallbacks): Transcriber {
    this.callbacks = callbacks;
    return this;
  }

  private record(data: RawData): void {
    this.frames.push(JSON.parse(String(data)) as MediaMessage);
  }

  private async finish(
    _id: string,
    reason: FinishReason,
    error?: string,
  ): Promise<void> {
    this.finishes.push({ reason, error });
    this.store.finish(
      this.runId,
      reason,
      reason === 'provider_error' ? 'failed' : 'completed',
      error,
    );
  }

  private closed(): void {
    this.sessionClosed = true;
  }

  send(audio: Buffer): void {
    this.inboundAudio.push(audio);
  }

  close(): void {
    this.transcriberClosed = true;
  }

  startMedia(overrides: { accountSid?: string; callSid?: string } = {}): void {
    this.client!.send(
      JSON.stringify({
        event: 'start',
        start: {
          accountSid,
          callSid,
          streamSid,
          mediaFormat: {
            encoding: 'audio/x-mulaw',
            sampleRate: 8000,
            channels: 1,
          },
          ...overrides,
        },
      }),
    );
  }

  acknowledge(name: string): void {
    this.client!.send(
      JSON.stringify({ event: 'mark', streamSid, mark: { name } }),
    );
  }

  async flush(): Promise<void> {
    const pong = once(this.client!, 'pong');
    this.client!.ping();
    await pong;
  }

  async playOpening(clear = true): Promise<void> {
    this.startMedia();
    const acknowledged = new Set<string>();
    const deadline = Date.now() + 3000;
    while (this.store.get(this.runId)!.transcript[0]?.delivery !== 'played') {
      assert.ok(Date.now() < deadline, 'Opening did not finish playing');
      for (const name of this.marks()) {
        if (acknowledged.has(name)) continue;
        this.acknowledge(name);
        acknowledged.add(name);
      }
      await this.flush();
      await delay(5);
    }
    if (clear) {
      this.frames.length = 0;
      this.speech.calls.length = 0;
    }
  }

  outcome(text: string, finishReason?: FinishReason): TurnOutcome {
    return {
      state: { ...this.store.get(this.runId)!.state, identityConfirmed: true },
      text,
      ...(finishReason ? { finishReason } : {}),
    };
  }

  marks(): string[] {
    return this.frames
      .filter((frame) => frame.event === 'mark')
      .map((frame) => frame.mark!.name);
  }

  audio(): Buffer[] {
    return this.frames
      .filter((frame) => frame.event === 'media')
      .map((frame) => Buffer.from(frame.media!.payload, 'base64'));
  }

  async dispose(): Promise<void> {
    for (const plan of this.speech.plans) plan.gate?.release();
    for (const plan of this.engine.plans) plan.gate?.release();
    this.session?.close();
    this.client?.terminate();
    for (const socket of this.server.clients) socket.terminate();
    const closed = once(this.server, 'close');
    this.server.close();
    await closed;
    this.store.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected session event did not arrive');
    await delay(5);
  }
}

test('media start rejects a mismatched account or call before opening speech', async (t) => {
  for (const overrides of [
    { accountSid: `AC${'4'.repeat(32)}` },
    { callSid: `CA${'5'.repeat(32)}` },
  ]) {
    const harness = new SessionHarness();
    t.after(harness.dispose.bind(harness));
    await harness.start();
    harness.startMedia(overrides);
    await waitFor(() => harness.finishes.length === 1);
    assert.equal(harness.finishes[0]!.reason, 'provider_error');
    assert.match(harness.finishes[0]!.error!, /authorized call/);
    assert.equal(harness.speech.calls.length, 0);
    assert.equal(harness.callbacks, null);
    assert.equal(harness.store.get(harness.runId)!.status, 'failed');
  }
});

test('a real WebSocket carries opening audio, playback marks, and inbound telephone bytes', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  harness.speech.plans.push({ chunks: [openingAudio] });
  await harness.start();
  await harness.playOpening(false);
  assert.deepEqual(harness.audio()[0], openingAudio);
  assert.equal(harness.audio().length, harness.speech.calls.length);
  assert.ok(harness.marks().length > 1);
  assert.equal(harness.store.get(harness.runId)!.status, 'in_progress');
  harness.client!.send(
    JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: responseAudio.toString('base64') },
    }),
  );
  await harness.flush();
  assert.deepEqual(harness.inboundAudio, [responseAudio]);
  assert.equal(harness.finishes.length, 0);
  assert.equal(
    harness.store.get(harness.runId)!.transcript[0]!.interrupted,
    undefined,
  );
  const opening = harness.store.get(harness.runId)!.transcript[0]!;
  assert.equal(opening.delivery, 'played');
  assert.equal(opening.deliveredText, opening.text);
});

test('speech start aborts synthesis, clears playback, and drops late audio from the old response', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  const delayedAudio = new Gate();
  t.after(delayedAudio.release);
  const staleAudio = Buffer.from([1, 2, 3, 4]);
  harness.speech.plans.push({
    chunks: [openingAudio, staleAudio],
    gate: delayedAudio,
  });
  await harness.start();
  harness.startMedia();
  await waitFor(() => harness.audio().length === 1);
  harness.callbacks!.onSpeechStarted();
  assert.equal(harness.speech.calls[0]!.signal.aborted, true);
  harness.engine.plans.push({
    outcome: harness.outcome('Has the payment been made?'),
  });
  harness.callbacks!.onTranscript('Yes, this is Alex Example.');
  await waitFor(() => harness.marks().length === 1);
  delayedAudio.release();
  await waitFor(() => harness.speech.calls[0]!.completed);
  await harness.flush();
  assert.ok(harness.frames.some((frame) => frame.event === 'clear'));
  assert.deepEqual(harness.audio(), [openingAudio, responseAudio]);
  assert.equal(
    harness.store.get(harness.runId)!.transcript[0]!.interrupted,
    true,
  );
  assert.equal(harness.finishes.length, 0);
});

test('an interrupted asynchronous decision cannot overwrite a newer turn or generate stale speech', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  const delayedDecision = new Gate();
  t.after(delayedDecision.release);
  await harness.start();
  await harness.playOpening();
  const staleOutcome = harness.outcome('STALE RESPONSE');
  staleOutcome.state.paymentStatus = 'reported_paid';
  const currentOutcome = harness.outcome('On which date will you pay?');
  currentOutcome.state.paymentStatus = 'unpaid';
  harness.engine.plans.push(
    { outcome: staleOutcome, gate: delayedDecision },
    { outcome: currentOutcome },
  );
  harness.callbacks!.onTranscript('Yes, this is Alex Example. I think I paid.');
  await waitFor(() => harness.engine.calls.length === 1);
  harness.callbacks!.onSpeechStarted();
  assert.equal(harness.engine.calls[0]!.signal!.aborted, true);
  harness.callbacks!.onTranscript('Actually, I have not paid.');
  await waitFor(() => harness.marks().length === 1);
  const currentRecipientText = harness.engine.calls[1]!.transcript.filter(
    (entry) => entry.role === 'recipient',
  )
    .map((entry) => entry.text)
    .join(' ');
  assert.match(currentRecipientText, /Yes, this is Alex Example/);
  assert.match(currentRecipientText, /Actually, I have not paid/);
  delayedDecision.release();
  await waitFor(() => harness.engine.calls[0]!.completed);
  await harness.flush();
  const run = harness.store.get(harness.runId)!;
  assert.equal(run.state.paymentStatus, 'unpaid');
  assert.equal(run.transcript.at(-1)!.text, currentOutcome.text);
  assert.ok(!run.transcript.some((entry) => entry.text === 'STALE RESPONSE'));
  assert.deepEqual(
    harness.speech.calls.map((call) => call.text),
    [currentOutcome.text],
  );
});

test('cleared goodbye marks cannot finish a newer turn and the final goodbye waits for its own playback mark', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  harness.engine.plans.push({
    outcome: harness.outcome(
      'Thank you for the update. Goodbye.',
      'information_complete',
    ),
  });
  harness.callbacks!.onTranscript('I already paid.');
  await waitFor(() => harness.marks().length === 2);
  const clearedMarks = harness.marks();
  assert.equal(harness.finishes.length, 0);
  harness.callbacks!.onSpeechStarted();
  for (const name of clearedMarks) harness.acknowledge(name);
  await harness.flush();
  assert.equal(harness.finishes.length, 0);
  harness.engine.plans.push({
    outcome: harness.outcome(
      'A colleague will follow up. Goodbye.',
      'needs_human',
    ),
  });
  harness.callbacks!.onTranscript('Wait, I need someone to review this.');
  await waitFor(() => harness.marks().length === 4);
  const finalMark = harness.marks()[3]!;
  assert.ok(!clearedMarks.includes(finalMark));
  for (const name of clearedMarks) harness.acknowledge(name);
  harness.acknowledge(harness.marks()[2]!);
  await harness.flush();
  assert.equal(harness.finishes.length, 0);
  assert.equal(harness.store.get(harness.runId)!.status, 'in_progress');
  harness.acknowledge(finalMark);
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'needs_human');
  assert.equal(harness.transcriberClosed, true);
  assert.equal(harness.sessionClosed, true);
  assert.equal(
    harness.store.get(harness.runId)!.result!.finishReason,
    'needs_human',
  );
});

test('interrupting an opt-out goodbye preserves suppression and cannot reopen the collection task', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  harness.engine.plans.push({
    outcome: harness.outcome('I will stop calling. Goodbye.', 'opt_out'),
  });
  harness.callbacks!.onTranscript('Do not call me again.');
  await waitFor(() => harness.marks().length === 2);
  assert.equal(harness.store.isSuppressed('+15555550123'), true);
  assert.equal(harness.finishes.length, 0);
  harness.callbacks!.onSpeechStarted();
  harness.callbacks!.onTranscript('Another sentence while the call closes.');
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'opt_out');
  assert.equal(harness.engine.calls.length, 1);
  assert.equal(
    harness.store.get(harness.runId)!.result!.finishReason,
    'opt_out',
  );
  assert.equal(harness.store.isSuppressed('+15555550123'), true);
});

test('a peer disconnect during an opt-out goodbye retains its terminal reason', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  harness.engine.plans.push({
    outcome: harness.outcome('I will stop calling. Goodbye.', 'opt_out'),
  });
  harness.callbacks!.onTranscript('Please stop calling me.');
  await waitFor(() => harness.marks().length === 2);
  harness.client!.close();
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'opt_out');
  assert.equal(harness.store.isSuppressed('+15555550123'), true);
});

test('a carrier stop event during an opt-out goodbye retains its terminal reason', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  harness.engine.plans.push({
    outcome: harness.outcome('I will stop calling. Goodbye.', 'opt_out'),
  });
  harness.callbacks!.onTranscript('Please stop calling me.');
  await waitFor(() => harness.marks().length === 2);
  harness.client!.send(JSON.stringify({ event: 'stop', streamSid }));
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'opt_out');
  assert.equal(harness.store.isSuppressed('+15555550123'), true);
});

test('sentence playback stays bounded and an interruption preserves only the acknowledged prefix', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  const delayedAudio = new Gate();
  t.after(delayedAudio.release);
  await harness.start();
  await harness.playOpening();
  const staleAudio = Buffer.from([11, 12, 13, 14]);
  harness.speech.plans.push(
    { chunks: [responseAudio] },
    { chunks: [responseAudio] },
    { chunks: [responseAudio, staleAudio], gate: delayedAudio },
  );
  harness.engine.plans.push({
    outcome: harness.outcome(
      'The balance is overdue. Payment is needed today. Can you make it today? Please confirm.',
    ),
  });
  harness.callbacks!.onTranscript('I have not paid.');
  await waitFor(() => harness.marks().length === 2);
  await delay(20);
  assert.equal(harness.speech.calls.length, 2);
  const oldMarks = harness.marks();
  harness.acknowledge(oldMarks[0]!);
  await waitFor(() => harness.speech.calls.length === 3);
  await waitFor(() => harness.audio().length === 3);
  const interruptedIndex =
    harness.store.get(harness.runId)!.transcript.length - 1;
  assert.equal(
    harness.store.get(harness.runId)!.transcript[interruptedIndex]!
      .deliveredText,
    'The balance is overdue.',
  );
  harness.callbacks!.onSpeechStarted();
  assert.equal(harness.speech.calls[2]!.signal.aborted, true);
  const interrupted = harness.store.get(harness.runId)!.transcript[
    interruptedIndex
  ]!;
  assert.equal(interrupted.delivery, 'interrupted');
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.deliveredText, 'The balance is overdue.');
  harness.engine.plans.push({
    outcome: harness.outcome('What time should I call back?'),
  });
  harness.callbacks!.onTranscript('Wait, I am busy right now.');
  await waitFor(() => harness.marks().length === 3);
  for (const name of oldMarks) harness.acknowledge(name);
  delayedAudio.release();
  await waitFor(() => harness.speech.calls[2]!.completed);
  await harness.flush();
  assert.equal(harness.audio().length, 4);
  assert.ok(!harness.audio().some((audio) => audio.equals(staleAudio)));
  assert.equal(harness.speech.calls.length, 4);
  assert.equal(
    harness.engine.calls[1]!.transcript[interruptedIndex]!.deliveredText,
    'The balance is overdue.',
  );
  assert.equal(harness.finishes.length, 0);
});

test('finished synthesis remains unconfirmed playback until the carrier acknowledges it', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  harness.engine.plans.push({
    outcome: harness.outcome('Can you pay today?'),
  });
  harness.callbacks!.onTranscript('I have not paid.');
  await waitFor(() => harness.marks().length === 1);
  assert.equal(harness.speech.calls[0]!.completed, true);
  let entry = harness.store.get(harness.runId)!.transcript.at(-1)!;
  assert.equal(entry.delivery, 'playing');
  assert.equal(entry.deliveredText, '');
  const staleMark = harness.marks()[0]!;
  harness.callbacks!.onSpeechStarted();
  harness.acknowledge(staleMark);
  await harness.flush();
  entry = harness.store.get(harness.runId)!.transcript.at(-1)!;
  assert.equal(entry.delivery, 'interrupted');
  assert.equal(entry.deliveredText, '');
});

test('interrupting a callback goodbye permits a new callback time and ignores its old marks', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  const first = harness.outcome(
    'I will call at ten. Goodbye.',
    'callback_requested',
  );
  first.state.pendingCallback = {
    at: '2026-10-07T17:00:00.000Z',
    evidence: { text: 'Call at ten tomorrow.', at: '2026-10-06T18:00:00.000Z' },
  };
  harness.engine.plans.push({ outcome: first });
  harness.callbacks!.onTranscript('Call at ten tomorrow.');
  await waitFor(() => harness.marks().length === 2);
  const oldMarks = harness.marks();
  harness.acknowledge(oldMarks[0]!);
  await harness.flush();
  harness.callbacks!.onSpeechStarted();
  assert.equal(harness.finishes.length, 0);
  const revised = harness.outcome(
    'I will call at eleven. Goodbye.',
    'callback_requested',
  );
  revised.state.pendingCallback = {
    at: '2026-10-07T18:00:00.000Z',
    evidence: {
      text: 'Make that eleven tomorrow.',
      at: '2026-10-06T18:01:00.000Z',
    },
  };
  harness.engine.plans.push({ outcome: revised });
  harness.callbacks!.onTranscript('Make that eleven tomorrow.');
  await waitFor(() => harness.marks().length === 4);
  for (const name of oldMarks) harness.acknowledge(name);
  harness.acknowledge(harness.marks()[2]!);
  await harness.flush();
  assert.equal(harness.finishes.length, 0);
  assert.equal(
    harness.store.get(harness.runId)!.state.pendingCallback!.at,
    revised.state.pendingCallback.at,
  );
  harness.acknowledge(harness.marks()[3]!);
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'callback_requested');
  assert.equal(
    harness.store.get(harness.runId)!.state.pendingCallback!.at,
    revised.state.pendingCallback.at,
  );
});

test('a caller can withdraw a callback before goodbye finishes and continue the payment conversation', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  const callback = harness.outcome(
    'I will call at ten. Goodbye.',
    'callback_requested',
  );
  callback.state.pendingCallback = {
    at: '2026-10-07T17:00:00.000Z',
    evidence: { text: 'Call at ten tomorrow.', at: '2026-10-06T18:00:00.000Z' },
  };
  harness.engine.plans.push({ outcome: callback });
  harness.callbacks!.onTranscript('Call at ten tomorrow.');
  await waitFor(() => harness.marks().length === 2);
  const oldMarks = harness.marks();
  const continuing = harness.outcome('Has the payment already been made?');
  continuing.state.pendingCallback = null;
  harness.engine.plans.push({ outcome: continuing });
  harness.callbacks!.onSpeechStarted();
  harness.callbacks!.onTranscript('Actually, I can talk now.');
  await waitFor(() => harness.marks().length === 3);
  for (const name of oldMarks) harness.acknowledge(name);
  await harness.flush();
  assert.equal(harness.session!.stopReason, null);
  assert.equal(harness.finishes.length, 0);
  assert.equal(harness.store.get(harness.runId)!.state.pendingCallback, null);
});

test('a callback request survives a peer disconnect or carrier stop while the goodbye is playing', async (t) => {
  for (const event of ['disconnect', 'stop']) {
    const harness = new SessionHarness();
    t.after(harness.dispose.bind(harness));
    await harness.start();
    await harness.playOpening();
    const callback = harness.outcome(
      'I will call at ten. Goodbye.',
      'callback_requested',
    );
    callback.state.pendingCallback = {
      at: '2026-10-07T17:00:00.000Z',
      evidence: {
        text: 'Call at ten tomorrow.',
        at: '2026-10-06T18:00:00.000Z',
      },
    };
    harness.engine.plans.push({ outcome: callback });
    harness.callbacks!.onTranscript('Call at ten tomorrow.');
    await waitFor(() => harness.marks().length === 2);
    harness.callbacks!.onSpeechStarted();
    assert.equal(harness.session!.stopReason, 'callback_requested');
    if (event === 'disconnect') harness.client!.close();
    else harness.client!.send(JSON.stringify({ event: 'stop', streamSid }));
    await waitFor(() => harness.finishes.length === 1);
    assert.equal(harness.finishes[0]!.reason, 'callback_requested');
    assert.equal(
      harness.store.get(harness.runId)!.state.pendingCallback!.at,
      callback.state.pendingCallback.at,
    );
  }
});

test('a disconnect while a callback correction is being decided cannot hand off the stale time', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  const delayedDecision = new Gate();
  t.after(delayedDecision.release);
  await harness.start();
  await harness.playOpening();
  const callback = harness.outcome(
    'I will call at ten. Goodbye.',
    'callback_requested',
  );
  callback.state.pendingCallback = {
    at: '2026-10-07T17:00:00.000Z',
    evidence: { text: 'Call at ten tomorrow.', at: '2026-10-06T18:00:00.000Z' },
  };
  harness.engine.plans.push({ outcome: callback });
  harness.callbacks!.onTranscript('Call at ten tomorrow.');
  await waitFor(() => harness.marks().length === 2);
  const revised = harness.outcome('What time would work?');
  revised.state.pendingCallback = null;
  harness.engine.plans.push({ outcome: revised, gate: delayedDecision });
  harness.callbacks!.onTranscript('Actually, ten will not work.');
  await waitFor(() => harness.engine.calls.length === 2);
  assert.equal(harness.store.get(harness.runId)!.state.pendingCallback, null);
  assert.equal(
    harness.store.get(harness.runId)!.state.awaitingCallbackTime,
    true,
  );
  assert.equal(
    harness.engine.calls[1]!.state.pendingCallback!.at,
    callback.state.pendingCallback.at,
  );
  harness.client!.close();
  await waitFor(() => harness.finishes.length === 1);
  assert.equal(harness.finishes[0]!.reason, 'call_ended');
  assert.equal(harness.store.get(harness.runId)!.result!.callback, null);
  delayedDecision.release();
  await waitFor(() => harness.engine.calls[1]!.completed);
  assert.equal(harness.store.get(harness.runId)!.state.pendingCallback, null);
});

test('silent pause outcomes keep listening without synthesizing or storing empty agent speech', async (t) => {
  const harness = new SessionHarness();
  t.after(harness.dispose.bind(harness));
  await harness.start();
  await harness.playOpening();
  const paused = harness.outcome('');
  paused.state.paused = true;
  harness.engine.plans.push({ outcome: paused });
  await harness.session!.respond('One moment.');
  assert.equal(harness.speech.calls.length, 0);
  assert.equal(harness.store.get(harness.runId)!.state.paused, true);
  assert.equal(
    harness.store.get(harness.runId)!.transcript.at(-1)!.role,
    'recipient',
  );
  assert.equal(harness.finishes.length, 0);
  harness.engine.plans.push({ outcome: harness.outcome('', 'needs_human') });
  await harness.session!.respond('Please have someone else help.');
  assert.equal(harness.speech.calls.length, 0);
  assert.equal(harness.finishes[0]!.reason, 'needs_human');
});
