import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { setImmediate as nextTick } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TranscriptionCallbacks } from '../src/contracts.js';
import { DeepgramTranscriber } from '../src/providers/deepgram.js';
import {
  ElevenLabsSpeechProvider,
  MiniMaxSpeechProvider,
} from '../src/providers/speech.js';

const phoneAudio = Buffer.from([255, 127, 240, 112, 225, 97, 208, 80]);
type ServerMode =
  'binary' | 'sse' | 'error' | 'truncated' | 'invalid-hex' | 'slow' | 'timeout';

class SpeechServer {
  readonly server = createServer(this.handleRequest.bind(this));
  request: {
    url?: string;
    authorization?: string;
    elevenKey?: string;
    body: Record<string, unknown>;
  } | null = null;
  baseUrl = '';

  constructor(private readonly mode: ServerMode) {}

  async start(): Promise<void> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    this.request = {
      url: request.url,
      authorization: request.headers.authorization,
      elevenKey: request.headers['xi-api-key'] as string | undefined,
      body: JSON.parse(body) as Record<string, unknown>,
    };
    if (this.mode === 'timeout') return;
    if (this.mode === 'binary' || this.mode === 'slow') {
      response.writeHead(200, { 'Content-Type': 'audio/basic' });
      response.write(phoneAudio.subarray(0, 4));
      if (this.mode === 'slow') return;
      await nextTick();
      response.end(phoneAudio.subarray(4));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const payload = this.payload();
    for (let index = 0; index < payload.length; index += 3) {
      if (response.destroyed) break;
      response.write(payload.slice(index, index + 3));
      await nextTick();
    }
    response.end();
  }

  private payload(): string {
    if (this.mode === 'error')
      return 'data: {"data":null,"base_resp":{"status_code":1004,"status_msg":"auth failed"}}\n\n';
    if (this.mode === 'invalid-hex')
      return 'data: {"data":{"audio":"xyz","status":2},"base_resp":{"status_code":0}}\n\n';
    const prefix =
      ': keepalive\r\n\r\ndata: {"data":null,"base_resp":{"status_code":0}}\r\n\r\n';
    const first = `data: {"data":{"audio":"${phoneAudio.subarray(0, 4).toString('hex')}",\r\ndata: "status":1},"base_resp":{"status_code":0}}\r\n\r\n`;
    if (this.mode === 'truncated') return prefix + first;
    const final = `data: {"data":{"audio":"${phoneAudio.subarray(4).toString('hex')}","status":2},"base_resp":{"status_code":0}}\n\n`;
    return prefix + first + final;
  }
}

class TranscriptionRecorder implements TranscriptionCallbacks {
  speechStarts = 0;
  transcripts: string[] = [];
  errors: Error[] = [];
  onSpeechStarted(): void {
    this.speechStarts += 1;
  }
  onTranscript(text: string): void {
    this.transcripts.push(text);
  }
  onError(error: Error): void {
    this.errors.push(error);
  }
}

async function collectAudio(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const audio: Buffer[] = [];
  for await (const chunk of chunks) audio.push(chunk);
  return Buffer.concat(audio);
}

async function startWebSocketServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  return server;
}

function webSocketUrl(server: WebSocketServer): string {
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`;
}

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) socket.terminate();
  server.close();
  await once(server, 'close');
}

async function flushWebSocket(socket: WebSocket): Promise<void> {
  const pong = once(socket, 'pong', { signal: AbortSignal.timeout(3000) });
  socket.ping();
  await pong;
}

async function waitForControl(
  socket: WebSocket,
  controls: string[],
  expected: string,
): Promise<void> {
  const signal = AbortSignal.timeout(3000);
  while (!controls.includes(expected))
    await once(socket, 'message', { signal });
}

function sendResult(
  socket: WebSocket,
  text: string,
  start: number,
  duration: number,
  isFinal: boolean,
  speechFinal: boolean,
): void {
  socket.send(
    JSON.stringify({
      type: 'Results',
      start,
      duration,
      is_final: isFinal,
      speech_final: speechFinal,
      channel: { alternatives: [{ transcript: text }] },
    }),
  );
}

test('ElevenLabs sends exact v3 model and receives headerless telephone audio over HTTP', async (t) => {
  const server = new SpeechServer('binary');
  await server.start();
  t.after(server.close.bind(server));
  const provider = new ElevenLabsSpeechProvider('test-eleven-key', {
    baseUrl: server.baseUrl,
  });
  const audio = await collectAudio(
    provider.synthesize(
      'Has the invoice been paid?',
      'voice-123',
      new AbortController().signal,
    ),
  );
  assert.deepEqual(audio, phoneAudio);
  assert.equal(
    server.request?.url,
    '/v1/text-to-speech/voice-123/stream?output_format=ulaw_8000',
  );
  assert.equal(server.request?.elevenKey, 'test-eleven-key');
  assert.deepEqual(server.request?.body, {
    text: 'Has the invoice been paid?',
    model_id: 'eleven_v3',
  });
});

test('MiniMax decodes fragmented multiline SSE with null frames and the exact Speech 02 HD codec contract', async (t) => {
  const server = new SpeechServer('sse');
  await server.start();
  t.after(server.close.bind(server));
  const provider = new MiniMaxSpeechProvider('test-mini-key', {
    baseUrl: server.baseUrl,
  });
  const audio = await collectAudio(
    provider.synthesize(
      'When can you pay?',
      'English_Graceful_Lady',
      new AbortController().signal,
    ),
  );
  assert.deepEqual(audio, phoneAudio);
  assert.equal(server.request?.url, '/v1/t2a_v2');
  assert.equal(server.request?.authorization, 'Bearer test-mini-key');
  assert.equal(server.request?.body.model, 'speech-02-hd');
  assert.deepEqual(server.request?.body.audio_setting, {
    format: 'pcmu_raw',
    sample_rate: 8000,
    channel: 1,
  });
  assert.deepEqual(server.request?.body.stream_options, {
    exclude_aggregated_audio: true,
  });
});

test('speech streams enforce byte limits and reject malformed, failed, or truncated synthesis', async (t) => {
  for (const [mode, error] of [
    ['error', /code 1004/],
    ['invalid-hex', /invalid hexadecimal/],
    ['truncated', /before synthesis completed/],
  ] as const) {
    const server = new SpeechServer(mode);
    await server.start();
    t.after(server.close.bind(server));
    const provider = new MiniMaxSpeechProvider('key', {
      baseUrl: server.baseUrl,
    });
    await assert.rejects(
      collectAudio(
        provider.synthesize('Hello', 'voice', new AbortController().signal),
      ),
      error,
    );
  }
  const server = new SpeechServer('binary');
  await server.start();
  t.after(server.close.bind(server));
  const provider = new ElevenLabsSpeechProvider('key', {
    baseUrl: server.baseUrl,
    maxAudioBytes: 4,
  });
  await assert.rejects(
    collectAudio(
      provider.synthesize('Hello', 'voice', new AbortController().signal),
    ),
    /byte limit/,
  );
});

test('speech cancellation stops an active network stream and synthesis requests time out', async (t) => {
  const server = new SpeechServer('slow');
  await server.start();
  t.after(server.close.bind(server));
  const controller = new AbortController();
  const provider = new ElevenLabsSpeechProvider('key', {
    baseUrl: server.baseUrl,
  });
  const audio = provider.synthesize('Hello', 'voice', controller.signal);
  const stream = audio[Symbol.asyncIterator]();
  assert.deepEqual((await stream.next()).value, phoneAudio.subarray(0, 4));
  controller.abort();
  await assert.rejects(stream.next(), { name: 'AbortError' });

  const timeoutServer = new SpeechServer('timeout');
  await timeoutServer.start();
  t.after(timeoutServer.close.bind(timeoutServer));
  const timeoutProvider = new MiniMaxSpeechProvider('key', {
    baseUrl: timeoutServer.baseUrl,
    timeoutMs: 30,
  });
  await assert.rejects(
    collectAudio(
      timeoutProvider.synthesize(
        'Hello',
        'voice',
        new AbortController().signal,
      ),
    ),
    /timed out/,
  );
});

test('Deepgram sends buffered telephone audio and aggregates finals without duplicate utterances', async (t) => {
  const server = await startWebSocketServer();
  t.after(closeWebSocketServer.bind(null, server));
  const connected = once(server, 'connection');
  const recorder = new TranscriptionRecorder();
  const transcriber = new DeepgramTranscriber('deepgram-test-key', recorder, {
    endpoint: webSocketUrl(server),
    keepAliveIntervalMs: 20,
  });
  t.after(transcriber.close.bind(transcriber));
  transcriber.send(phoneAudio.subarray(0, 4));
  transcriber.send(phoneAudio.subarray(4));
  const [socket, request] = (await connected) as [WebSocket, IncomingMessage];
  const received: Buffer[] = [];
  const controls: string[] = [];
  socket.on('message', (data, binary) => {
    if (binary) received.push(Buffer.from(data as Buffer));
    else controls.push(String(data));
  });
  const url = new URL(request.url ?? '', 'http://localhost');
  assert.equal(request.headers.authorization, 'Token deepgram-test-key');
  for (const [key, value] of Object.entries({
    model: 'nova-3',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    vad_events: 'true',
    endpointing: '350',
    utterance_end_ms: '1000',
  })) {
    assert.equal(url.searchParams.get(key), value);
  }
  socket.send(JSON.stringify({ type: 'SpeechStarted', timestamp: 0 }));
  sendResult(socket, 'I paid', 0, 1, false, false);
  sendResult(socket, 'I paid', 0, 1, true, false);
  sendResult(socket, 'the invoice yesterday.', 1, 2, true, true);
  sendResult(socket, 'the invoice yesterday.', 1, 2, true, true);
  socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 2.8 }));
  await flushWebSocket(socket);
  await waitForControl(socket, controls, '{"type":"KeepAlive"}');
  assert.deepEqual(Buffer.concat(received), phoneAudio);
  assert.deepEqual(recorder.transcripts, ['I paid the invoice yesterday.']);
  assert.equal(recorder.speechStarts, 1);
  assert.equal(recorder.errors.length, 0);
  assert.ok(controls.includes('{"type":"KeepAlive"}'));

  socket.send(JSON.stringify({ type: 'SpeechStarted', timestamp: 4 }));
  sendResult(socket, 'The reference is ABC.', 4, 1, true, false);
  socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 4.9 }));
  socket.send(JSON.stringify({ type: 'UtteranceEnd', last_word_end: 4.9 }));
  await flushWebSocket(socket);
  assert.deepEqual(recorder.transcripts, [
    'I paid the invoice yesterday.',
    'The reference is ABC.',
  ]);
  assert.equal(recorder.speechStarts, 2);
  const disconnected = once(socket, 'close', {
    signal: AbortSignal.timeout(3000),
  });
  transcriber.close();
  await disconnected;
  assert.ok(controls.includes('{"type":"CloseStream"}'));
  assert.equal(recorder.errors.length, 0);
});

test('Deepgram rejects audio overflow and reports remote failure exactly once', async (t) => {
  const server = await startWebSocketServer();
  t.after(closeWebSocketServer.bind(null, server));
  const overflow = new TranscriptionRecorder();
  const buffered = new DeepgramTranscriber('key', overflow, {
    endpoint: webSocketUrl(server),
    maxBufferedAudioBytes: 4,
  });
  buffered.send(phoneAudio);
  assert.equal(overflow.errors.length, 1);
  assert.match(overflow.errors[0]?.message ?? '', /buffer exceeded/);

  const connected = once(server, 'connection');
  const recorder = new TranscriptionRecorder();
  const transcriber = new DeepgramTranscriber('key', recorder, {
    endpoint: webSocketUrl(server),
  });
  t.after(transcriber.close.bind(transcriber));
  const [socket] = (await connected) as [WebSocket];
  const disconnected = once(socket, 'close', {
    signal: AbortSignal.timeout(3000),
  });
  socket.send(
    JSON.stringify({ type: 'Error', description: 'provider failure' }),
  );
  await disconnected;
  assert.equal(recorder.errors.length, 1);
  assert.match(recorder.errors[0]?.message ?? '', /transcription error/);
});
