# yapper

An asynchronous voice-agent API for a bounded task: call a recipient, ask about a payment, and return a structured account of what they said. Built in TypeScript with Fastify, Twilio, Deepgram, and Jev, with a per-call switch between **ElevenLabs Eleven v3** and **MiniMax Speech 2 HD**.

`POST /v1/runs` starts work and returns immediately. Poll for the final result while the call runs. The first workflow is `payment_collection`; arbitrary freeform agent tasks are not supported in this release.

## What it does

- Asks the recipient to confirm their identity before discussing the payment.
- Determines whether they report having paid; otherwise asks for a payment date.
- Compares the promised date with the supplied deadline. A late promise triggers a request for payment today, subject to a configurable limit of one to three reminders, then human follow-up.
- Uses Jev for small structured decisions and a bounded state machine to keep the conversation on task.
- Stops for an opt-out, wrong recipient, or dispute.
- Handles interruptions during speech by canceling synthesis, clearing queued telephone audio, and tracking the sentence prefix confirmed as played.
- Responds to requests to pause, resume, repeat, or be brief, with varied replies selected without another generation round trip.
- Records agreed callback times when a recipient is busy. An external scheduler triggers the linked callback run; upcoming deadlines bound callback times, and overdue payments remain due today.
- Persists runs, transcripts, evidence, and results in SQLite so callers can retrieve them after the HTTP request finishes.

The result records **self-reported payment**, not verification against a bank or ledger. `paymentVerified` is always `false`. Conversational identity confirmation is not authentication. The API requires the caller to attest that they have permission to call and transcribe the recipient.

## Callbacks

When a recipient asks to speak later, the agent obtains an explicit callback time. While the payment deadline has not passed, that time must fall on or before the end of the deadline date in the recipient's timezone. Once the payment is overdue, the agent emphasizes that payment is already late and needed today; an agreed later callback does not extend the payment deadline.

The call ends with `finishReason: "callback_requested"` and a timestamp in `result.callback`. Your scheduler waits until that time, applies your own calling hours and attempt limits, then submits `POST /v1/runs/RUN_ID/callback` with an `Idempotency-Key`. No body is needed; an empty JSON object is also accepted. The endpoint creates one linked run and returns immediately. The new call confirms identity and current payment status again. Yapper does not schedule or repeatedly dial callbacks itself. See [the callback contract](docs/api.md#trigger-an-agreed-callback).

## Run locally

Use Node.js 24 LTS and npm. Dependencies are pinned by `package-lock.json`.

```sh
npm ci
cp .env.example .env
# Replace YAPPER_API_KEY in .env with a random secret, then load the file:
set -a
. ./.env
set +a
npm run build
npm start
```

The default mode is `simulation`. It uses a deterministic local decision engine, needs no provider keys, and does not place a telephone call. It does not evaluate Jev's language understanding or real voice quality. See [the API guide](docs/api.md) for advancing a simulated conversation and [deployment](docs/deployment.md) for enabling live calls.

Submit a task using the synthetic example:

```sh
curl -i http://127.0.0.1:3000/v1/runs \
  -H "Authorization: Bearer $YAPPER_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-payment-001' \
  --data-binary @examples/payment-collection.json
```

Use the run ID in the response to inspect progress and retrieve its result:

```sh
curl http://127.0.0.1:3000/v1/runs/RUN_ID \
  -H "Authorization: Bearer $YAPPER_API_KEY"

curl -i http://127.0.0.1:3000/v1/runs/RUN_ID/result \
  -H "Authorization: Bearer $YAPPER_API_KEY"
```

The example number and recipient are fictitious. The deadline is deliberately fixed so the example remains reproducible; choose the actual deadline and recipient timezone for your task.

## Compare speech providers

Select `voice.provider` and the corresponding provider's `voiceId` on each run:

```json
{ "voice": { "provider": "elevenlabs", "voiceId": "YOUR_ELEVENLABS_VOICE_ID" } }
```

```json
{ "voice": { "provider": "minimax", "voiceId": "YOUR_MINIMAX_VOICE_ID" } }
```

The models are fixed to `eleven_v3` and `speech-02-hd`, respectively. Voice IDs are provider-specific; the example IDs are placeholders. Use a new idempotency key for each comparison run. Model access and voice availability depend on your provider account. Both voices ultimately pass through telephone-quality audio, which limits what callers hear.

## Development and verification

```sh
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

Automated tests and simulation can verify the API, state transitions, persistence, and interruption logic. They cannot establish real carrier delivery, transcription accuracy, voice quality, or provider account access. A live call with an authorized test recipient is required to validate those integrations in your deployment. See [operations](docs/operations.md) for the acceptance procedure.

## Documentation

- [API and result contract](docs/api.md)
- [Architecture and conversation policy](docs/architecture.md)
- [Configuration and deployment](docs/deployment.md)
- [Operations, verification, and limitations](docs/operations.md)
- [Recorded test results and real subprocess exercise](docs/verification.md)

Upstream references: [Jev API](https://docs.typesafe.ai/api), [ElevenLabs text-to-speech streaming](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [MiniMax speech API](https://platform.minimax.io/docs/api-reference/speech-t2a-http), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams), and [Deepgram live transcription](https://developers.deepgram.com/docs/getting-started-with-live-streaming-audio).

MIT licensed. See [LICENSE](LICENSE).
