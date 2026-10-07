# Architecture and conversation policy

Yapper is one long-running Node.js process. Fastify serves the API and Twilio integrations. SQLite stores requests, run state, transcript entries, idempotency records, and results on persistent disk. A worker limits concurrent calls and advances queued runs independently of the original HTTP request.

```mermaid
flowchart LR
  Client -->|POST task| API[Fastify API]
  API --> DB[(SQLite)]
  Worker[Run worker] --> DB
  Worker -->|Dial| Twilio
  Twilio <-->|Bidirectional media| Session[Call session]
  Session -->|Inbound audio| Deepgram
  Deepgram -->|Recipient speech| Policy[Conversation controller]
  Policy <-->|Structured decisions| Jev
  Policy --> TTS[Eleven v3 or Speech 2 HD]
  TTS -->|Telephone audio| Session
  Policy --> DB
  Client -->|Poll result| API
  Client -->|At agreed time: POST callback| API
```

## Separate conversation policy from speech

The request selects a speech provider. It does not change the payment-collection policy or grant the recipient authority to change the task. Jev interprets the recipient's answers into structured decisions; application code controls allowed state transitions, response selection, stop conditions, and reminder limits. This keeps the task narrow and makes both providers comparable using the same workflow.

The collection state stores identity confirmation, payment status, promised date, evidence, reminder count, turn count, completion status, response history, conversation controls, and a pending callback request. The workflow asks for identity first, then payment status, then a payment date when necessary. The submitted organization's name, amount, reference, and deadline are the task's source of truth. Recipient requests to change instructions do not redefine them.

The deadline is a date in the task's timezone. A late promised date prompts a request to pay today. The reminder counter caps repetition; failure to obtain an acceptable resolution produces a human-follow-up outcome. This is intentionally bounded: the agent does not negotiate new terms, collect card or bank details, or keep pressuring a recipient indefinitely. Callback scheduling and limits belong to the integrating application.

An opt-out, wrong recipient, or dispute ends the collection conversation. Opted-out numbers are persisted in a suppression list to prevent subsequent calls. Twilio answering-machine detection must identify a human before the service opens a conversation; other outcomes end for human review without leaving a payment message. Conversational confirmation alone is not suitable for disclosing highly sensitive account information.

## Interruption handling

The live stream delivers inbound telephone audio to Deepgram. Speech-start events interrupt the current response immediately. The session aborts outstanding synthesis and sends Twilio a `clear` message to discard queued outbound audio. Subsequent final transcripts advance the controller. Generation counters discard stale audio and decisions. Recipient segments received since the last committed decision are combined for the next judgment so interrupting a slow decision does not lose previously spoken facts. An opt-out or other mandatory stop remains in effect if the goodbye is interrupted.

Output is split into sentences, with at most the current sentence and one prefetched sentence queued. Each sent sentence has a Twilio playback mark. The session advances `deliveredText` only on an acknowledgment for the active generation, keeping a confirmed sentence prefix separate from the response's full `text`. Clearing playback invalidates the outstanding marks, including the marks Twilio returns for cleared audio. A partial sentence is conservatively left out of the confirmed prefix. Transcript `delivery` moves through `pending`, `playing`, `played`, or `interrupted`. A final goodbye closes the conversation only after the final matching playback mark. The recipient can interrupt a callback goodbye to revise or withdraw the request; a disconnect preserves any still-valid agreed callback.

The controller recognizes pause, resume, repeat, and brief-response requests. Its response history selects deterministic variants and supports concise replies without a second generative round trip. These controls preserve the original task and mandatory stop conditions. Repetition is intentional when requested; an ordinary interruption allows the next answer to respond to the new recipient input rather than blindly replaying the canceled output.

Telephone media is mono, 8 kHz μ-law. Both providers are requested in this compatible format before being streamed to Twilio. This transport limits fidelity regardless of the selected TTS model. Network latency, transcription endpointing, and provider time to first audio all affect the perceived conversation delay.

The transcript captures generated agent responses and recognized recipient speech. An interrupted agent entry is marked when applicable. Neither generated text nor carrier playback acknowledgment proves the recipient heard or understood it.

## Callback handoff

A busy recipient can request another time. The controller obtains a specific future instant and stores the recipient's supporting words. While the deadline has not passed, callback times must be on or before the local end of that deadline date. Once overdue, the response emphasizes that payment is already late and needed today, while allowing an agreed future callback. A callback does not extend the deadline and is not a payment promise.

The terminal result uses `finishReason: callback_requested` and `result.callback` with its timestamp, timezone, evidence, and deadline status. When there is no unresolved call error, this is an actionable scheduler handoff with `needsHuman: false`; `informationComplete` separately reports whether the payment questions have been answered. The scheduler checks both `error` and `needsHuman` before triggering the next call. The service has no callback timer. An external orchestrator applies calling hours and attempt limits, waits until the agreed time, then submits the authenticated, idempotent `POST /v1/runs/:id/callback` request.

The endpoint rejects early requests and creates at most one child per parent in a database transaction. It also rejects a parent with an unresolved error or a carrier call that has not been confirmed ended (`callEndedAt`), preventing overlapping calls when hangup is uncertain. It persists `callbackRunId` on the parent and `parentRunId`/`rootRunId` on the child, allowing a client to follow the chain. The normal worker queues and starts the child. Suppression and mandatory stop outcomes prevent callbacks. The child retains payment facts and response history for context, but has a fresh transcript, resets identity confirmation, and sets `requiresPaymentRefresh` so earlier answers cannot complete the new call without reconfirmation. The opening asks for identity before disclosing payment details.

## Asynchronous lifecycle and durability

Accepted tasks are persisted before the API acknowledges them. Idempotency prevents a client retry from creating a second run. The worker moves runs from `queued` through `dialing` and `in_progress` into a terminal status. Terminal runs are not automatically restarted or redialed. An externally triggered callback is a new linked run; the original completed run remains available. Stored older runs receive defaults for the additive callback, control, and linkage fields when read.

SQLite makes this a **single-instance service**. Run one application process against one local persistent database. Do not horizontally scale replicas against the same file or place the database on a network filesystem. Back up the database using a SQLite-aware mechanism.

An in-flight telephone conversation cannot be reconstructed safely after process loss. Recovery must preserve what is known and surface interrupted work for human review rather than automatically redialing a recipient. See [operations](operations.md) for restart handling and reconciliation.

## Boundaries

- Yapper records statements; it has no bank, invoice, or ledger access.
- The workflow is specialized for payment collection. A new task type needs its own schema, policy, result contract, and tests.
- There is no arbitrary callback URL or outbound result webhook. Clients poll the API.
- Raw call audio is not the result contract. Configure provider-side recording and retention separately if your use case requires them.
- A live deployment sends recipient data to the configured telephone, transcription, decision, and speech providers. Protect the SQLite volume and limit access to the API.
