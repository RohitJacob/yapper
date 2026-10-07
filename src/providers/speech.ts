import { z } from 'zod';
import type { SpeechProvider } from '../contracts.js';

export interface SpeechOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
}

const miniMaxFrameSchema = z.object({
  data: z
    .object({ audio: z.string().optional(), status: z.number().optional() })
    .nullable()
    .optional(),
  base_resp: z
    .object({ status_code: z.number(), status_msg: z.string().optional() })
    .optional(),
});

interface SpeechResponse {
  response: Response;
  signal: AbortSignal;
  dispose(): void;
}

export class ElevenLabsSpeechProvider implements SpeechProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: SpeechOptions = {},
  ) {}

  async *synthesize(
    text: string,
    voiceId: string,
    signal: AbortSignal,
  ): AsyncIterable<Buffer> {
    const url = new URL(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
      this.options.baseUrl ?? 'https://api.elevenlabs.io',
    );
    url.searchParams.set('output_format', 'ulaw_8000');
    const stream = await openSpeechResponse(
      url,
      { text, model_id: 'eleven_v3' },
      { 'xi-api-key': this.apiKey },
      signal,
      this.options.timeoutMs ?? 30_000,
    );
    try {
      yield* readBytes(
        stream.response,
        stream.signal,
        this.options.maxAudioBytes ?? 1_000_000,
      );
    } finally {
      stream.dispose();
    }
  }
}

export class MiniMaxSpeechProvider implements SpeechProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: SpeechOptions = {},
  ) {}

  async *synthesize(
    text: string,
    voiceId: string,
    signal: AbortSignal,
  ): AsyncIterable<Buffer> {
    const url = new URL(
      '/v1/t2a_v2',
      this.options.baseUrl ?? 'https://api.minimax.io',
    );
    const body = {
      model: 'speech-02-hd',
      text,
      stream: true,
      stream_options: { exclude_aggregated_audio: true },
      voice_setting: { voice_id: voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { format: 'pcmu_raw', sample_rate: 8000, channel: 1 },
    };
    const stream = await openSpeechResponse(
      url,
      body,
      { Authorization: `Bearer ${this.apiKey}` },
      signal,
      this.options.timeoutMs ?? 30_000,
    );
    try {
      yield* decodeMiniMax(
        stream.response,
        stream.signal,
        this.options.maxAudioBytes ?? 1_000_000,
      );
    } finally {
      stream.dispose();
    }
  }
}

export function createSpeechProvider(
  provider: 'elevenlabs' | 'minimax',
  apiKey: string,
): SpeechProvider {
  return provider === 'elevenlabs'
    ? new ElevenLabsSpeechProvider(apiKey)
    : new MiniMaxSpeechProvider(apiKey);
}

async function openSpeechResponse(
  url: URL,
  body: object,
  headers: Record<string, string>,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<SpeechResponse> {
  const controller = new AbortController();
  const timer = setTimeout(abortTimedOutSpeech, timeoutMs, controller);
  timer.unref();
  const signal = AbortSignal.any([callerSignal, controller.signal]);
  try {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Speech provider returned HTTP ${response.status}`);
    }
    return { response, signal, dispose: clearTimeout.bind(null, timer) };
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function abortTimedOutSpeech(controller: AbortController): void {
  controller.abort(new Error('Speech synthesis timed out'));
}

async function* readBytes(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): AsyncIterable<Buffer> {
  if (!response.body)
    throw new Error('Speech provider returned no audio stream');
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes)
        throw new Error('Speech response exceeded its byte limit');
      if (chunk.value.byteLength > 0) yield Buffer.from(chunk.value);
    }
    if (total === 0)
      throw new Error('Speech provider returned an empty stream');
  } finally {
    await reader.cancel().catch(ignoreCancellationError);
    reader.releaseLock();
  }
}

function ignoreCancellationError(): void {}

class EventStreamDecoder {
  private pending = '';
  private readonly decoder = new TextDecoder();

  push(chunk: Buffer): string[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string[] {
    this.pending += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const messages: string[] = [];
    let boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.pending);
    while (boundary) {
      const frame = this.pending.slice(0, boundary.index);
      if (frame.length > 512_000)
        throw new Error('Speech event exceeded its byte limit');
      messages.push(eventData(frame));
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.pending);
    }
    if (this.pending.length > 512_000)
      throw new Error('Speech event exceeded its byte limit');
    if (final && this.pending.trim()) {
      messages.push(eventData(this.pending));
      this.pending = '';
    }
    return messages;
  }
}

function eventData(frame: string): string {
  return frame
    .split(/\r\n|\n|\r/)
    .filter(isDataLine)
    .map(removeDataPrefix)
    .join('\n');
}

function isDataLine(line: string): boolean {
  return line === 'data' || line.startsWith('data:');
}

function removeDataPrefix(line: string): string {
  return line.slice(5).replace(/^ /, '');
}

async function* decodeMiniMax(
  response: Response,
  signal: AbortSignal,
  maxAudioBytes: number,
): AsyncIterable<Buffer> {
  const decoder = new EventStreamDecoder();
  let audioBytes = 0;
  let completed = false;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('MiniMax did not return a text/event-stream response');
  }
  for await (const chunk of readBytes(
    response,
    signal,
    maxAudioBytes * 2 + 256_000,
  )) {
    for (const message of decoder.push(chunk)) {
      if (!message || message === '[DONE]') continue;
      const frame = parseMiniMaxFrame(message);
      if (frame.audio) {
        audioBytes += frame.audio.length;
        if (audioBytes > maxAudioBytes)
          throw new Error('Speech response exceeded its byte limit');
        yield frame.audio;
      }
      if (frame.completed) completed = true;
    }
    if (completed) break;
  }
  if (!completed) {
    for (const message of decoder.finish()) {
      if (!message || message === '[DONE]') continue;
      const frame = parseMiniMaxFrame(message);
      if (frame.audio) {
        audioBytes += frame.audio.length;
        if (audioBytes > maxAudioBytes)
          throw new Error('Speech response exceeded its byte limit');
        yield frame.audio;
      }
      if (frame.completed) completed = true;
    }
  }
  if (!completed)
    throw new Error('MiniMax audio stream ended before synthesis completed');
  if (audioBytes === 0) throw new Error('MiniMax returned no audio');
}

function parseMiniMaxFrame(message: string): {
  audio: Buffer | null;
  completed: boolean;
} {
  const frame = miniMaxFrameSchema.parse(JSON.parse(message) as unknown);
  if (frame.base_resp && frame.base_resp.status_code !== 0) {
    throw new Error(
      `MiniMax synthesis failed with code ${frame.base_resp.status_code}`,
    );
  }
  const hex = frame.data?.audio;
  if (hex && (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0)) {
    throw new Error('MiniMax returned invalid hexadecimal audio');
  }
  return {
    audio: hex ? Buffer.from(hex, 'hex') : null,
    completed: frame.data?.status === 2,
  };
}
