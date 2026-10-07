import { DateTime } from 'luxon';
import type { CollectionState, CollectionTask } from './contracts.js';

export function phrase(
  state: CollectionState,
  purpose: string,
  variants: readonly string[],
): string {
  const count = state.responseCounts[purpose] ?? 0;
  state.responseCounts[purpose] = count + 1;
  return variants[count % variants.length] ?? '';
}

export function paymentQuestion(state: CollectionState): string {
  if (state.requiresPaymentRefresh)
    return phrase(state, 'payment_refresh', [
      'Since our last call, has the payment been made in full? If not, what date can you commit to now?',
      'Has the payment status changed since we last spoke? If it is still unpaid, what is your current payment date?',
      'Please confirm the current status: paid in full, or still outstanding with what payment date?',
    ]);
  if (state.paymentStatus === 'unpaid')
    return phrase(
      state,
      'payment_date',
      state.concise
        ? [
            'What exact date will you pay?',
            'Which date can you commit to?',
            'When will you make the payment?',
          ]
        : [
            'What exact date can you commit to making the payment?',
            'Which date will you be able to make the full payment?',
            'Please give me the specific date you can commit to paying.',
          ],
    );
  if (state.paymentStatus === 'reported_paid')
    return phrase(state, 'payment_confirm', [
      'To confirm, are you saying you have already made this payment in full?',
      'Has the full payment already gone through?',
      'Are you confirming that the whole amount has been paid?',
    ]);
  return phrase(
    state,
    'payment_status',
    state.concise
      ? [
          'Has the full payment been made?',
          'Is this paid in full?',
          'Have you paid the full amount?',
        ]
      : [
          'Have you already made this payment in full? If not, what exact date can you commit to paying?',
          'Is the full amount paid already, or can you give me a specific payment date?',
          'Please confirm whether you have paid in full. If it is still unpaid, which date can you commit to?',
        ],
  );
}

export function overdueReminder(state: CollectionState): string {
  return phrase(state, 'overdue', [
    "We're already late. The payment needs to be made today.",
    'The payment is already overdue, so it needs to be made today.',
    "We're past the payment deadline. Payment is needed today.",
  ]);
}

export function identityQuestion(
  task: CollectionTask,
  state: CollectionState,
): string {
  return phrase(state, 'identity', [
    `Before I discuss the reason for calling, please confirm: are you ${task.recipientName}?`,
    `Am I speaking with ${task.recipientName}?`,
    `Could you confirm that you are ${task.recipientName}?`,
  ]);
}

export function callbackQuestion(state: CollectionState): string {
  return phrase(
    state,
    'callback_time',
    state.concise
      ? [
          'What date and time should we call?',
          'Which exact callback date and time?',
          'When can you take the callback?',
        ]
      : [
          'What exact date and time would work for a callback?',
          'When should we call back? Please give a specific date and time.',
          'Which date and time can you take the callback?',
        ],
  );
}

export function spokenDate(date: string): string {
  return DateTime.fromISO(date, { zone: 'UTC' })
    .setLocale('en-US')
    .toFormat('MMMM d, yyyy');
}

export function spokenCallback(at: string, timezone: string): string {
  return `${DateTime.fromISO(at, { zone: timezone }).setLocale('en-US').toFormat('MMMM d, yyyy, h:mm a')} ${timezone}`;
}
