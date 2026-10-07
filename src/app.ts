import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import twilio from 'twilio';
import { z } from 'zod';
import type { Config } from './config.js';
import { CreateRunSchema, type DecisionEngine, type Run } from './contracts.js';
import { RunStore, ConflictError, terminalStatuses } from './store.js';
import { Runner } from './runner.js';
import { TwilioDialer, type Dialer } from './providers/twilio.js';
import {
  JevDecisionEngine,
  SimulationDecisionEngine,
} from './providers/jev.js';
import { createSpeechProvider } from './providers/speech.js';
import { createTranscriber } from './providers/deepgram.js';
import { CallSession } from './session.js';
import { openapiDocument } from './openapi.js';

export interface AppOptions {
  engine?: DecisionEngine;
  dialer?: Dialer;
  startWorker?: boolean;
}

export async function buildApp(config: Config, options: AppOptions = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 32_768,
    requestTimeout: 15_000,
  });
  const store = new RunStore(config.DATABASE_PATH);
  const engine =
    options.engine ??
    (config.YAPPER_MODE === 'live'
      ? new JevDecisionEngine({
          apiKey: config.TYPESAFE_API_KEY!,
          model: config.TYPESAFE_MODEL,
        })
      : new SimulationDecisionEngine());
  const dialer =
    config.YAPPER_MODE === 'live'
      ? (options.dialer ?? new TwilioDialer(config))
      : null;
  const runner = new Runner(store, config, engine, dialer);
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 131_072 } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConflictError)
      return reply.code(409).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'Invalid request',
        issues: error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    return reply.code(status).send({
      error: status < 500 ? 'Request rejected' : 'Internal server error',
    });
  });

  app.get('/healthz', async () => ({ status: 'ok', mode: config.YAPPER_MODE }));
  app.get('/openapi.json', async () => openapiDocument());

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request, reply) => {
        const actual = createHash('sha256')
          .update(request.headers.authorization ?? '')
          .digest();
        const expected = createHash('sha256')
          .update(`Bearer ${config.YAPPER_API_KEY}`)
          .digest();
        if (!timingSafeEqual(actual, expected))
          return reply.code(401).send({ error: 'Unauthorized' });
      });
      api.post(
        '/runs',
        { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
        async (request, reply) => {
          const body = CreateRunSchema.parse(request.body);
          const key = z
            .string()
            .min(8)
            .max(128)
            .regex(/^[a-zA-Z0-9._:-]+$/)
            .parse(request.headers['idempotency-key']);
          if (config.YAPPER_MODE === 'live') {
            if (!config.allowedNumbers.includes(body.to))
              return reply
                .code(403)
                .send({ error: 'Destination is not in ALLOWED_NUMBERS' });
            const speechKey =
              body.voice.provider === 'elevenlabs'
                ? config.ELEVENLABS_API_KEY
                : config.MINIMAX_API_KEY;
            if (!speechKey)
              return reply
                .code(503)
                .send({ error: 'Selected speech provider is not configured' });
          }
          if (store.list(['queued']).length >= 1000 && !store.hasKey(key))
            return reply.code(503).send({ error: 'Queue is full' });
          const { run } = store.create(body, key);
          return reply
            .code(202)
            .header('Location', `/v1/runs/${run.id}`)
            .send({
              id: run.id,
              status: run.status,
              statusUrl: `/v1/runs/${run.id}`,
              resultUrl: `/v1/runs/${run.id}/result`,
            });
        },
      );
      api.get<{ Params: { id: string } }>(
        '/runs/:id',
        async (request, reply) => {
          const run = store.get(request.params.id);
          return run ?? reply.code(404).send({ error: 'Run not found' });
        },
      );
      api.get<{ Params: { id: string } }>(
        '/runs/:id/result',
        async (request, reply) => {
          const run = store.get(request.params.id);
          if (!run) return reply.code(404).send({ error: 'Run not found' });
          if (!terminalStatuses.has(run.status))
            return reply
              .code(202)
              .header('Retry-After', '2')
              .send({ id: run.id, status: run.status });
          return {
            id: run.id,
            status: run.status,
            result: run.result,
            error: run.error,
          };
        },
      );
      api.post<{ Params: { id: string } }>(
        '/runs/:id/cancel',
        async (request, reply) => {
          if (!store.get(request.params.id))
            return reply.code(404).send({ error: 'Run not found' });
          await runner.finish(request.params.id, 'canceled');
          return store.get(request.params.id);
        },
      );
      if (config.YAPPER_MODE === 'simulation') {
        api.post<{ Params: { id: string } }>(
          '/runs/:id/turns',
          async (request, reply) => {
            if (!store.get(request.params.id))
              return reply.code(404).send({ error: 'Run not found' });
            const { text } = z
              .object({ text: z.string().trim().min(1).max(8000) })
              .strict()
              .parse(request.body);
            return runner.simulate(request.params.id, text);
          },
        );
        api.post<{ Params: { id: string } }>(
          '/runs/:id/end',
          async (request, reply) => {
            if (!store.get(request.params.id))
              return reply.code(404).send({ error: 'Run not found' });
            await runner.finish(request.params.id, 'call_ended');
            return store.get(request.params.id);
          },
        );
      }
    },
    { prefix: '/v1' },
  );

  if (config.YAPPER_MODE === 'live') {
    app.post<{ Params: { id: string } }>(
      '/twilio/voice/:id',
      { preValidation: twilioValidator(config) },
      async (request, reply) => {
        const body = twilioBody(request);
        const run = authorizeCall(store, request.params.id, body);
        const response = new twilio.twiml.VoiceResponse();
        if (
          !run ||
          terminalStatuses.has(run.status) ||
          body.AnsweredBy !== 'human'
        ) {
          response.hangup();
          if (run && !terminalStatuses.has(run.status))
            await runner.finish(
              run.id,
              'needs_human',
              'Answering machine or unconfirmed human',
            );
        } else {
          const connect = response.connect();
          connect.stream({
            url: `${config.PUBLIC_BASE_URL.replace(/^https:/, 'wss:')}/twilio/media/${run.id}`,
          });
          response.hangup();
        }
        return reply.type('text/xml').send(response.toString());
      },
    );
    app.post<{ Params: { id: string } }>(
      '/twilio/status/:id',
      { preValidation: twilioValidator(config) },
      async (request, reply) => {
        const body = twilioBody(request);
        const run = authorizeCall(store, request.params.id, body);
        if (!run) return reply.code(404).send({ error: 'Call not found' });
        if (!terminalStatuses.has(run.status)) {
          if (['completed', 'canceled'].includes(body.CallStatus ?? ''))
            await runner.finish(run.id, 'call_ended', undefined, false);
          else if (
            ['busy', 'failed', 'no-answer'].includes(body.CallStatus ?? '')
          )
            await runner.finish(
              run.id,
              'provider_error',
              `Call ${body.CallStatus}`,
              false,
            );
        }
        return reply.code(204).send();
      },
    );
    app.get<{ Params: { id: string } }>(
      '/twilio/media/:id',
      { websocket: true, preValidation: twilioValidator(config) },
      (socket, request) => {
        const run = store.get(request.params.id);
        if (
          !run ||
          terminalStatuses.has(run.status) ||
          runner.sessions.has(run.id)
        ) {
          socket.close(1008);
          return;
        }
        const key =
          run.request.voice.provider === 'elevenlabs'
            ? config.ELEVENLABS_API_KEY
            : config.MINIMAX_API_KEY;
        const session = new CallSession({
          id: run.id,
          socket,
          store,
          engine,
          accountSid: config.TWILIO_ACCOUNT_SID!,
          speech: createSpeechProvider(run.request.voice.provider, key!),
          transcriberFactory: (callbacks) =>
            createTranscriber(config.DEEPGRAM_API_KEY!, callbacks),
          onFinish: (id, reason, error) => runner.finish(id, reason, error),
          onClosed: (id) => {
            runner.sessions.delete(id);
          },
        });
        runner.sessions.set(run.id, session);
      },
    );
  }
  app.addHook('onClose', async () => {
    await runner.stop();
    store.close();
  });
  app.addHook('onListen', async () => {
    if (options.startWorker !== false) await runner.start();
  });
  await app.ready();
  return { app, store, runner };
}

function twilioValidator(config: Config) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers['x-twilio-signature'];
    const params = request.method === 'POST' ? twilioBody(request) : {};
    const base =
      request.method === 'GET'
        ? config.PUBLIC_BASE_URL.replace(/^https:/, 'wss:')
        : config.PUBLIC_BASE_URL;
    const url = `${base}${request.raw.url}`;
    const valid =
      typeof signature === 'string' &&
      (twilio.validateRequest(
        config.TWILIO_AUTH_TOKEN!,
        signature,
        url,
        params,
      ) ||
        (request.method === 'GET' &&
          twilio.validateRequest(
            config.TWILIO_AUTH_TOKEN!,
            signature,
            `${url}/`,
            params,
          )));
    if (
      !valid ||
      (request.method === 'POST' &&
        params.AccountSid !== config.TWILIO_ACCOUNT_SID)
    ) {
      return reply.code(403).send({ error: 'Invalid telephony signature' });
    }
  };
}

function twilioBody(request: FastifyRequest): Record<string, string> {
  return z.record(z.string(), z.string()).parse(request.body);
}

function authorizeCall(
  store: RunStore,
  id: string,
  body: Record<string, string>,
): Run | null {
  const run = store.get(id);
  if (
    !run ||
    !/^CA[a-f0-9]{32}$/i.test(body.CallSid ?? '') ||
    body.To !== run.request.to
  )
    return null;
  if (run.callSid && run.callSid !== body.CallSid) return null;
  if (!run.callSid) {
    if (run.status !== 'dialing') return null;
    run.callSid = body.CallSid!;
    store.save(run);
  }
  return run;
}
