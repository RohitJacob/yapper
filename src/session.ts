import { EventEmitter, once } from 'node:events';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { opening } from './collection.js';
import { terminalStatuses, type RunStore } from './store.js';
import type {
  DecisionEngine,
  FinishReason,
  SpeechProvider,
  Transcriber,
  TranscriptionCallbacks,
} from './contracts.js';

const StartSchema = z.object({
  event: z.literal('start'),
  start: z.object({
    streamSid: z.string().regex(/^MZ[a-f0-9]{32}$/i),
    callSid: z.string(),
    accountSid: z.string(),
    mediaFormat: z.object({
      encoding: z.literal('audio/x-mulaw'),
      sampleRate: z.literal(8000),
      channels: z.literal(1),
    }),
  }),
});
const MediaSchema = z.object({
  event: z.literal('media'),
  streamSid: z.string(),
  media: z.object({
    payload: z
      .string()
      .max(100_000)
      .regex(/^[a-zA-Z0-9+/]*={0,2}$/),
  }),
});

export interface SessionOptions {
  id: string;
  socket: WebSocket;
  store: RunStore;
  engine: DecisionEngine;
  speech: SpeechProvider;
  accountSid: string;
  transcriberFactory: (callbacks: TranscriptionCallbacks) => Transcriber;
  onFinish: (id: string, reason: FinishReason, error?: string) => Promise<void>;
  onClosed: (id: string) => void;
}

interface PlaybackMark {
  name: string;
  generation: number;
  deliveredText: string;
  bytes: number;
  final: boolean;
  expiresAt: number;
  reason?: FinishReason;
}

export class CallSession {
  private streamSid: string | null = null;
  private transcriber: Transcriber | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private closed = false;
  private stoppingReason: FinishReason | null = null;
  private committedRecipientIndex = -1;
  private speakingIndex: number | null = null;
  private readonly playbackEvents = new EventEmitter();
  private readonly pendingMarks: PlaybackMark[] = [];
  private queuedAudioBytes = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private durationTimer: NodeJS.Timeout | null = null;
  private readonly startTimer: NodeJS.Timeout;

  constructor(private readonly options: SessionOptions) {
    this.startTimer = setTimeout(() => {
      void this.fail('Media stream did not start');
    }, 10_000);
    options.socket.on('message', (data) => {
      this.receive(String(data));
    });
    options.socket.on('close', () => {
      this.closedByPeer();
    });
    options.socket.on('error', () => {
      void this.fail('Media connection failed');
    });
  }

  get stopReason(): FinishReason | null {
    if (this.stoppingReason) return this.stoppingReason;
    return this.options.store.get(this.options.id)?.state.pendingCallback
      ? 'callback_requested'
      : null;
  }

  receive(raw: string): void {
    if (this.closed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      void this.fail('Invalid media message');
      return;
    }
    if (!message || typeof message !== 'object') {
      void this.fail('Invalid media message');
      return;
    }
    if (message.event === 'connected') return;
    if (message.event === 'start') {
      this.start(message);
      return;
    }
    if (!this.streamSid || message.streamSid !== this.streamSid) {
      void this.fail('Invalid media stream identity');
      return;
    }
    if (message.event === 'media') {
      const parsed = MediaSchema.safeParse(message);
      if (!parsed.success) {
        void this.fail('Invalid audio frame');
        return;
      }
      this.transcriber?.send(Buffer.from(parsed.data.media.payload, 'base64'));
    } else if (message.event === 'mark') {
      const name = (message.mark as { name?: unknown } | undefined)?.name;
      this.acknowledgePlayback(name);
    } else if (message.event === 'stop') {
      void this.finish(this.stopReason ?? 'call_ended');
    }
  }

  private start(message: Record<string, unknown>): void {
    const parsed = StartSchema.safeParse(message);
    const run = this.options.store.get(this.options.id);
    if (
      this.streamSid ||
      !parsed.success ||
      !run ||
      terminalStatuses.has(run.status) ||
      parsed.data.start.callSid !== run.callSid ||
      parsed.data.start.accountSid !== this.options.accountSid
    ) {
      void this.fail('Media start does not match the authorized call');
      return;
    }
    clearTimeout(this.startTimer);
    this.streamSid = parsed.data.start.streamSid;
    run.status = 'in_progress';
    this.options.store.save(run);
    this.transcriber = this.options.transcriberFactory({
      onSpeechStarted: () => {
        this.interrupt();
      },
      onTranscript: (text) => {
        void this.respond(text);
      },
      onError: () => {
        void this.fail('Transcription provider failed');
      },
    });
    this.durationTimer = setTimeout(() => {
      void this.finish('max_duration');
    }, run.request.maxDurationSeconds * 1000);
    void this.speak(
      opening(run.request.task, Boolean(run.parentRunId)),
      this.generation,
    ).catch(() => {
      void this.fail('Speech provider failed');
    });
  }

  interrupt(): void {
    if (this.closed) return;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.pendingMarks.length = 0;
    this.queuedAudioBytes = 0;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.markInterrupted();
    if (this.streamSid)
      this.send({ event: 'clear', streamSid: this.streamSid });
    if (this.stoppingReason) void this.finish(this.stoppingReason);
  }

  private markInterrupted(): void {
    if (this.speakingIndex !== null) {
      const run = this.options.store.get(this.options.id);
      const entry = run?.transcript[this.speakingIndex];
      if (run && entry && !terminalStatuses.has(run.status)) {
        entry.interrupted = true;
        entry.delivery = 'interrupted';
        this.options.store.save(run);
      }
      this.speakingIndex = null;
    }
  }

  async respond(text: string): Promise<void> {
    if (this.closed || !text.trim()) return;
    this.interrupt();
    if (this.closed) return;
    const generation = this.generation;
    const run = this.options.store.get(this.options.id);
    if (!run || terminalStatuses.has(run.status)) return;
    if (text.length > 8_000 || run.transcript.length >= 100) {
      await this.finish('needs_human');
      return;
    }
    run.transcript.push({
      role: 'recipient',
      text,
      at: new Date().toISOString(),
    });
    const decisionState = run.state;
    if (decisionState.pendingCallback) {
      run.state = {
        ...decisionState,
        pendingCallback: null,
        awaitingCallbackTime: true,
      };
    }
    this.options.store.save(run);
    const recipientIndex = run.transcript.length - 1;
    const pendingRecipients = run.transcript.filter(
      (entry, index) =>
        entry.role === 'recipient' && index > this.committedRecipientIndex,
    );
    const decisionTranscript = run.transcript.filter(
      (entry, index) =>
        entry.role !== 'recipient' || index <= this.committedRecipientIndex,
    );
    decisionTranscript.push({
      role: 'recipient',
      text: pendingRecipients.map((entry) => entry.text).join('\n'),
      at: run.transcript[recipientIndex]!.at,
    });
    const controller = new AbortController();
    this.controller = controller;
    try {
      const outcome = await this.options.engine.respond(
        run.request.task,
        decisionState,
        decisionTranscript,
        new Date(),
        controller.signal,
      );
      if (
        this.closed ||
        generation !== this.generation ||
        controller.signal.aborted
      )
        return;
      const current = this.options.store.get(run.id);
      if (!current || terminalStatuses.has(current.status)) return;
      current.state = outcome.state;
      this.committedRecipientIndex = recipientIndex;
      this.options.store.save(current);
      if (outcome.finishReason === 'opt_out')
        this.options.store.suppress(run.request.to);
      if (
        outcome.finishReason &&
        outcome.finishReason !== 'information_complete' &&
        outcome.finishReason !== 'callback_requested'
      )
        this.stoppingReason = outcome.finishReason;
      await this.speak(outcome.text, generation, outcome.finishReason);
    } catch {
      if (
        !this.closed &&
        generation === this.generation &&
        !controller.signal.aborted
      )
        await this.fail('Decision or speech provider failed');
    }
  }

  private async speak(
    text: string,
    generation: number,
    reason?: FinishReason,
  ): Promise<void> {
    if (this.closed || generation !== this.generation) return;
    if (!text.trim()) {
      if (reason) await this.finish(reason);
      return;
    }
    const run = this.options.store.get(this.options.id);
    if (!run || terminalStatuses.has(run.status)) return;
    const controller = new AbortController();
    this.controller = controller;
    this.speakingIndex = run.transcript.length;
    run.transcript.push({
      role: 'agent',
      text,
      at: new Date().toISOString(),
      deliveredText: '',
      delivery: 'pending',
    });
    this.options.store.save(run);
    const sentences = Array.from(
      new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text),
    );
    if (!sentences.length || sentences.length > 32 || text.length > 8000)
      throw new Error('Speech response exceeded text limit');
    let bytes = 0;
    try {
      for (const [index, sentence] of sentences.entries()) {
        while (this.pendingMarks.length >= 2)
          await once(this.playbackEvents, 'acknowledged', {
            signal: controller.signal,
          });
        if (!this.isCurrent(generation, controller)) return;
        let sentenceBytes = 0;
        for await (const chunk of this.options.speech.synthesize(
          sentence.segment.trim(),
          run.request.voice.voiceId,
          controller.signal,
        )) {
          if (!this.isCurrent(generation, controller)) return;
          if (!chunk.length) continue;
          if (!bytes) this.markPlaying();
          bytes += chunk.length;
          sentenceBytes += chunk.length;
          this.queuedAudioBytes += chunk.length;
          if (
            bytes > 8000 * 120 ||
            this.options.socket.bufferedAmount > 1_000_000
          )
            throw new Error('Audio exceeded buffer limit');
          this.send({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: chunk.toString('base64') },
          });
        }
        if (!this.isCurrent(generation, controller)) return;
        if (!sentenceBytes)
          throw new Error('Speech provider returned no audio');
        const name = `turn-${generation}-${run.transcript.length}-${index}`;
        this.pendingMarks.push({
          name,
          generation,
          deliveredText: text
            .slice(0, sentence.index + sentence.segment.length)
            .trimEnd(),
          bytes: sentenceBytes,
          final: index === sentences.length - 1,
          expiresAt: Date.now() + Math.ceil(this.queuedAudioBytes / 8) + 15_000,
          reason,
        });
        this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
        this.watchPlayback();
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        this.closed
      )
        return;
      throw error;
    }
  }

  private isCurrent(generation: number, controller: AbortController): boolean {
    return (
      !this.closed &&
      generation === this.generation &&
      !controller.signal.aborted
    );
  }

  private markPlaying(): void {
    const run = this.options.store.get(this.options.id);
    const entry =
      this.speakingIndex === null ? null : run?.transcript[this.speakingIndex];
    if (!run || !entry || terminalStatuses.has(run.status)) return;
    entry.delivery = 'playing';
    this.options.store.save(run);
  }

  private acknowledgePlayback(name: unknown): void {
    const mark = this.pendingMarks[0];
    if (!mark || name !== mark.name || mark.generation !== this.generation)
      return;
    this.pendingMarks.shift();
    this.queuedAudioBytes -= mark.bytes;
    const run = this.options.store.get(this.options.id);
    const entry =
      this.speakingIndex === null ? null : run?.transcript[this.speakingIndex];
    if (run && entry && !terminalStatuses.has(run.status)) {
      entry.deliveredText = mark.deliveredText;
      entry.delivery = mark.final ? 'played' : 'playing';
      this.options.store.save(run);
    }
    if (mark.final) this.speakingIndex = null;
    this.watchPlayback();
    this.playbackEvents.emit('acknowledged');
    if (mark.final && mark.reason) void this.finish(mark.reason);
  }

  private watchPlayback(): void {
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    const mark = this.pendingMarks[0];
    this.playbackTimer = mark
      ? setTimeout(
          this.playbackTimedOut.bind(this),
          Math.max(1, mark.expiresAt - Date.now()),
        )
      : null;
  }

  private playbackTimedOut(): void {
    void this.fail('Playback acknowledgment timed out');
  }

  private send(message: Record<string, unknown>): void {
    if (this.options.socket.readyState === 1)
      this.options.socket.send(JSON.stringify(message));
  }

  private async fail(message: string): Promise<void> {
    await this.finish('provider_error', message);
  }

  private async finish(reason: FinishReason, error?: string): Promise<void> {
    if (this.closed) return;
    this.close();
    await this.options.onFinish(
      this.options.id,
      this.stoppingReason ?? reason,
      error,
    );
  }

  private closedByPeer(): void {
    if (this.closed) return;
    const reason = this.stopReason ?? 'call_ended';
    this.close();
    void this.options.onFinish(this.options.id, reason);
  }

  close(): void {
    if (this.closed) return;
    this.markInterrupted();
    this.closed = true;
    this.generation += 1;
    this.controller?.abort();
    this.pendingMarks.length = 0;
    this.queuedAudioBytes = 0;
    clearTimeout(this.startTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.transcriber?.close();
    if (this.options.socket.readyState === 1) this.options.socket.close(1000);
    this.options.onClosed(this.options.id);
  }
}
