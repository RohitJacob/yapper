import { z } from 'zod';
import {
  CreateRunSchema,
  type FinishReason,
  type PaymentStatus,
  type RunStatus,
} from './contracts.js';

type JsonSchema = Record<string, unknown>;

const runStatuses = [
  'queued',
  'dialing',
  'in_progress',
  'completed',
  'failed',
  'canceled',
] satisfies RunStatus[];
const paymentStatuses = [
  'unknown',
  'reported_paid',
  'unpaid',
] satisfies PaymentStatus[];
const finishReasons = [
  'information_complete',
  'needs_human',
  'opt_out',
  'wrong_party',
  'disputed',
  'call_ended',
  'max_duration',
  'provider_error',
  'canceled',
  'restarted',
] satisfies FinishReason[];
const identifier = { type: 'string', format: 'uuid' };
const dateTime = { type: 'string', format: 'date-time' };
const date = { type: 'string', format: 'date' };
const count = { type: 'integer', minimum: 0 };
const runId = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Run identifier returned by POST /v1/runs.',
  schema: identifier,
};
const retryAfter = {
  description: 'Number of seconds to wait before another request.',
  schema: { type: 'integer', minimum: 1 },
  example: 2,
};
const standardErrors = {
  '401': responseReference('Unauthorized'),
  '500': responseReference('InternalError'),
};
const runErrors = { ...standardErrors, '404': responseReference('NotFound') };
const requestErrors = {
  '400': responseReference('InvalidRequest'),
  '413': responseReference('RequestTooLarge'),
  '415': responseReference('UnsupportedMediaType'),
};

export function openapiDocument() {
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Yapper',
      version: '0.1.0',
      description:
        'Queue asynchronous payment-collection calls and poll their structured results. Each run chooses ElevenLabs eleven_v3 or MiniMax speech-02-hd. Reported payments are recipient statements, never verified ledger payments. Simulation routes are registered only when YAPPER_MODE=simulation.',
    },
    security: [{ bearerAuth: [] }],
    tags: [
      {
        name: 'Runs',
        description: 'Authenticated call lifecycle and results.',
      },
      {
        name: 'Simulation',
        description:
          'Local transcript-driven execution without placing calls. These routes return 404 in live mode.',
      },
      { name: 'Service', description: 'Public health and API documentation.' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'The YAPPER_API_KEY configured on the server.',
        },
      },
      schemas: responseSchemas(),
      responses: {
        Unauthorized: jsonResponse(
          'Error',
          'Missing or invalid bearer API key.',
        ),
        NotFound: jsonResponse(
          'Error',
          'Run does not exist, or this simulation route is unavailable in live mode.',
        ),
        InvalidRequest: jsonResponse(
          'Error',
          'Invalid JSON, request fields, or Idempotency-Key. Schema validation errors include issues with field paths.',
        ),
        Conflict: jsonResponse(
          'Error',
          'The idempotency key was used with different details, the destination is suppressed, or the requested turn conflicts with the run state.',
        ),
        RequestTooLarge: jsonResponse(
          'Error',
          'Request body exceeds the 32,768-byte limit.',
        ),
        UnsupportedMediaType: jsonResponse(
          'Error',
          'Unsupported request media type; use application/json.',
        ),
        InternalError: jsonResponse(
          'Error',
          'Unexpected server error. No provider credentials or internal error details are returned.',
        ),
      },
    },
    paths: {
      '/healthz': {
        get: {
          operationId: 'getHealth',
          tags: ['Service'],
          security: [],
          summary: 'Read process health and operating mode',
          description:
            'Confirms the HTTP process is responding. This does not test external provider connectivity.',
          responses: {
            '200': jsonResponse('Health', 'Process is responding.'),
          },
        },
      },
      '/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          tags: ['Service'],
          security: [],
          summary: 'Read this OpenAPI document',
          responses: {
            '200': {
              description: 'OpenAPI 3.1 document.',
              content: jsonContent({
                type: 'object',
                required: ['openapi', 'info', 'paths'],
                additionalProperties: true,
              }),
            },
          },
        },
      },
      '/v1/runs': {
        post: {
          operationId: 'createRun',
          tags: ['Runs'],
          summary: 'Queue one call',
          description:
            'Returns immediately after persisting the run. Reuse the same Idempotency-Key and details to retrieve the existing run without another call; an idempotent replay can describe an already terminal run. Poll statusUrl or resultUrl for progress. Live mode requires an allowlisted destination and a configured key for the selected speech provider.',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description:
                'Unique request key. Reusing a key with different normalized request details returns 409.',
              schema: {
                type: 'string',
                minLength: 8,
                maxLength: 128,
                pattern: '^[a-zA-Z0-9._:-]+$',
              },
            },
          ],
          requestBody: {
            required: true,
            content: jsonContent(schemaReference('CreateRun')),
          },
          responses: {
            ...standardErrors,
            ...requestErrors,
            '202': {
              ...jsonResponse(
                'AcceptedRun',
                'Run accepted or idempotent replay.',
              ),
              headers: {
                Location: {
                  description: 'Relative URI for the run resource.',
                  schema: { type: 'string', format: 'uri-reference' },
                },
              },
            },
            '403': jsonResponse(
              'Error',
              'Live destination is not in ALLOWED_NUMBERS.',
            ),
            '409': responseReference('Conflict'),
            '429': {
              ...jsonResponse(
                'Error',
                'More than 30 create requests per client IP within one minute.',
              ),
              headers: { 'Retry-After': retryAfter },
            },
            '503': jsonResponse(
              'Error',
              'Queue is full or the selected speech provider is not configured.',
            ),
          },
        },
      },
      '/v1/runs/{id}': {
        get: {
          operationId: 'getRun',
          tags: ['Runs'],
          summary: 'Read status, transcript, state and result',
          parameters: [runId],
          description:
            'Includes generated agent text and finalized recipient transcripts. An interrupted agent entry may not have been fully heard by the recipient.',
          responses: {
            ...runErrors,
            '200': jsonResponse('Run', 'Current durable run snapshot.'),
          },
        },
      },
      '/v1/runs/{id}/result': {
        get: {
          operationId: 'getRunResult',
          tags: ['Runs'],
          summary: 'Poll the final contract',
          parameters: [runId],
          responses: {
            ...runErrors,
            '200': jsonResponse(
              'TerminalRunResult',
              'Terminal outcome, including completed, failed and canceled runs. Inspect result.finishReason, result.needsHuman and error.',
            ),
            '202': {
              ...jsonResponse(
                'PendingRunResult',
                'Call has not reached a terminal state. Poll again after Retry-After seconds.',
              ),
              headers: {
                'Retry-After': {
                  ...retryAfter,
                  schema: { type: 'integer', const: 2 },
                },
              },
            },
          },
        },
      },
      '/v1/runs/{id}/cancel': {
        post: {
          operationId: 'cancelRun',
          tags: ['Runs'],
          summary: 'Cancel a queued or active call',
          parameters: [runId],
          description:
            'Persists cancellation and attempts to hang up an active call. Calling this on a terminal run returns that run unchanged. If hangup cannot be confirmed, the returned run records an error and requires human review.',
          responses: {
            ...runErrors,
            '200': jsonResponse(
              'Run',
              'Current run after the cancellation request.',
            ),
          },
        },
      },
      '/v1/runs/{id}/turns': {
        post: {
          operationId: 'submitSimulationTurn',
          tags: ['Simulation'],
          summary: 'Simulation only: submit recipient speech',
          parameters: [runId],
          description:
            'Wait until the worker starts the run, then submit one recipient utterance. This route runs the deterministic simulation decision engine and returns the updated transcript and state. Only one turn can be processed per run at a time; inactive runs return 409. This route does not exist in live mode.',
          requestBody: {
            required: true,
            content: jsonContent(schemaReference('SimulationTurn')),
          },
          responses: {
            ...runErrors,
            ...requestErrors,
            '200': jsonResponse(
              'Run',
              'Updated run after processing the utterance.',
            ),
            '409': responseReference('Conflict'),
          },
        },
      },
      '/v1/runs/{id}/end': {
        post: {
          operationId: 'endSimulationRun',
          tags: ['Simulation'],
          summary: 'Simulation only: hang up',
          parameters: [runId],
          description:
            'Completes an unfinished simulation with finishReason=call_ended, preserving collected facts. A terminal run is returned unchanged. This route does not exist in live mode.',
          responses: {
            ...runErrors,
            '200': jsonResponse('Run', 'Current run after simulated hangup.'),
          },
        },
      },
    },
  };
}

function responseSchemas(): Record<string, JsonSchema> {
  return {
    CreateRun: z.toJSONSchema(CreateRunSchema),
    RunStatus: { type: 'string', enum: runStatuses },
    PaymentStatus: {
      type: 'string',
      enum: paymentStatuses,
      description:
        'reported_paid is an unverified recipient report. unpaid indicates the recipient reports an outstanding payment. unknown means no sufficiently clear current status.',
    },
    FinishReason: { type: 'string', enum: finishReasons },
    Evidence: objectSchema({
      text: {
        type: 'string',
        description: 'Recipient statement supporting the captured fact.',
      },
      at: dateTime,
    }),
    TranscriptEntry: objectSchema(
      {
        role: { type: 'string', enum: ['agent', 'recipient'] },
        text: { type: 'string' },
        at: dateTime,
        interrupted: {
          type: 'boolean',
          description:
            'When true, agent speech was interrupted and may not have been fully played.',
        },
      },
      ['role', 'text', 'at'],
    ),
    CollectionState: objectSchema({
      identityConfirmed: { type: 'boolean' },
      paymentStatus: schemaReference('PaymentStatus'),
      promisedDate: nullable(date),
      paymentEvidence: nullable(schemaReference('Evidence')),
      timelineEvidence: nullable(schemaReference('Evidence')),
      reminders: count,
      turns: count,
      offTopicCount: count,
      informationComplete: { type: 'boolean' },
      lastDecision: nullable({
        type: 'object',
        additionalProperties: true,
        description:
          'Most recent decision metadata. Model-specific fields may change; rely on the typed state and result for application logic.',
      }),
    }),
    RunResult: objectSchema({
      schemaVersion: { type: 'integer', const: 1 },
      paymentStatus: schemaReference('PaymentStatus'),
      paymentVerified: {
        type: 'boolean',
        const: false,
        description:
          'Always false. Yapper does not verify payment against a ledger or payment processor.',
      },
      promisedDate: nullable(date),
      exceedsDeadline: nullable({
        type: 'boolean',
        description:
          'Whether promisedDate is later than deadline. Null when no payment date is known.',
      }),
      deadline: date,
      informationComplete: { type: 'boolean' },
      needsHuman: { type: 'boolean' },
      finishReason: schemaReference('FinishReason'),
      paymentEvidence: nullable(schemaReference('Evidence')),
      timelineEvidence: nullable(schemaReference('Evidence')),
      reminders: count,
    }),
    Run: objectSchema({
      id: identifier,
      status: schemaReference('RunStatus'),
      request: schemaReference('CreateRun'),
      createdAt: dateTime,
      startedAt: nullable(dateTime),
      updatedAt: dateTime,
      callSid: nullable({
        type: 'string',
        pattern: '^CA[0-9a-fA-F]{32}$',
        description:
          'Twilio call identifier, or null before association and for simulation runs.',
      }),
      state: schemaReference('CollectionState'),
      transcript: { type: 'array', items: schemaReference('TranscriptEntry') },
      result: nullable(schemaReference('RunResult')),
      error: nullable({ type: 'string' }),
    }),
    AcceptedRun: objectSchema({
      id: identifier,
      status: schemaReference('RunStatus'),
      statusUrl: { type: 'string', format: 'uri-reference' },
      resultUrl: { type: 'string', format: 'uri-reference' },
    }),
    PendingRunResult: objectSchema({
      id: identifier,
      status: {
        type: 'string',
        enum: ['queued', 'dialing', 'in_progress'] satisfies RunStatus[],
      },
    }),
    TerminalRunResult: objectSchema({
      id: identifier,
      status: {
        type: 'string',
        enum: ['completed', 'failed', 'canceled'] satisfies RunStatus[],
      },
      result: nullable(schemaReference('RunResult')),
      error: nullable({ type: 'string' }),
    }),
    SimulationTurn: objectSchema({
      text: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description:
          'Nonblank recipient utterance; surrounding whitespace is trimmed.',
      },
    }),
    Health: objectSchema({
      status: { type: 'string', const: 'ok' },
      mode: { type: 'string', enum: ['simulation', 'live'] },
    }),
    ValidationIssue: objectSchema({
      path: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      message: { type: 'string' },
    }),
    Error: objectSchema(
      {
        error: { type: 'string' },
        issues: { type: 'array', items: schemaReference('ValidationIssue') },
        message: {
          type: 'string',
          description:
            'Present on framework-generated route-not-found responses.',
        },
        statusCode: {
          type: 'integer',
          minimum: 400,
          maximum: 599,
          description:
            'Present on framework-generated route-not-found responses.',
        },
      },
      ['error'],
    ),
  };
}

function schemaReference(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function responseReference(name: string): { $ref: string } {
  return { $ref: `#/components/responses/${name}` };
}

function jsonContent(schema: JsonSchema) {
  return { 'application/json': { schema } };
}

function jsonResponse(schema: string, description: string) {
  return { description, content: jsonContent(schemaReference(schema)) };
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

function objectSchema(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}
