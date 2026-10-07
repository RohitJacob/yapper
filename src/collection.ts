import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
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
  };
}

export function opening(task: CollectionTask): string {
  return `Hello. I'm an AI voice assistant, and this call is transcribed. Am I speaking with ${task.recipientName}?`;
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
    needsHuman: reason !== 'information_complete',
    finishReason: reason,
    paymentEvidence: state.paymentEvidence,
    timelineEvidence: state.timelineEvidence,
    reminders: state.reminders,
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
): TurnOutcome {
  const state: CollectionState = {
    ...previous,
    turns: previous.turns + 1,
    informationComplete: false,
    lastDecision: judgment.raw,
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
  if (!state.identityConfirmed) {
    state.identityConfirmed = judgment.identity >= ACCEPT;
    if (!state.identityConfirmed) {
      return {
        state,
        text: `Before I discuss the reason for calling, please confirm: are you ${task.recipientName}?`,
      };
    }
  }
  if (judgment.offTopic >= 0.7) {
    state.offTopicCount += 1;
    if (state.offTopicCount >= 3) return humanHandoff(state);
    return {
      state,
      text: `I can only discuss this payment with you. ${paymentQuestion(state)}`,
    };
  }
  updatePayment(state, recipient, judgment);
  const today = localDate(task, now);
  updateTimeline(state, recipient, candidates, judgment, today);
  state.informationComplete =
    judgment.complete >= ACCEPT &&
    (state.paymentStatus === 'reported_paid' ||
      (state.paymentStatus === 'unpaid' && state.promisedDate !== null));
  if (state.paymentStatus === 'reported_paid' && state.informationComplete) {
    return finish(
      state,
      'information_complete',
      'Thank you. I have recorded that you report the payment is already made. Your payment has not been independently verified. Goodbye.',
    );
  }
  if (state.paymentStatus === 'unpaid' && state.promisedDate) {
    const missesDeadline = state.promisedDate > task.deadline;
    if (missesDeadline && state.promisedDate > today) {
      if (state.reminders >= task.maxReminders) return humanHandoff(state);
      state.reminders += 1;
      const explanation =
        today > task.deadline
          ? "We're already late. The payment needs to be made today."
          : `That proposed date is after the payment deadline of ${spokenDate(task.deadline)}. Please make the payment today.`;
      return {
        state,
        text: `${explanation} Can you commit to paying today, ${spokenDate(today)}?`,
      };
    }
    if (state.informationComplete) {
      const reminder = missesDeadline
        ? "We're already late. The payment needs to be made today. "
        : '';
      return finish(
        state,
        'information_complete',
        `${reminder}Thank you. I have recorded your commitment to pay on ${spokenDate(state.promisedDate)}. Goodbye.`,
      );
    }
  }
  if (!previous.identityConfirmed) {
    return {
      state,
      text: `I'm calling on behalf of ${task.organization} about ${amount(task)}, reference ${task.reference}, due ${spokenDate(task.deadline)}. ${paymentQuestion(state)}`,
    };
  }
  return { state, text: paymentQuestion(state) };
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

function spokenDate(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' })
    .setLocale('en-US')
    .toFormat('MMMM d, yyyy');
}

function paymentQuestion(state: CollectionState): string {
  if (state.paymentStatus === 'unpaid')
    return 'What exact date can you commit to making the payment?';
  if (state.paymentStatus === 'reported_paid')
    return 'To confirm, are you saying you have already made this payment in full?';
  return 'Have you already made this payment in full? If not, what exact date can you commit to paying?';
}

function finish(
  state: CollectionState,
  finishReason: FinishReason,
  text: string,
): TurnOutcome {
  return { state, text, finishReason };
}

function humanHandoff(state: CollectionState): TurnOutcome {
  return finish(
    state,
    'needs_human',
    'I have recorded what you told me. A person will need to review the next steps. I will end this call now. Goodbye.',
  );
}
