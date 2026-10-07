import { z } from 'zod';

const text = z.string().trim().min(1).max(200);
const date = z.iso.date();
export const TaskSchema = z
  .object({
    type: z.literal('payment_collection'),
    recipientName: text,
    organization: text,
    amountMinor: z.number().int().positive().max(100_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: text,
    deadline: date,
    timezone: z.string().refine(isTimezone, 'Use an IANA timezone'),
    maxReminders: z.number().int().min(1).max(3).default(2),
  })
  .strict();

export const CreateRunSchema = z
  .object({
    to: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Use an E.164 phone number'),
    voice: z
      .object({
        provider: z.enum(['elevenlabs', 'minimax']),
        voiceId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
      })
      .strict(),
    task: TaskSchema,
    authorization: z
      .object({
        consentToCall: z.literal(true),
        consentToTranscribe: z.literal(true),
      })
      .strict(),
    maxDurationSeconds: z.number().int().min(30).max(1800).default(600),
  })
  .strict();

export type CollectionTask = z.infer<typeof TaskSchema>;
export type CreateRun = z.infer<typeof CreateRunSchema>;
export type RunStatus =
  'queued' | 'dialing' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type PaymentStatus = 'unknown' | 'reported_paid' | 'unpaid';
export type FinishReason =
  | 'information_complete'
  | 'needs_human'
  | 'opt_out'
  | 'wrong_party'
  | 'disputed'
  | 'call_ended'
  | 'max_duration'
  | 'provider_error'
  | 'canceled'
  | 'restarted';
export interface TranscriptEntry {
  role: 'agent' | 'recipient';
  text: string;
  at: string;
  interrupted?: boolean;
}
export interface Evidence {
  text: string;
  at: string;
}
export interface CollectionState {
  identityConfirmed: boolean;
  paymentStatus: PaymentStatus;
  promisedDate: string | null;
  paymentEvidence: Evidence | null;
  timelineEvidence: Evidence | null;
  reminders: number;
  turns: number;
  offTopicCount: number;
  informationComplete: boolean;
  lastDecision: Record<string, unknown> | null;
}
export interface RunResult {
  schemaVersion: 1;
  paymentStatus: PaymentStatus;
  paymentVerified: false;
  promisedDate: string | null;
  exceedsDeadline: boolean | null;
  deadline: string;
  informationComplete: boolean;
  needsHuman: boolean;
  finishReason: FinishReason;
  paymentEvidence: Evidence | null;
  timelineEvidence: Evidence | null;
  reminders: number;
}
export interface Run {
  id: string;
  status: RunStatus;
  request: CreateRun;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  callSid: string | null;
  state: CollectionState;
  transcript: TranscriptEntry[];
  result: RunResult | null;
  error: string | null;
}
export interface TurnOutcome {
  state: CollectionState;
  text: string;
  finishReason?: FinishReason;
}
export interface DecisionEngine {
  respond(
    task: CollectionTask,
    state: CollectionState,
    transcript: TranscriptEntry[],
    now: Date,
    signal?: AbortSignal,
  ): Promise<TurnOutcome>;
}
export interface SpeechProvider {
  synthesize(
    text: string,
    voiceId: string,
    signal: AbortSignal,
  ): AsyncIterable<Buffer>;
}
export interface Transcriber {
  send(audio: Buffer): void;
  close(): void;
}
export interface TranscriptionCallbacks {
  onSpeechStarted(): void;
  onTranscript(text: string): void;
  onError(error: Error): void;
}
export function isTimezone(value: string): boolean {
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
