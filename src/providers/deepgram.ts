import WebSocket, { type RawData } from 'ws';
import { z } from 'zod';
import type { Transcriber, TranscriptionCallbacks } from '../contracts.js';

export interface DeepgramOptions {
  endpoint?: string;
  connectTimeoutMs?: number;
  maxBufferedAudioBytes?: number;
  keepAliveIntervalMs?: number;
}

const messageSchema = z.object({
  type: z.string(),
  is_final: z.boolean().optional(),
  speech_final: z.boolean().optional(),
  start: z.number().optional(),
  duration: z.number().optional(),
  last_word_end: z.number().optional(),
  channel: z
    .union([
      z.array(z.number()),
      z.object({
        alternatives: z.array(z.object({ transcript: z.string().max(12_000) })),
      }),
    ])
    .optional(),
});

export class DeepgramTranscriber implements Transcriber {
  private readonly socket: WebSocket;
  private readonly maxBufferedAudioBytes: number;
  private readonly keepAliveIntervalMs: number;
  private keepAlive: NodeJS.Timeout | null = null;
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private closed = false;
  private speaking = false;
  private segments: string[] = [];
  private transcriptCharacters = 0;
  private lastFinalEnd = -1;
  private lastFlushedEnd = -1;
  private readonly seenSegments = new Set<string>();

  constructor(
    apiKey: string,
    private readonly callbacks: TranscriptionCallbacks,
    options: DeepgramOptions = {},
  ) {
    this.maxBufferedAudioBytes = options.maxBufferedAudioBytes ?? 80_000;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs ?? 4_000;
    const url = new URL(options.endpoint ?? 'wss://api.deepgram.com/v1/listen');
    url.searchParams.set('model', 'nova-3');
    url.searchParams.set('encoding', 'mulaw');
    url.searchParams.set('sample_rate', '8000');
    url.searchParams.set('channels', '1');
    url.searchParams.set('language', 'en-US');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('vad_events', 'true');
    url.searchParams.set('endpointing', '350');
    url.searchParams.set('utterance_end_ms', '1000');
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('smart_format', 'true');
    this.socket = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
      handshakeTimeout: options.connectTimeoutMs ?? 10_000,
      maxPayload: 128_000,
    });
    this.socket.on('open', this.handleOpen.bind(this));
    this.socket.on('message', this.handleMessage.bind(this));
    this.socket.on('error', this.fail.bind(this));
    this.socket.on('close', this.handleClose.bind(this));
  }

  send(audio: Buffer): void {
    if (this.closed || audio.length === 0) return;
    if (
      this.queuedBytes + this.socket.bufferedAmount + audio.length >
      this.maxBufferedAudioBytes
    ) {
      this.fail(new Error('Transcription audio buffer exceeded its limit'));
      return;
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(audio, { binary: true }, this.handleSend.bind(this));
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.queued.push(Buffer.from(audio));
      this.queuedBytes += audio.length;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket.close(1000);
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
    }
  }

  private handleOpen(): void {
    if (this.closed) return;
    const queued = this.queued;
    this.queued = [];
    this.queuedBytes = 0;
    for (const audio of queued) this.send(audio);
    if (this.closed) return;
    this.keepAlive = setInterval(
      this.sendKeepAlive.bind(this),
      this.keepAliveIntervalMs,
    );
    this.keepAlive.unref();
  }

  private sendKeepAlive(): void {
    if (!this.closed && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({ type: 'KeepAlive' }),
        this.handleSend.bind(this),
      );
    }
  }

  private handleSend(error?: Error): void {
    if (error) this.fail(error);
  }

  private handleMessage(raw: RawData): void {
    if (this.closed) return;
    try {
      const message = messageSchema.parse(
        JSON.parse(raw.toString()) as unknown,
      );
      if (message.type === 'Error') {
        this.fail(new Error('Deepgram returned a transcription error'));
      } else if (message.type === 'SpeechStarted') {
        this.speechStarted();
      } else if (message.type === 'UtteranceEnd') {
        if (
          message.last_word_end === undefined ||
          message.last_word_end > this.lastFlushedEnd
        )
          this.flush();
      } else if (message.type === 'Results') {
        const channel = message.channel;
        const text =
          channel && !Array.isArray(channel)
            ? (channel.alternatives[0]?.transcript.trim() ?? '')
            : '';
        if (
          message.is_final &&
          message.start !== undefined &&
          message.duration !== undefined &&
          this.seenSegments.has(`${message.start}:${message.duration}:${text}`)
        )
          return;
        if (text) this.speechStarted();
        if (message.is_final && text)
          this.appendSegment(text, message.start, message.duration);
        if (message.speech_final) this.flush();
      }
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new Error('Invalid transcription message'),
      );
    }
  }

  private speechStarted(): void {
    if (this.speaking) return;
    this.speaking = true;
    this.callbacks.onSpeechStarted();
  }

  private appendSegment(text: string, start?: number, duration?: number): void {
    if (start !== undefined && duration !== undefined) {
      const key = `${start}:${duration}:${text}`;
      if (this.seenSegments.has(key)) return;
      this.seenSegments.add(key);
      if (this.seenSegments.size > 256) {
        const oldest = this.seenSegments.values().next().value;
        if (oldest !== undefined) this.seenSegments.delete(oldest);
      }
      this.lastFinalEnd = Math.max(this.lastFinalEnd, start + duration);
    }
    this.transcriptCharacters += text.length;
    if (this.transcriptCharacters > 12_000)
      throw new Error('Transcription utterance exceeded its character limit');
    this.segments.push(text);
  }

  private flush(): void {
    const text = this.segments.join(' ').trim();
    this.segments = [];
    this.transcriptCharacters = 0;
    this.speaking = false;
    this.lastFlushedEnd = this.lastFinalEnd;
    if (text) this.callbacks.onTranscript(text);
  }

  private handleClose(code: number): void {
    if (!this.closed)
      this.fail(
        new Error(`Transcription connection closed unexpectedly (${code})`),
      );
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanup();
    this.socket.terminate();
    this.callbacks.onError(error);
  }

  private cleanup(): void {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.queued = [];
    this.queuedBytes = 0;
    this.segments = [];
    this.seenSegments.clear();
  }
}

export function createTranscriber(
  apiKey: string,
  callbacks: TranscriptionCallbacks,
): Transcriber {
  return new DeepgramTranscriber(apiKey, callbacks);
}
