import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackCandidates, validateCallbackAt } from '../src/callbacks.js';
import { initialState, opening, resultFor } from '../src/collection.js';
import type {
  CollectionState,
  CollectionTask,
  TranscriptEntry,
} from '../src/contracts.js';
import { SimulationDecisionEngine } from '../src/providers/jev.js';

const task: CollectionTask = {
  type: 'payment_collection',
  recipientName: 'Jane Doe',
  organization: 'Example Services',
  amountMinor: 12500,
  currency: 'USD',
  reference: 'INV-100',
  deadline: '2026-10-08',
  timezone: 'America/Los_Angeles',
  maxReminders: 2,
};
const now = new Date('2026-10-06T18:00:00Z');
const engine = new SimulationDecisionEngine();

function recipient(text: string): TranscriptEntry[] {
  return [{ role: 'recipient', text, at: now.toISOString() }];
}

function confirmed(): CollectionState {
  return { ...initialState(), identityConfirmed: true };
}

test('callback parsing requires an explicit clock, resolves relative durations, and rejects ranges', () => {
  for (const text of [
    'tomorrow',
    'tomorrow morning',
    'later',
    'at 3',
    'from 3pm to 5pm',
  ]) {
    assert.deepEqual(callbackCandidates(text, task, now), [], text);
  }
  for (const [text, at] of [
    ['tomorrow at 3pm', '2026-10-07T22:00:00.000Z'],
    ['at 15:00', '2026-10-06T22:00:00.000Z'],
    ['today at 15:00:30', '2026-10-06T22:00:30.000Z'],
    ['3pm', '2026-10-06T22:00:00.000Z'],
    ['10am', '2026-10-07T17:00:00.000Z'],
    ['in 20 minutes', '2026-10-06T18:20:00.000Z'],
    ['in two hours', '2026-10-06T20:00:00.000Z'],
    ['in 3 seconds', '2026-10-06T18:00:03.000Z'],
    ['tomorrow at noon', '2026-10-07T19:00:00.000Z'],
  ])
    assert.equal(callbackCandidates(text!, task, now)[0]?.at, at, text);
});

test('callback wall clocks reject missing and ambiguous DST hours but durations represent actual elapsed time', () => {
  assert.deepEqual(
    callbackCandidates('March 14 2027 at 2:30am', task, now),
    [],
  );
  assert.deepEqual(
    callbackCandidates('November 1 2026 at 1:30am', task, now),
    [],
  );
  assert.equal(
    callbackCandidates('March 14 2027 at 3:30am', task, now)[0]?.at,
    '2027-03-14T10:30:00.000Z',
  );
  assert.equal(
    callbackCandidates(
      'in two hours',
      task,
      new Date('2027-03-14T09:30:00Z'),
    )[0]?.at,
    '2027-03-14T11:30:00.000Z',
  );
});

test('callback deadline validation uses inclusive local end of day and permits overdue followup without moving deadline', () => {
  assert.equal(
    validateCallbackAt(task, '2026-10-09T06:59:59.999Z', now),
    'valid',
  );
  assert.equal(
    validateCallbackAt(task, '2026-10-09T07:00:00.000Z', now),
    'after_deadline',
  );
  assert.equal(validateCallbackAt(task, now.toISOString(), now), 'past');
  assert.equal(validateCallbackAt(task, '2026-10-06T17:59:59Z', now), 'past');
  assert.equal(validateCallbackAt(task, '2026-10-06T22:00:00', now), 'invalid');
  assert.equal(
    validateCallbackAt(
      task,
      '2026-10-10T18:00:00Z',
      new Date('2026-10-09T07:00:00Z'),
    ),
    'valid',
  );
  const fall = { ...task, deadline: '2026-11-01' };
  assert.equal(
    validateCallbackAt(
      fall,
      '2026-11-02T07:59:59Z',
      new Date('2026-11-01T07:00:00Z'),
    ),
    'valid',
  );
  assert.equal(
    validateCallbackAt(
      fall,
      '2026-11-02T08:00:00Z',
      new Date('2026-11-01T07:00:00Z'),
    ),
    'after_deadline',
  );
});

test('busy requests negotiate a precise time without revealing debt before identity', async () => {
  const busy = await engine.respond(
    task,
    initialState(),
    recipient("I'm busy, call me later"),
    now,
  );
  assert.equal(busy.finishReason, undefined);
  assert.equal(busy.state.awaitingCallbackTime, true);
  assert.match(busy.text, /exact date and time/);
  assert.doesNotMatch(busy.text, /payment|125|INV-100|Example Services/);
  const agreed = await engine.respond(
    task,
    busy.state,
    recipient('tomorrow at 3pm'),
    now,
  );
  assert.equal(agreed.finishReason, 'callback_requested');
  assert.equal(agreed.state.identityConfirmed, false);
  assert.equal(agreed.state.paymentStatus, 'unknown');
  assert.equal(agreed.state.promisedDate, null);
  assert.equal(agreed.state.pendingCallback?.at, '2026-10-07T22:00:00.000Z');
  const result = resultFor(task, agreed.state, agreed.finishReason!);
  assert.equal(result.needsHuman, false);
  assert.equal(result.informationComplete, false);
  assert.equal(result.callback?.deadlineStatus, 'within_deadline');
  assert.deepEqual(result.callback?.evidence, {
    text: 'tomorrow at 3pm',
    at: now.toISOString(),
  });
});

test('a callback time never becomes a payment promise, including when unpaid is already known', async () => {
  const unpaid = await engine.respond(
    task,
    confirmed(),
    recipient('I have not paid'),
    now,
  );
  const callback = await engine.respond(
    task,
    unpaid.state,
    recipient('Call me tomorrow at 3pm'),
    now,
  );
  assert.equal(callback.finishReason, 'callback_requested');
  assert.equal(callback.state.paymentStatus, 'unpaid');
  assert.equal(callback.state.promisedDate, null);
  assert.equal(callback.state.timelineEvidence, null);
  const combined = await engine.respond(
    task,
    confirmed(),
    recipient("I have not paid. I'm busy, call me tomorrow at 3pm"),
    now,
  );
  assert.equal(combined.finishReason, 'callback_requested');
  assert.equal(combined.state.paymentStatus, 'unpaid');
  assert.equal(combined.state.promisedDate, null);
});

test('simulation keeps separate explicit payment and callback clauses independent and abstains on combined ambiguous wording', async () => {
  for (const text of [
    'I will pay tomorrow. Call me today at 2pm.',
    'I will pay tomorrow at 10am. Call me today at 2pm.',
    'Call me today at 2pm. I will pay tomorrow at 10am.',
    'I will pay tomorrow at 10am and call me today at 2pm.',
    'I will pay tomorrow, call me today at 2pm.',
  ]) {
    const response = await engine.respond(
      task,
      confirmed(),
      recipient(text),
      now,
    );
    assert.equal(response.finishReason, 'callback_requested', text);
    assert.equal(response.state.paymentStatus, 'unpaid', text);
    assert.equal(response.state.promisedDate, '2026-10-07', text);
    assert.equal(
      response.state.pendingCallback?.at,
      '2026-10-06T21:00:00.000Z',
      text,
    );
    assert.equal(response.state.informationComplete, true, text);
    assert.equal(response.state.timelineEvidence?.text, text);
  }
  const ambiguous = await engine.respond(
    task,
    confirmed(),
    recipient('I will pay tomorrow when you call me at 2pm.'),
    now,
  );
  assert.equal(ambiguous.state.promisedDate, null);
  assert.equal(ambiguous.state.pendingCallback, null);
  assert.equal(ambiguous.finishReason, undefined);
});

test('callback beyond future deadline is renegotiated and overdue requests preserve the deadline reminder', async () => {
  const rejected = await engine.respond(
    task,
    confirmed(),
    recipient('Call me October 9 at 3pm'),
    now,
  );
  assert.equal(rejected.finishReason, undefined);
  assert.equal(rejected.state.pendingCallback, null);
  assert.match(rejected.text, /after the payment deadline/);
  assert.doesNotMatch(rejected.text, /already late/);
  const accepted = await engine.respond(
    task,
    rejected.state,
    recipient('October 8 at 11:59pm'),
    now,
  );
  assert.equal(accepted.finishReason, 'callback_requested');
  const overdueTask = { ...task, deadline: '2026-10-05' };
  const overdue = await engine.respond(
    overdueTask,
    confirmed(),
    recipient('Call me tomorrow at 3pm'),
    now,
  );
  assert.equal(overdue.finishReason, 'callback_requested');
  assert.match(overdue.text, /already late/);
  assert.match(overdue.text, /needs to be made today/);
  assert.match(overdue.text, /does not extend/);
  assert.equal(
    resultFor(overdueTask, overdue.state, overdue.finishReason!).callback
      ?.deadlineStatus,
    'overdue',
  );
  const privateAnswer = await engine.respond(
    overdueTask,
    initialState(),
    recipient('Call me tomorrow at 3pm'),
    now,
  );
  assert.doesNotMatch(privateAnswer.text, /payment|late|deadline/);
});

test('a callback can carry independently complete payment facts without demanding payment already reported paid', async () => {
  const answer = await engine.respond(
    { ...task, deadline: '2026-10-05' },
    confirmed(),
    recipient('I already paid in full. Call me tomorrow at 3pm.'),
    now,
  );
  assert.equal(answer.finishReason, 'callback_requested');
  assert.equal(answer.state.paymentStatus, 'reported_paid');
  assert.equal(answer.state.informationComplete, true);
  assert.doesNotMatch(answer.text, /needs to be made today/);
});

test('interrupted callback closing can revise its time and priority exits erase stale callback agreement', async () => {
  const first = await engine.respond(
    task,
    confirmed(),
    recipient('Call me tomorrow at 3pm'),
    now,
  );
  const revised = await engine.respond(
    task,
    first.state,
    recipient('Actually tomorrow at 4pm'),
    now,
  );
  assert.equal(revised.state.pendingCallback?.at, '2026-10-07T23:00:00.000Z');
  assert.equal(
    revised.state.pendingCallback?.evidence.text,
    'Actually tomorrow at 4pm',
  );
  assert.notEqual(first.text, revised.text);
  const thanks = await engine.respond(
    task,
    revised.state,
    recipient('Okay, thanks!'),
    now,
  );
  assert.equal(thanks.finishReason, 'callback_requested');
  assert.deepEqual(thanks.state.pendingCallback, revised.state.pendingCallback);
  for (const text of [
    'Stop calling me',
    'Wrong number',
    "I don't owe this amount",
  ]) {
    const stopped = await engine.respond(
      task,
      revised.state,
      recipient(text),
      now,
    );
    assert.equal(stopped.state.pendingCallback, null);
    assert.equal(stopped.state.awaitingCallbackTime, false);
    assert.equal(
      resultFor(task, stopped.state, stopped.finishReason!).callback,
      null,
    );
  }
});

test('vague, negated, past and multiple callback alternatives require clarification', async () => {
  for (const text of [
    'Call me later',
    'Call me tomorrow',
    'Call me today at 10am',
    'Maybe call me tomorrow at 3pm',
    'Call me tomorrow at 3pm or 4pm',
    'Call me between 3pm and 5pm',
  ]) {
    const response = await engine.respond(
      task,
      confirmed(),
      recipient(text),
      now,
    );
    assert.equal(response.finishReason, undefined, text);
    assert.equal(response.state.pendingCallback, null, text);
  }
  const agreed = await engine.respond(
    task,
    confirmed(),
    recipient('Call me tomorrow at 3pm'),
    now,
  );
  const retracted = await engine.respond(
    task,
    agreed.state,
    recipient('Not tomorrow at 3pm'),
    now,
  );
  assert.equal(retracted.finishReason, undefined);
  assert.equal(retracted.state.pendingCallback, null);
});

test('callback openings disclose identity safely and retained facts require fresh payment confirmation', async () => {
  assert.match(opening(task, true), /callback you requested/);
  assert.match(opening(task, true), /AI voice assistant.*transcribed/);
  assert.doesNotMatch(opening(task, true), /payment|INV-100|125/);
  const prior: CollectionState = {
    ...initialState(),
    requiresPaymentRefresh: true,
    paymentStatus: 'unpaid',
    promisedDate: '2026-10-07',
    paymentEvidence: { text: 'I will pay tomorrow', at: now.toISOString() },
    timelineEvidence: { text: 'I will pay tomorrow', at: now.toISOString() },
    responseCounts: { introduction: 1 },
  };
  const yes = await engine.respond(task, prior, recipient('Yes'), now);
  assert.equal(yes.finishReason, undefined);
  assert.equal(yes.state.requiresPaymentRefresh, true);
  assert.doesNotMatch(yes.text, /INV-100|125|on behalf of/);
  const refreshed = await engine.respond(
    task,
    yes.state,
    recipient('I have not paid'),
    now,
  );
  assert.equal(refreshed.state.requiresPaymentRefresh, false);
  assert.equal(refreshed.state.promisedDate, null);
  assert.equal(refreshed.finishReason, undefined);
});

test('pause, resume, repeat and concise responses vary without losing known payment facts', async () => {
  let response = await engine.respond(
    task,
    confirmed(),
    recipient('I have not paid'),
    now,
  );
  const evidence = response.state.paymentEvidence;
  const texts = new Set([response.text]);
  for (const text of [
    'Can you repeat that?',
    'I did not hear you',
    'Say that again',
  ]) {
    response = await engine.respond(task, response.state, recipient(text), now);
    texts.add(response.text);
    assert.equal(response.state.paymentStatus, 'unpaid');
    assert.deepEqual(response.state.paymentEvidence, evidence);
    assert.doesNotMatch(response.text, /125|INV-100|on behalf of/);
  }
  assert.equal(texts.size, 3);
  const paused = await engine.respond(
    task,
    response.state,
    recipient('Hold on a moment'),
    now,
  );
  assert.equal(paused.state.paused, true);
  assert.doesNotMatch(paused.text, /payment|pay|date/);
  const waiting = await engine.respond(
    task,
    paused.state,
    recipient('Hmm'),
    now,
  );
  assert.equal(waiting.state.paused, true);
  assert.equal(waiting.text, '');
  const resumed = await engine.respond(
    task,
    paused.state,
    recipient("I'm ready, go ahead"),
    now,
  );
  assert.equal(resumed.state.paused, false);
  assert.equal(resumed.state.paymentStatus, 'unpaid');
  const brief = await engine.respond(
    task,
    resumed.state,
    recipient('Keep it short'),
    now,
  );
  assert.equal(brief.state.concise, true);
  assert.ok(brief.text.length < 50, brief.text);
});

test('callback withdrawal and current availability resume the call and clear stale callback agreements', async () => {
  const busy = await engine.respond(
    task,
    confirmed(),
    recipient('I am busy'),
    now,
  );
  const agreed = await engine.respond(
    task,
    busy.state,
    recipient('tomorrow at 3pm'),
    now,
  );
  for (const previous of [busy.state, agreed.state]) {
    for (const text of [
      'Actually, no callback. I can talk now.',
      'Go ahead',
      'Continue',
      'Cancel the callback, I can talk now',
    ]) {
      const resumed = await engine.respond(
        task,
        previous,
        recipient(text),
        now,
      );
      assert.equal(resumed.state.awaitingCallbackTime, false, text);
      assert.equal(resumed.state.pendingCallback, null, text);
      assert.equal(resumed.finishReason, undefined, text);
      assert.match(resumed.text, /paid|payment|pay/, text);
      assert.doesNotMatch(resumed.text, /callback/, text);
    }
  }
  const optOut = await engine.respond(
    task,
    agreed.state,
    recipient('Do not call me'),
    now,
  );
  assert.equal(optOut.finishReason, 'opt_out');
});

test('payment facts and corrections survive a same-utterance pause and complete after resuming', async () => {
  const paid = await engine.respond(
    task,
    confirmed(),
    recipient('I already paid yesterday. Hold on a moment.'),
    now,
  );
  assert.equal(paid.state.paused, true);
  assert.equal(paid.state.paymentStatus, 'reported_paid');
  assert.equal(
    paid.state.paymentEvidence?.text,
    'I already paid yesterday. Hold on a moment.',
  );
  assert.equal(paid.state.informationComplete, true);
  assert.equal(paid.finishReason, undefined);
  const resumed = await engine.respond(
    task,
    paid.state,
    recipient('Go ahead'),
    now,
  );
  assert.equal(resumed.finishReason, 'information_complete');
  const promise = await engine.respond(
    task,
    confirmed(),
    recipient('I will pay tomorrow. Hold on a moment.'),
    now,
  );
  assert.equal(promise.state.paused, true);
  assert.equal(promise.state.paymentStatus, 'unpaid');
  assert.equal(promise.state.promisedDate, '2026-10-07');
  assert.equal(promise.finishReason, undefined);
  const retracted = await engine.respond(
    task,
    promise.state,
    recipient('I cannot commit to that date anymore. Hold on.'),
    now,
  );
  assert.equal(retracted.state.promisedDate, null);
  assert.equal(retracted.state.timelineEvidence, null);
  const unconfirmed = await engine.respond(
    task,
    initialState(),
    recipient('I already paid yesterday. Hold on.'),
    now,
  );
  assert.equal(unconfirmed.state.paymentStatus, 'unknown');
});

test('repeat and brief requests adapt callback questions without erasing the agreed time', async () => {
  const busy = await engine.respond(
    task,
    confirmed(),
    recipient('I am busy'),
    now,
  );
  const repeat = await engine.respond(
    task,
    busy.state,
    recipient('Please repeat that'),
    now,
  );
  assert.equal(repeat.state.awaitingCallbackTime, true);
  assert.notEqual(repeat.text, busy.text);
  const brief = await engine.respond(
    task,
    repeat.state,
    recipient('Keep it short'),
    now,
  );
  assert.equal(brief.state.concise, true);
  assert.equal(brief.state.awaitingCallbackTime, true);
  assert.ok(brief.text.length < 40, brief.text);
  const agreed = await engine.respond(
    task,
    brief.state,
    recipient('tomorrow at 3pm'),
    now,
  );
  for (const text of ['Repeat that', 'Keep it short']) {
    const reminder = await engine.respond(
      task,
      agreed.state,
      recipient(text),
      now,
    );
    assert.equal(reminder.finishReason, 'callback_requested');
    assert.deepEqual(
      reminder.state.pendingCallback,
      agreed.state.pendingCallback,
    );
    assert.match(reminder.text, /October 7/);
  }
});
