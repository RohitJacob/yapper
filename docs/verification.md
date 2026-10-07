# Verification record

Validated on October 6, 2026 (America/Los_Angeles), using Node.js 24.21.0.

## Automated checks

- `npm run check`: passed strict TypeScript checks across source and tests.
- `npm run lint`: passed.
- `npm run format:check`: passed.
- `npm test`: 77 tests passed, zero failed.
- `npm run build`: passed; compiled production entry point produced in `dist/cli.js`.
- `npm audit --omit=dev`: zero known vulnerabilities reported at validation time.

The tests use real local HTTP servers, WebSocket connections, and temporary SQLite databases. External telephony and model responses are controlled at their network boundaries. Coverage includes exact speech model identifiers and audio formats, fragmented streaming responses, provider cancellation, transcript aggregation, evidence-grounded payment/date decisions, timezones and DST, opt-outs, authentication and carrier signatures, durable idempotency, restart recovery, concurrency, cancellation races, and interruption of both synthesis and in-flight decisions. A shutdown regression verifies that a delayed failed hangup is persisted before closing the database.

The interruption and callback tests additionally cover sentence playback acknowledgments, bounded queued speech, retaining only the acknowledged spoken prefix, stale playback marks, callback revisions and withdrawal during goodbye, silence while paused, payment answers combined with pause requests, varied and concise responses, independent payment/callback dates, deadline negotiation, precise callback instants across DST, external triggering, linked follow-up history, fresh payment evidence, and duplicate callback keys. WebSocket provider tests synchronize on network events rather than assuming fixed handshake timings.

## Separate production-entry-point exercise

An uncommitted script outside the repository launched the compiled server as a real subprocess with a temporary database. It sent requests through the public HTTP API and printed actual conversation responses, result JSON, process exit codes, and SQLite rows. It did not import application handlers or replace the simulation engine.

The script verified:

1. Submitting a run returns HTTP 202 and a pending result without waiting for the conversation.
2. Reusing its idempotency key returns the same run ID.
3. An ElevenLabs-selected simulation records an already-paid report as `reported_paid`, with the recipient's exact statement and `paymentVerified: false`.
4. A MiniMax-selected simulation with an overdue deadline and a promise to pay tomorrow asks for payment today. A subsequent commitment to today produces an unpaid result with the correct local date and `exceedsDeadline: true`.
5. An opt-out terminates the run and rejects a new call to that number with HTTP 409, including after restart.
6. The process shuts down cleanly with exit code 0. An interrupted active run becomes `failed` with `finishReason: restarted`.
7. Restarting against the same real database retains the completed result byte-for-byte at the JSON object level. Direct SQL inspection confirms all four stored runs and their provider selections and outcomes.

## Separate callback and interruption-control exercise

A second uncommitted script launched `dist/cli.js` as a real subprocess, used authenticated HTTP requests, restarted against its temporary SQLite file, and printed actual responses and database rows. It verified:

1. Repeating the payment question changes its wording while retaining the unpaid status. Pause/resume and concise requests change the response, and filler while paused produces no new agent speech.
2. With a deadline today, a callback tomorrow is rejected and a precise time within the deadline is accepted. The callback time is not recorded as a payment promise.
3. An early external trigger receives HTTP 409 and `Retry-After`. The callback contract survives restart unchanged. The database still contains only the parent after the agreed time arrives, proving nothing dials automatically.
4. External triggers with two different keys return one linked follow-up run. The follow-up reconfirms identity, preserves context without repeating the amount introduction, and requires a fresh payment report.
5. Both successfully used callback keys remain reserved across restart and cannot create a new root call.
6. A MiniMax-selected overdue simulation emphasizes that payment is already late and needs to be made today, while recording the requested callback separately from the unchanged deadline.
7. All subprocesses exit with code 0. Direct SQL inspection shows the completed parent, its single linked follow-up, and the overdue callback request.

This exercise verifies conversation controls through the compiled application, not acoustic interruptions. Audio interruption and playback accounting are covered separately by the real local WebSocket tests described above.

## Not verified here

No provider credentials were available and no external telephone call was placed. These results do not establish voice quality, carrier delivery, acoustic barge-in accuracy, or Jev's judgment quality on natural conversations. Both provider switches were exercised in simulation and their wire protocols separately against local servers. Follow the [live acceptance procedure](operations.md#live-acceptance-procedure) before operational use.

The Dockerfile is supplied but its image was not built or run because the local Docker daemon was unavailable. The compiled Node.js application was run directly. The service has not been deployed to a public host.
