import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CreateRunSchema, type Run } from '../src/contracts.js';
import { RunStore } from '../src/store.js';

const key = 'callback-http-test-secret-at-least-32-characters';
const request = CreateRunSchema.parse({
  to: '+15555550123',
  voice: { provider: 'minimax', voiceId: 'English_Graceful_Lady' },
  task: {
    type: 'payment_collection',
    recipientName: 'Alex Example',
    organization: 'Example Company',
    amountMinor: 25000,
    currency: 'USD',
    reference: 'INV-200',
    deadline: '2099-12-31',
    timezone: 'America/Los_Angeles',
  },
  authorization: { consentToCall: true, consentToTranscribe: true },
});

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'yapper-callback-api-'));
  const config = loadConfig({
    YAPPER_API_KEY: key,
    DATABASE_PATH: join(directory, 'runs.sqlite'),
  });
  const server = await buildApp(config);
  const url = await server.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await server.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...server, config, url };
}

async function api(
  url: string,
  path: string,
  method = 'GET',
  body?: unknown,
  idempotencyKey = 'callback-parent-1',
): Promise<Response> {
  return fetch(url + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForActive(url: string, id: string): Promise<Run> {
  for (let tries = 0; tries < 100; tries++) {
    const run = (await (await api(url, `/v1/runs/${id}`)).json()) as Run;
    if (run.status === 'in_progress') return run;
    await delay(20);
  }
  throw new Error('Callback did not start');
}

async function turn(url: string, id: string, text: string): Promise<Run> {
  const response = await api(url, `/v1/runs/${id}/turns`, 'POST', { text });
  assert.equal(response.status, 200);
  return response.json() as Promise<Run>;
}

async function callbackRequest(url: string): Promise<Run> {
  const accepted = await api(url, '/v1/runs', 'POST', request);
  assert.equal(accepted.status, 202);
  const { id } = (await accepted.json()) as { id: string };
  await waitForActive(url, id);
  await turn(url, id, 'Yes, I am Alex Example.');
  await turn(url, id, 'I have not paid.');
  return turn(url, id, 'I am busy. Please call me back in 3 seconds.');
}

test('external callback handoff waits for the agreed time, starts one linked call, and refreshes payment evidence', async (t) => {
  const { url, store } = await setup(t);
  const parent = await callbackRequest(url);
  assert.equal(parent.status, 'completed');
  assert.equal(parent.result?.finishReason, 'callback_requested');
  assert.equal(parent.result?.callback?.deadlineStatus, 'within_deadline');
  assert.equal(
    parent.result?.callback?.evidence.text,
    'I am busy. Please call me back in 3 seconds.',
  );
  assert.equal(parent.state.paymentStatus, 'unpaid');
  assert.equal(parent.state.promisedDate, null);
  const path = `/v1/runs/${parent.id}/callback`;
  const early = await api(url, path, 'POST', {}, 'callback-child-1');
  assert.equal(early.status, 409);
  assert.ok(Number(early.headers.get('retry-after')) > 0);
  assert.match(
    ((await early.json()) as { error: string }).error,
    /not arrived/,
  );
  await delay(
    Math.max(0, Date.parse(parent.result!.callback!.at) - Date.now()) + 30,
  );
  assert.equal(
    store.list(['queued', 'in_progress', 'dialing']).length,
    0,
    'Agreed callbacks must not dial without the external trigger',
  );
  const responses = await Promise.all([
    api(url, path, 'POST', {}, 'callback-child-1'),
    api(url, path, 'POST', {}, 'callback-child-2'),
  ]);
  for (const response of responses) assert.equal(response.status, 202);
  const bodies = (await Promise.all(
    responses.map((response) => response.json()),
  )) as { id: string }[];
  assert.equal(bodies[0]!.id, bodies[1]!.id);
  const child = await waitForActive(url, bodies[0]!.id);
  assert.equal(child.parentRunId, parent.id);
  assert.equal(child.rootRunId, parent.id);
  assert.equal(store.get(parent.id)?.callbackRunId, child.id);
  assert.equal(child.state.requiresPaymentRefresh, true);
  assert.equal(child.state.identityConfirmed, false);
  assert.equal(child.state.paymentStatus, 'unpaid');
  assert.equal(child.transcript.length, 1);
  assert.match(child.transcript[0]!.text, /again|callback|back/i);
  assert.doesNotMatch(child.transcript[0]!.text, /250|INV-200/);
  const refreshed = await turn(url, child.id, 'Yes, I am Alex Example.');
  assert.equal(refreshed.status, 'in_progress');
  assert.equal(refreshed.state.requiresPaymentRefresh, true);
  assert.doesNotMatch(refreshed.transcript.at(-1)!.text, /250|INV-200/);
  const paid = await turn(url, child.id, 'I have already paid in full.');
  assert.equal(paid.result?.paymentStatus, 'reported_paid');
  assert.equal(
    paid.result?.paymentEvidence?.text,
    'I have already paid in full.',
  );
  assert.equal(paid.result?.paymentVerified, false);
  assert.equal(
    (await api(url, path, 'POST', {}, 'callback-parent-1')).status,
    409,
    'A key from another operation cannot enqueue a callback',
  );
  assert.equal(
    (await api(url, '/v1/runs', 'POST', request, 'callback-child-1')).status,
    409,
    'Callback keys cannot be replayed as new root requests',
  );
  assert.equal(
    (await api(url, '/v1/runs', 'POST', request, 'callback-child-2')).status,
    409,
    'Keys used to retrieve an existing callback are also reserved',
  );
  const aliasReplay = await api(url, path, 'POST', {}, 'callback-child-2');
  assert.equal(aliasReplay.status, 202);
  assert.equal(((await aliasReplay.json()) as { id: string }).id, child.id);
  assert.equal(
    (await api(url, path, 'POST', { to: '+15555550999' }, 'callback-other-1'))
      .status,
    400,
  );
  assert.equal(
    (
      await api(
        url,
        `/v1/runs/${child.id}/callback`,
        'POST',
        {},
        'callback-other-2',
      )
    ).status,
    409,
  );
});

test('suppression and uncertain prior hangup block external callbacks', async (t) => {
  const { url, store } = await setup(t);
  const parent = await callbackRequest(url);
  assert.equal(parent.result?.finishReason, 'callback_requested');
  const due = new Date(Date.parse(parent.result!.callback!.at) + 1);
  parent.callSid = `CA${'a'.repeat(32)}`;
  parent.callEndedAt = null;
  store.save(parent);
  assert.throws(
    () => store.createCallback(parent.id, 'callback-uncertain-1', due),
    /not been confirmed ended/,
  );
  parent.callEndedAt = new Date().toISOString();
  parent.error = 'Could not confirm call hangup; check the telephony provider';
  store.save(parent);
  assert.throws(
    () => store.createCallback(parent.id, 'callback-uncertain-2', due),
    /prior call error/,
  );
  parent.error = null;
  store.save(parent);
  store.suppress(parent.request.to);
  const blocked = await api(
    url,
    `/v1/runs/${parent.id}/callback`,
    'POST',
    {},
    'callback-suppressed-1',
  );
  assert.equal(blocked.status, 409);
  assert.match(
    ((await blocked.json()) as { error: string }).error,
    /opted out/,
  );
  assert.equal(store.get(parent.id)?.callbackRunId, null);
});

test('legacy SQLite rows hydrate additive conversation and callback fields without changing idempotency', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'yapper-legacy-callback-'));
  const path = join(directory, 'runs.sqlite');
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const original = new RunStore(path);
  const created = original.create(request, 'legacy-create-1').run;
  original.close();
  const legacy = JSON.parse(JSON.stringify(created)) as Record<string, unknown>;
  for (const field of [
    'parentRunId',
    'rootRunId',
    'callbackRunId',
    'callEndedAt',
  ])
    delete legacy[field];
  const state = legacy.state as Record<string, unknown>;
  for (const field of [
    'responseCounts',
    'concise',
    'paused',
    'awaitingCallbackTime',
    'pendingCallback',
    'requiresPaymentRefresh',
  ])
    delete state[field];
  const raw = new DatabaseSync(path);
  raw
    .prepare('UPDATE runs SET payload = ?, request_hash = ? WHERE id = ?')
    .run(
      JSON.stringify(legacy),
      createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      created.id,
    );
  raw.close();
  const restored = new RunStore(path);
  t.after(() => restored.close());
  const run = restored.get(created.id)!;
  assert.deepEqual(run.state.responseCounts, {});
  assert.equal(run.state.pendingCallback, null);
  assert.equal(run.state.requiresPaymentRefresh, false);
  assert.equal(run.rootRunId, run.id);
  assert.equal(run.callEndedAt, null);
  assert.equal(restored.create(request, 'legacy-create-1').run.id, created.id);
});
