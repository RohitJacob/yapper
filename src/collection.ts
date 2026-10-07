import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { validateCallbackAt, type CallbackCandidate } from './callbacks.js';
import {
  callbackQuestion,
  identityQuestion,
  overdueReminder,
  paymentQuestion,
  phrase,
  spokenCallback,
  spokenDate,
} from './responses.js';
import type {
  CollectionState,
  CollectionTask,
  FinishReason,
  PaymentStatus,
  RunResult,
  TranscriptEntry,
  TurnOutcome,
} from './contracts.js';

export interface DateCandidate {
  id: string;
  text: string;
  date: string;
}

export interface CollectionJudgments {
  identity: number;
  wrongParty: number;
  optOut: number;
  dispute: number;
  offTopic: number;
  paymentAddressed: number;
  timelineAddressed: number;
  paymentStatus: PaymentStatus;
  paymentConfidence: number;
  dateChoice: string;
  dateConfidence: number;
  complete: number;
  conversationControl:
    'continue' | 'busy' | 'pause' | 'resume' | 'repeat' | 'brief';
  controlConfidence: number;
  callbackRequested: number;
  callbackChoice: string;
  callbackConfidence: number;
  raw: Record<string, unknown>;
}

const ACCEPT = 0.85;
const STOP = 0.65;
const MAX_TURNS = 20;

export function initialState(): CollectionState {
  return {
    identityConfirmed: false,
    paymentStatus: 'unknown',
    promisedDate: null,
    paymentEvidence: null,
    timelineEvidence: null,
    reminders: 0,
    turns: 0,
    offTopicCount: 0,
    informationComplete: false,
    lastDecision: null,
    responseCounts: {},
    concise: false,
    paused: false,
    awaitingCallbackTime: false,
    pendingCallback: null,
    requiresPaymentRefresh: false,
  };
}

export function opening(task: CollectionTask, isCallback = false): string {
  return `Hello. I'm an AI voice assistant, and this call is transcribed.${isCallback ? ' This is the callback you requested.' : ''} Am I speaking with ${task.recipientName}?`;
}

export function resultFor(
  task: CollectionTask,
  state: CollectionState,
  reason: FinishReason,
): RunResult {
  return {
    schemaVersion: 1,
    paymentStatus: state.paymentStatus,
    paymentVerified: false,
    promisedDate: state.promisedDate,
    exceedsDeadline:
      state.promisedDate === null ? null : state.promisedDate > task.deadline,
    deadline: task.deadline,
    informationComplete: state.informationComplete,
    needsHuman:
      reason !== 'information_complete' && reason !== 'callback_requested',
    finishReason: reason,
    paymentEvidence: state.paymentEvidence,
    timelineEvidence: state.timelineEvidence,
    reminders: state.reminders,
    callback:
      reason === 'callback_requested' && state.pendingCallback
        ? {
            ...state.pendingCallback,
            timezone: task.timezone,
            deadlineStatus:
              localDate(task, new Date(state.pendingCallback.evidence.at)) >
              task.deadline
                ? 'overdue'
                : 'within_deadline',
          }
        : null,
  };
}

export function latestRecipient(
  transcript: TranscriptEntry[],
): TranscriptEntry {
  const entry = transcript.findLast((item) => item.role === 'recipient');
  if (!entry)
    throw new Error('A recipient utterance is required for a decision');
  return entry;
}

export function localDate(task: CollectionTask, now: Date): string {
  const date = DateTime.fromJSDate(now, { zone: task.timezone }).toISODate();
  if (!date)
    throw new Error('Cannot resolve the current date in the task timezone');
  return date;
}

export function dateCandidates(
  text: string,
  task: CollectionTask,
  now: Date,
): DateCandidate[] {
  const local = DateTime.fromJSDate(now, { zone: task.timezone });
  const parsed = chrono.parse(
    text,
    { instant: now, timezone: local.offset },
    { forwardDate: true },
  );
  const candidates: DateCandidate[] = [];
  for (const item of parsed) {
    if (item.end || /\b(?:week|month|year|weekend)s?\b/i.test(item.text))
      continue;
    if (!item.start.isCertain('day') && !item.start.isCertain('weekday'))
      continue;
    const year = item.start.get('year');
    const month = item.start.get('month');
    const day = item.start.get('day');
    if (year === null || month === null || day === null) continue;
    const date = DateTime.fromObject(
      { year, month, day },
      { zone: task.timezone },
    ).toISODate();
    if (!date) continue;
    candidates.push({ id: `date_${candidates.length}`, text: item.text, date });
    if (candidates.length === 24) break;
  }
  return candidates;
}

export function applyJudgments(
  task: CollectionTask,
  previous: CollectionState,
  recipient: TranscriptEntry,
  candidates: DateCandidate[],
  judgment: CollectionJudgments,
  now: Date,
  callbacks: CallbackCandidate[] = [],
): TurnOutcome {
  const state: CollectionState = {
    ...previous,
    turns: previous.turns + 1,
    informationComplete: false,
    lastDecision: judgment.raw,
    responseCounts: { ...previous.responseCounts },
  };
  if (judgment.optOut >= STOP) {
    return finish(
      state,
      'opt_out',
      'Understood. I will end this call and record your request not to be contacted. Goodbye.',
    );
  }
  if (judgment.wrongParty >= STOP) {
    return finish(
      state,
      'wrong_party',
      'Thank you for letting me know. I will record that I reached the wrong person. Goodbye.',
    );
  }
  if (judgment.dispute >= STOP) {
    return finish(
      state,
      'disputed',
      'I have recorded your dispute and will refer it to a person for review. I will end this call now. Goodbye.',
    );
  }
  if (Math.max(judgment.optOut, judgment.wrongParty, judgment.dispute) > 0.2) {
    return finish(
      state,
      'needs_human',
      'I want to make sure your concern is handled correctly. I will refer this to a person and end the call. Goodbye.',
    );
  }
  if (state.turns >= MAX_TURNS) return humanHandoff(state);
  state.identityConfirmed ||= judgment.identity >= ACCEPT;
  const today = localDate(task, now);
  if (state.identityConfirmed && judgment.offTopic < 0.7) {
    updatePayment(state, recipient, judgment);
    updateTimeline(state, recipient, candidates, judgment, today);
  }
  state.informationComplete =
    state.identityConfirmed &&
    !state.requiresPaymentRefresh &&
    judgment.complete >= ACCEPT &&
    (state.paymentStatus === 'reported_paid' ||
      (state.paymentStatus === 'unpaid' && state.promisedDate !== null));
  const control =
    judgment.controlConfidence >= 0.7
      ? judgment.conversationControl
      : 'continue';
  if (control === 'brief') state.concise = true;
  if (control === 'pause') {
    state.paused = true;
    return {
      state,
      text: previous.paused
        ? ''
        : phrase(state, 'pause', [
            "Of course. I'll wait.",
            'Take your time.',
            "Sure, I'm here when you're ready.",
          ]),
    };
  }
  if (
    previous.paused &&
    control === 'continue' &&
    judgment.paymentAddressed < 0.5 &&
    judgment.timelineAddressed < 0.5 &&
    judgment.callbackRequested < 0.5 &&
    judgment.offTopic < 0.7
  ) {
    return { state, text: '' };
  }
  state.paused = false;
  if (control === 'resume') {
    state.pendingCallback = null;
    state.awaitingCallbackTime = false;
  }
  if (
    (control === 'repeat' || control === 'brief') &&
    state.awaitingCallbackTime &&
    judgment.offTopic < 0.7
  ) {
    if (state.pendingCallback)
      return finish(
        state,
        'callback_requested',
        `${callbackReminder(task, state, now)}${phrase(state, 'callback_repeat', [`Your requested callback is ${spokenCallback(state.pendingCallback.at, task.timezone)}. Goodbye.`, `The callback time you gave is ${spokenCallback(state.pendingCallback.at, task.timezone)}. Goodbye.`])}`,
      );
    return {
      state,
      text: `${callbackReminder(task, state, now)}${callbackQuestion(state)}`,
    };
  }
  if (
    state.pendingCallback &&
    /^(?:(?:ok(?:ay)?|yes|sure|thanks|thank you|got it)[,!.\s]*)+$/i.test(
      recipient.text,
    )
  )
    return finish(
      state,
      'callback_requested',
      phrase(state, 'callback_thanks', [
        "You're welcome. Goodbye.",
        'Thank you. Goodbye.',
      ]),
    );
  const callbackContext =
    control !== 'resume' &&
    (control === 'busy' ||
      judgment.callbackRequested >= ACCEPT ||
      (state.awaitingCallbackTime &&
        judgment.paymentAddressed < 0.5 &&
        judgment.timelineAddressed < 0.5));
  if (callbackContext && judgment.offTopic < 0.7)
    return callbackOutcome(task, state, recipient, callbacks, judgment, now);
  state.pendingCallback = null;
  state.awaitingCallbackTime = false;
  if (!state.identityConfirmed)
    return { state, text: identityQuestion(task, state) };
  if (judgment.offTopic >= 0.7) {
    state.offTopicCount += 1;
    if (state.offTopicCount >= 3) return humanHandoff(state);
    return {
      state,
      text: `${phrase(state, 'off_topic', ['I can only discuss this payment with you.', "Let's stay with the payment question.", 'I can help with the payment status and timing.'])} ${paymentQuestion(state)}`,
    };
  }
  if (state.paymentStatus === 'reported_paid' && state.informationComplete) {
    return finish(
      state,
      'information_complete',
      phrase(state, 'paid_complete', [
        'Thank you. I have recorded that you report the payment is already made. Your payment has not been independently verified. Goodbye.',
        'I have noted your report of full payment. It has not been independently verified. Thank you, goodbye.',
      ]),
    );
  }
  if (state.paymentStatus === 'unpaid' && state.promisedDate) {
    const missesDeadline = state.promisedDate > task.deadline;
    if (missesDeadline && state.promisedDate > today) {
      if (state.reminders >= task.maxReminders) return humanHandoff(state);
      state.reminders += 1;
      const explanation =
        today > task.deadline
          ? overdueReminder(state)
          : phrase(state, 'late_promise', [
              `That proposed date is after the payment deadline of ${spokenDate(task.deadline)}. Please make the payment today.`,
              `That falls after the payment deadline, ${spokenDate(task.deadline)}. Can you bring the payment forward to today?`,
              `The payment deadline is ${spokenDate(task.deadline)}, before your proposed date. Payment is needed today.`,
            ]);
      return {
        state,
        text: `${explanation} ${phrase(state, 'today_commitment', [`Can you commit to paying today, ${spokenDate(today)}?`, 'Will you be able to make the full payment today?', 'Can you confirm payment today?'])}`,
      };
    }
    if (state.informationComplete) {
      const reminder = missesDeadline ? `${overdueReminder(state)} ` : '';
      return finish(
        state,
        'information_complete',
        `${reminder}${phrase(state, 'promise_complete', [`Thank you. I have recorded your commitment to pay on ${spokenDate(state.promisedDate)}. Goodbye.`, `Your commitment to pay on ${spokenDate(state.promisedDate)} is recorded. Thank you, goodbye.`])}`,
      );
    }
  }
  if (
    !previous.identityConfirmed &&
    !state.requiresPaymentRefresh &&
    !previous.paymentEvidence &&
    !previous.timelineEvidence &&
    !previous.responseCounts.introduction
  ) {
    return {
      state,
      text: `${phrase(state, 'introduction', [`I'm calling on behalf of ${task.organization} about ${amount(task)}, reference ${task.reference}, due ${spokenDate(task.deadline)}.`])} ${paymentQuestion(state)}`,
    };
  }
  if (state.requiresPaymentRefresh && today > task.deadline)
    return {
      state,
      text: `${overdueReminder(state)} ${paymentQuestion(state)}`,
    };
  return { state, text: paymentQuestion(state) };
}

function callbackOutcome(
  task: CollectionTask,
  state: CollectionState,
  recipient: TranscriptEntry,
  candidates: CallbackCandidate[],
  judgment: CollectionJudgments,
  now: Date,
): TurnOutcome {
  state.pendingCallback = null;
  state.awaitingCallbackTime = true;
  const selected =
    judgment.callbackConfidence >= ACCEPT
      ? candidates.find((candidate) => candidate.id === judgment.callbackChoice)
      : undefined;
  const validity = selected
    ? validateCallbackAt(task, selected.at, now)
    : 'invalid';
  const reminder = callbackReminder(task, state, now);
  if (selected && validity === 'valid') {
    state.pendingCallback = {
      at: selected.at,
      evidence: { text: recipient.text, at: recipient.at },
    };
    return finish(
      state,
      'callback_requested',
      `${reminder}${phrase(state, 'callback_agreed', [`I have recorded your requested callback for ${spokenCallback(selected.at, task.timezone)}. Goodbye.`, `Your callback request for ${spokenCallback(selected.at, task.timezone)} is noted. Thank you, goodbye.`, `I have noted ${spokenCallback(selected.at, task.timezone)} for the callback. Goodbye.`])}`,
    );
  }
  const explanation =
    validity === 'after_deadline'
      ? state.identityConfirmed
        ? `That is after the payment deadline. Please choose a callback no later than ${spokenDate(task.deadline)} in ${task.timezone}. `
        : `Please choose a callback no later than ${spokenDate(task.deadline)} in ${task.timezone}. `
      : validity === 'past'
        ? 'That time has already passed. '
        : '';
  return { state, text: `${reminder}${explanation}${callbackQuestion(state)}` };
}

function callbackReminder(
  task: CollectionTask,
  state: CollectionState,
  now: Date,
): string {
  const overdue =
    state.identityConfirmed &&
    state.paymentStatus !== 'reported_paid' &&
    localDate(task, now) > task.deadline;
  return overdue
    ? `${overdueReminder(state)} A callback does not extend the payment deadline. `
    : '';
}

function updatePayment(
  state: CollectionState,
  recipient: TranscriptEntry,
  judgment: CollectionJudgments,
): void {
  if (
    judgment.paymentConfidence >= ACCEPT &&
    judgment.paymentAddressed >= ACCEPT &&
    judgment.paymentStatus !== 'unknown'
  ) {
    if (state.requiresPaymentRefresh) {
      state.promisedDate = null;
      state.timelineEvidence = null;
      state.requiresPaymentRefresh = false;
    }
    const changed = state.paymentStatus !== judgment.paymentStatus;
    state.paymentStatus = judgment.paymentStatus;
    state.paymentEvidence = { text: recipient.text, at: recipient.at };
    if (changed || judgment.paymentStatus === 'reported_paid') {
      state.promisedDate = null;
      state.timelineEvidence = null;
    }
  } else if (judgment.paymentAddressed >= 0.5) {
    state.paymentStatus = 'unknown';
    state.paymentEvidence = null;
    state.promisedDate = null;
    state.timelineEvidence = null;
  }
}

function updateTimeline(
  state: CollectionState,
  recipient: TranscriptEntry,
  candidates: DateCandidate[],
  judgment: CollectionJudgments,
  today: string,
): void {
  if (state.paymentStatus !== 'unpaid') return;
  if (state.promisedDate && state.promisedDate < today) {
    state.promisedDate = null;
    state.timelineEvidence = null;
  }
  const selected = candidates.find(
    (candidate) => candidate.id === judgment.dateChoice,
  );
  if (
    selected &&
    judgment.dateConfidence >= ACCEPT &&
    judgment.timelineAddressed >= ACCEPT &&
    selected.date >= today
  ) {
    state.promisedDate = selected.date;
    state.timelineEvidence = { text: recipient.text, at: recipient.at };
  } else if (judgment.timelineAddressed >= 0.5 || selected) {
    state.promisedDate = null;
    state.timelineEvidence = null;
  }
}

function amount(task: CollectionTask): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: task.currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(task.amountMinor / 10 ** digits);
}

function finish(
  state: CollectionState,
  finishReason: FinishReason,
  text: string,
): TurnOutcome {
  if (finishReason !== 'callback_requested') {
    state.pendingCallback = null;
    state.awaitingCallbackTime = false;
  }
  return { state, text, finishReason };
}

function humanHandoff(state: CollectionState): TurnOutcome {
  return finish(
    state,
    'needs_human',
    'I have recorded what you told me. A person will need to review the next steps. I will end this call now. Goodbye.',
  );
}
