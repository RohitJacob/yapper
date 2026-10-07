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

export class CallSession {
  private streamSid: string | null = null;
  private transcriber: Transcriber | null = null;
  private generation = 0;
  private controller: AbortController | null = null;
  private closed = false;
  private stoppingReason: FinishReason | null = null;
  private committedRecipientIndex = -1;
  private speakingIndex: number | null = null;
  private pendingMark: {
    name: string;
    generation: number;
    reason?: FinishReason;
  } | null = null;
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
    return this.stoppingReason;
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
      const mark = this.pendingMark;
      if (mark && name === mark.name && mark.generation === this.generation) {
        this.pendingMark = null;
        this.speakingIndex = null;
        if (this.playbackTimer) clearTimeout(this.playbackTimer);
        if (mark.reason) void this.finish(mark.reason);
      }
    } else if (message.event === 'stop') {
      void this.finish(this.stoppingReason ?? 'call_ended');
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
    void this.speak(opening(run.request.task), this.generation).catch(() => {
      void this.fail('Speech provider failed');
    });
  }

  interrupt(): void {
    if (this.closed) return;
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.pendingMark = null;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    if (this.speakingIndex !== null) {
      const run = this.options.store.get(this.options.id);
      const entry = run?.transcript[this.speakingIndex];
      if (run && entry && !terminalStatuses.has(run.status)) {
        entry.interrupted = true;
        this.options.store.save(run);
      }
      this.speakingIndex = null;
    }
    if (this.streamSid)
      this.send({ event: 'clear', streamSid: this.streamSid });
    if (this.stoppingReason) void this.finish(this.stoppingReason);
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
        run.state,
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
        outcome.finishReason !== 'information_complete'
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
    const run = this.options.store.get(this.options.id);
    if (!run || terminalStatuses.has(run.status)) return;
    const controller = new AbortController();
    this.controller = controller;
    this.speakingIndex = run.transcript.length;
    run.transcript.push({ role: 'agent', text, at: new Date().toISOString() });
    this.options.store.save(run);
    let bytes = 0;
    try {
      for await (const chunk of this.options.speech.synthesize(
        text,
        run.request.voice.voiceId,
        controller.signal,
      )) {
        if (
          this.closed ||
          controller.signal.aborted ||
          generation !== this.generation
        )
          return;
        bytes += chunk.length;
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
    } catch (error) {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        this.closed
      )
        return;
      throw error;
    }
    if (
      this.closed ||
      generation !== this.generation ||
      controller.signal.aborted
    )
      return;
    if (!bytes) throw new Error('Speech provider returned no audio');
    const name = `turn-${generation}-${run.transcript.length}`;
    this.pendingMark = { name, generation, reason };
    this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
    this.playbackTimer = setTimeout(
      () => {
        void this.fail('Playback acknowledgment timed out');
      },
      Math.ceil(bytes / 8) + 15_000,
    );
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
    this.close();
    void this.options.onFinish(
      this.options.id,
      this.stoppingReason ?? 'call_ended',
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.controller?.abort();
    clearTimeout(this.startTimer);
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.transcriber?.close();
    if (this.options.socket.readyState === 1) this.options.socket.close(1000);
    this.options.onClosed(this.options.id);
  }
}
