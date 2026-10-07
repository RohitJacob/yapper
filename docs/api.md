# API and result contract

Yapper accepts a task, runs an asynchronous conversation, and makes the recorded outcome available by polling. Public API requests require `Authorization: Bearer <YAPPER_API_KEY>`. Send JSON with `Content-Type: application/json`. Run identifiers are opaque; obtain them from the API rather than constructing them.

## Create a run

`POST /v1/runs` requires an `Idempotency-Key` header. A successful submission returns `202 Accepted` and a `Location` header pointing to the run. Repeating the same key with the same payload retrieves the same run; reusing a key for different input is a conflict. Keep the key stable when retrying a submission whose network response was lost.

Keys contain 8–128 letters, digits, periods, underscores, colons, or hyphens. New-run requests are rate-limited to 30 per minute per client IP; the queue holds at most 1,000 pending runs. Live destinations must be in the configured allowlist, and the selected speech provider must have a configured credential.

The response contains `id`, `status`, `statusUrl`, and `resultUrl`:

```json
{
  "id": "RUN_ID",
  "status": "queued",
  "statusUrl": "/v1/runs/RUN_ID",
  "resultUrl": "/v1/runs/RUN_ID/result"
}
```

Request body:

```json
{
  "to": "+15555550123",
  "voice": {
    "provider": "elevenlabs",
    "voiceId": "YOUR_ELEVENLABS_VOICE_ID"
  },
  "task": {
    "type": "payment_collection",
    "recipientName": "Alex Example",
    "organization": "Example Services",
    "amountMinor": 25000,
    "currency": "USD",
    "reference": "INV-EXAMPLE-001",
    "deadline": "2026-10-01",
    "timezone": "America/Los_Angeles",
    "maxReminders": 2
  },
  "authorization": {
    "consentToCall": true,
    "consentToTranscribe": true
  },
  "maxDurationSeconds": 600
}
```

Both authorization fields must be explicitly `true`; they are attestations from the API caller. They do not prove consent and do not replace your own record of authorization.

`to` must use E.164 notation. Text fields are trimmed and limited to 200 characters. `currency` is a three-letter uppercase code. `amountMinor` is a positive integer in the currency's minor units, not a floating-point major-unit amount; `25000` means USD 250.00. The maximum is 100,000,000,000 minor units. Use a currency that the runtime recognizes for formatting.

`deadline` is a calendar date (`YYYY-MM-DD`) in the task's IANA `timezone`. `maxReminders` is 1–3 and defaults to 2. `maxDurationSeconds` is 30–1800 and defaults to 600. Unknown object properties are rejected. `voiceId` accepts 1–100 letters, digits, underscores, or hyphens.

For payment promises, the agent asks for an explicit day when given an ambiguous date or a week, month, or year expression, including "in one week." A bare "yes" to a suggested date is not recorded as a dated commitment; the recipient must state the date. This favors a clear evidence trail over silently inferring an agreement.

## Inspect progress

`GET /v1/runs/:id` returns the stored run, including its request, timestamps, state, transcript, optional carrier call ID, error, and terminal result. Treat these responses as sensitive: the original request and transcript can contain financial and personal information.

Statuses are `queued`, `dialing`, `in_progress`, `completed`, `failed`, and `canceled`. A completed conversation does not mean the debt was paid. Read `result` to determine the outcome.

`GET /v1/runs/:id/result` returns `202 Accepted` with `{ "id": "...", "status": "..." }` and `Retry-After: 2` while the run is pending. Once terminal, it returns `200 OK` with `{ "id": "...", "status": "...", "result": { ... }, "error": null }`. A failed run can include an error string. Follow `Retry-After` and use bounded backoff when polling. There is no result webhook or event-stream API in this release.

## Interpret the result

The versioned result contract contains:

- `schemaVersion`: currently `1`.
- `paymentStatus`: `unknown`, `reported_paid`, or `unpaid`.
- `paymentVerified`: always `false`; no ledger integration exists.
- `promisedDate`: a normalized `YYYY-MM-DD` date, or `null` when no reliable date was obtained.
- `exceedsDeadline`: whether the promised date is later than the task deadline, or `null` without a date.
- `deadline`: the original task deadline.
- `informationComplete`: whether the required answers were collected. This does not imply that the requested deadline was accepted or payment verified.
- `needsHuman`: whether a person should review or follow up.
- `finishReason`: why the conversation stopped.
- `paymentEvidence` and `timelineEvidence`: the recipient's relevant words and timestamps, or `null`.
- `reminders`: the number of late-payment reminders issued.

Possible finish reasons are `information_complete`, `needs_human`, `opt_out`, `wrong_party`, `disputed`, `call_ended`, `max_duration`, `provider_error`, `canceled`, and `restarted`.

For example, a report of payment can produce this `result` object inside the terminal response:

```json
{
  "schemaVersion": 1,
  "paymentStatus": "reported_paid",
  "paymentVerified": false,
  "promisedDate": null,
  "exceedsDeadline": null,
  "deadline": "2026-10-01",
  "informationComplete": true,
  "needsHuman": false,
  "finishReason": "information_complete",
  "paymentEvidence": {
    "text": "I already paid the full amount yesterday.",
    "at": "2026-10-06T16:01:00.000Z"
  },
  "timelineEvidence": null,
  "reminders": 0
}
```

## Cancel

`POST /v1/runs/:id/cancel` requests cancellation and returns the run. In live mode this also attempts to terminate the carrier call. Cancellation cannot retract speech already heard or external charges already incurred.

## Simulation

Simulation uses a deterministic local decision engine and the same run and result endpoints without provider credentials or dialing a number. After creating a run, submit the recipient's next utterance:

```sh
curl -X POST http://127.0.0.1:3000/v1/runs/RUN_ID/turns \
  -H "Authorization: Bearer $YAPPER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"text":"Yes, this is Alex Example."}'

curl -X POST http://127.0.0.1:3000/v1/runs/RUN_ID/turns \
  -H "Authorization: Bearer $YAPPER_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"text":"I already paid the full amount yesterday."}'
```

Each turn returns the updated run, including the generated reply in `transcript`. A terminal or inactive run rejects further turns with `409 Conflict`. `POST /v1/runs/:id/end` simulates the recipient hanging up. The turn and end endpoints are only available in simulation mode. A transcript describes conversation content; it is not a recording or proof that the recipient heard every generated word.

## Service endpoints and errors

`GET /healthz` is the liveness endpoint and returns `{ "status": "ok", "mode": "simulation" }` (or `"live"`). `GET /openapi.json` describes the HTTP contract. Carrier callbacks and the media stream are internal integration endpoints, authenticated using Twilio's request signature rather than the API bearer key.

Invalid input, missing authentication, unknown IDs, conflicting idempotency keys, and invalid state transitions return non-success HTTP responses. Preserve the status code and response body in client diagnostics, but redact the bearer key and sensitive task details. Never automatically submit a new run with a new key merely because a request timed out; first retry the original idempotent request.
