import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DateTime } from 'luxon';
import { WebSocket } from 'ws';
import twilio from 'twilio';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CreateRunSchema, type Run, type CreateRun } from '../src/contracts.js';
import type { Dialer } from '../src/providers/twilio.js';

const apiKey = 'test-secret-that-is-longer-than-thirty-two-characters';
const accountSid = `AC${'a'.repeat(32)}`;
const callSid = `CA${'b'.repeat(32)}`;
const authToken = 'test-twilio-auth-token';
const publicBase = 'https://yapper.example.com';
const timezone = 'America/Los_Angeles';

function example(provider: 'elevenlabs' | 'minimax' = 'elevenlabs'): CreateRun {
  return CreateRunSchema.parse({
    to: '+15555550123',
    voice: { provider, voiceId: 'test_voice' },
    task: {
      type: 'payment_collection',
      recipientName: 'Alex Example',
      organization: 'Example Company',
      amountMinor: 25000,
      currency: 'USD',
      reference: 'INV-1042',
      deadline: DateTime.now().setZone(timezone).minus({ days: 1 }).toISODate(),
      timezone,
    },
    authorization: { consentToCall: true, consentToTranscribe: true },
  });
}

class TestDialer implements Dialer {
  dialed: string[] = [];
  hungup: string[] = [];
  async dial(run: Run): Promise<string> {
    this.dialed.push(run.id);
    return callSid;
  }
  async hangup(sid: string): Promise<void> {
    this.hungup.push(sid);
  }
}

async function setup(t: TestContext, live = false) {
  const directory = await mkdtemp(join(tmpdir(), 'yapper-api-'));
  const config = loadConfig({
    YAPPER_API_KEY: apiKey,
    DATABASE_PATH: join(directory, 'calls.sqlite'),
    YAPPER_MODE: live ? 'live' : 'simulation',
    PUBLIC_BASE_URL: publicBase,
    ALLOWED_NUMBERS: '+15555550123',
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_FROM_NUMBER: '+15555550124',
    DEEPGRAM_API_KEY: 'local-test',
    TYPESAFE_API_KEY: 'local-test',
    ELEVENLABS_API_KEY: 'local-test',
  });
  const dialer = new TestDialer();
  const server = await buildApp(config, { dialer });
  const url = await server.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, url, dialer };
}

async function api(
  url: string,
  path: string,
  method = 'GET',
  body?: unknown,
  key = 'test-request-0001',
): Promise<Response> {
  return fetch(url + path, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function active(url: string, id: string): Promise<Run> {
  for (let count = 0; count < 100; count += 1) {
    const run = (await (await api(url, `/v1/runs/${id}`)).json()) as Run;
    if (
      run.status === 'in_progress' ||
      (run.status === 'dialing' && run.callSid)
    )
      return run;
    await delay(20);
  }
  throw new Error('Run did not become active');
}

async function turn(url: string, id: string, text: string): Promise<Run> {
  const response = await api(url, `/v1/runs/${id}/turns`, 'POST', { text });
  assert.equal(response.status, 200);
  return response.json() as Promise<Run>;
}

test('HTTP create returns immediately, rejects duplicate payload conflicts, negotiates deadline and persists the final contract', async (t) => {
  const { url, store } = await setup(t);
  const request = example('minimax');
  const response = await api(url, '/v1/runs', 'POST', request);
  assert.equal(response.status, 202);
  const created = (await response.json()) as {
    id: string;
    status: string;
    statusUrl: string;
    resultUrl: string;
  };
  assert.equal(created.status, 'queued');
  assert.equal(response.headers.get('location'), created.statusUrl);
  const duplicate = (await (
    await api(url, '/v1/runs', 'POST', request)
  ).json()) as { id: string };
  assert.equal(duplicate.id, created.id);
  assert.equal(
    (
      await api(url, '/v1/runs', 'POST', {
        ...request,
        task: { ...request.task, amountMinor: 100 },
      })
    ).status,
    409,
  );
  const pending = await api(url, created.resultUrl);
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get('retry-after'), '2');
  const run = await active(url, created.id);
  assert.equal(run.request.voice.provider, 'minimax');
  assert.equal(run.transcript.length, 1);
  assert.doesNotMatch(run.transcript[0]!.text, /250|INV-1042/);
  await turn(url, run.id, 'Yes, I am Alex Example.');
  const late = await turn(url, run.id, 'I have not paid. I will pay tomorrow.');
  assert.equal(late.status, 'in_progress');
  assert.match(late.transcript.at(-1)!.text, /already late.*today/);
  const completed = await turn(url, run.id, 'I will pay today.');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result?.paymentStatus, 'unpaid');
  assert.equal(
    completed.result?.promisedDate,
    DateTime.now().setZone(timezone).toISODate(),
  );
  assert.equal(completed.result?.exceedsDeadline, true);
  assert.equal(completed.result?.paymentVerified, false);
  assert.equal(completed.result?.informationComplete, true);
  assert.equal(completed.result?.timelineEvidence?.text, 'I will pay today.');
  assert.equal((await api(url, created.resultUrl)).status, 200);
  assert.deepEqual(store.get(run.id)?.result, completed.result);
  assert.equal(
    (
      await api(url, `/v1/runs/${run.id}/turns`, 'POST', {
        text: 'another turn',
      })
    ).status,
    409,
  );
});

test('HTTP auth, validation and provider gates fail before enqueueing', async (t) => {
  const { url, store } = await setup(t, true);
  assert.equal((await fetch(`${url}/v1/runs/nope`)).status, 401);
  assert.equal(
    (
      await api(url, '/v1/runs', 'POST', {
        ...example(),
        authorization: { consentToCall: false, consentToTranscribe: true },
      })
    ).status,
    400,
  );
  assert.equal(
    (await api(url, '/v1/runs', 'POST', { ...example(), to: '+15555550999' }))
      .status,
    403,
  );
  assert.equal(
    (await api(url, '/v1/runs', 'POST', example('minimax'))).status,
    503,
  );
  assert.equal(
    (await api(url, '/v1/runs', 'POST', example(), 'short')).status,
    400,
  );
  assert.equal(
    (await api(url, '/v1/runs/nope/turns', 'POST', { text: 'hello' })).status,
    404,
  );
  assert.equal(store.list(['queued', 'dialing', 'in_progress']).length, 0);
  assert.equal(
    (
      await api(url, '/v1/runs', 'POST', {
        ...example(),
        task: { ...example().task, timezone: '+02:00' },
      })
    ).status,
    400,
  );
  const schema = (await (await fetch(`${url}/openapi.json`)).json()) as {
    openapi: string;
  };
  assert.equal(schema.openapi, '3.1.0');
});

test('HTTP opt-out suppression survives subsequent submissions, and cancellation is terminal', async (t) => {
  const { url } = await setup(t);
  const created = (await (
    await api(url, '/v1/runs', 'POST', example())
  ).json()) as { id: string };
  await active(url, created.id);
  const stopped = await turn(url, created.id, 'Stop calling me.');
  assert.equal(stopped.result?.finishReason, 'opt_out');
  assert.equal(
    (await api(url, '/v1/runs', 'POST', example(), 'another-call-0001')).status,
    409,
  );
  const replay = (await (
    await api(url, '/v1/runs', 'POST', example())
  ).json()) as { id: string };
  assert.equal(replay.id, created.id);
  const other = { ...example(), to: '+15555550125' };
  const next = (await (
    await api(url, '/v1/runs', 'POST', other, 'other-call-0001')
  ).json()) as { id: string };
  const canceled = (await (
    await api(url, `/v1/runs/${next.id}/cancel`, 'POST', {})
  ).json()) as Run;
  assert.equal(canceled.status, 'canceled');
  assert.equal(canceled.result?.finishReason, 'canceled');
  const repeated = (await (
    await api(url, `/v1/runs/${next.id}/cancel`, 'POST', {})
  ).json()) as Run;
  assert.deepEqual(repeated, canceled);
});

async function callback(
  url: string,
  path: string,
  params: Record<string, string>,
  signature?: string,
) {
  return fetch(url + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature':
        signature ??
        twilio.getExpectedTwilioSignature(authToken, publicBase + path, params),
    },
    body: new URLSearchParams(params),
  });
}

test('Signed voice callbacks bind the call and reject forged identity; signed WSS handshake accepts documented slash variation', async (t) => {
  const { url, dialer } = await setup(t, true);
  const created = (await (
    await api(url, '/v1/runs', 'POST', example())
  ).json()) as { id: string };
  await active(url, created.id);
  const path = `/twilio/voice/${created.id}`;
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    To: '+15555550123',
    AnsweredBy: 'human',
  };
  assert.equal((await callback(url, path, params, 'forged')).status, 403);
  const xml = await (await callback(url, path, params)).text();
  assert.match(
    xml,
    /<Connect><Stream url="wss:\/\/yapper.example.com\/twilio\/media\//,
  );
  const wrong = await (
    await callback(url, path, { ...params, CallSid: `CA${'c'.repeat(32)}` })
  ).text();
  assert.match(wrong, /<Hangup/);
  const mediaPath = `/twilio/media/${created.id}`;
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    `${publicBase.replace('https:', 'wss:')}${mediaPath}/`,
    {},
  );
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}${mediaPath}`, {
    headers: { 'x-twilio-signature': signature },
  });
  await once(socket, 'open');
  socket.close();
  await once(socket, 'close');
  await delay(20);
  assert.deepEqual(dialer.dialed, [created.id]);
  const run = (await (await api(url, `/v1/runs/${created.id}`)).json()) as Run;
  assert.equal(run.status, 'completed');
});

test('Answering machines are not given payment information and late status callbacks cannot reopen a terminal run', async (t) => {
  const { url, dialer } = await setup(t, true);
  const created = (await (
    await api(url, '/v1/runs', 'POST', example())
  ).json()) as { id: string };
  await active(url, created.id);
  const params = {
    AccountSid: accountSid,
    CallSid: callSid,
    To: '+15555550123',
    AnsweredBy: 'machine_start',
  };
  const xml = await (
    await callback(url, `/twilio/voice/${created.id}`, params)
  ).text();
  assert.match(xml, /<Hangup/);
  assert.doesNotMatch(xml, /Stream|250|INV/);
  const before = (await (
    await api(url, `/v1/runs/${created.id}`)
  ).json()) as Run;
  assert.equal(before.result?.finishReason, 'needs_human');
  const response = await callback(url, `/twilio/status/${created.id}`, {
    ...params,
    CallStatus: 'in-progress',
  });
  assert.equal(response.status, 204);
  const after = (await (
    await api(url, `/v1/runs/${created.id}`)
  ).json()) as Run;
  assert.deepEqual(before, after);
  assert.deepEqual(dialer.hungup, [callSid]);
});
