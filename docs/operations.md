# Operations and verification

## Check a run

Read the run and its result using the authenticated API. Distinguish call completion from task completion: a recipient hanging up, a provider error, or a human-follow-up outcome can terminate a run without supplying every requested answer. A `reported_paid` result still requires reconciliation against your own financial system.

Keep the run ID and Twilio call SID when investigating an incident. Avoid placing full transcripts, phone numbers, secrets, or invoice details in general-purpose logs and issue reports. API access exposes the stored request and transcript, so restrict network access and rotate the bearer secret when needed.

## Restart and recovery

Keep the database on persistent disk. Work that was queued can remain available, but an active call cannot be transparently resumed after process loss. Inspect runs marked with a restart-related result and reconcile any associated call in Twilio before deciding what to do next. Do not blindly recreate runs with new idempotency keys: that can create duplicate calls.

Before a planned restart, stop submitting new work and wait for active calls to finish or cancel them. During an unplanned interruption, verify the carrier-side call state as well as the local run state. SQLite persistence cannot guarantee that an external carrier action and a local database update occurred atomically.

## Backups and retention

Use SQLite's online backup mechanism or stop the process before copying database files. Copying only the main database while WAL writes are active is not a reliable backup. Test restoration to a separate environment without live dialing enabled.

Requests, transcripts, and evidence remain on disk unless you remove them through your own retention process. This release does not provide a retention scheduler, a run-deletion endpoint, encryption at rest, or a multi-tenant authorization model. Use an encrypted volume, restricted backups, and a retention policy appropriate to your deployment.

## Verification layers

Run the complete local checks:

```sh
npm ci
npm run check
npm run lint
npm run format:check
npm test
npm run build
```

Also exercise the compiled application as a real subprocess against a temporary database: launch the HTTP server, submit JSON through the public API, advance a simulation, inspect the returned result, restart the process, and inspect persistence. Keep that exploratory script outside the repository. This catches runtime entry-point, filesystem, and HTTP integration problems that isolated unit tests miss.

Simulation validates software behavior without dialing. It does not test phone delivery, provider credentials, voice-model access, acoustic interruption detection, or natural-language decision quality on a real call.

## Live acceptance procedure

Use an authorized recipient and nonsensitive synthetic payment details. Test each speech provider separately.

1. Confirm that the call identifies its purpose appropriately and asks who is speaking before giving payment details.
2. Interrupt a spoken response. Confirm that queued audio stops and the next response addresses the interruption without replaying stale speech.
3. Report an already completed payment. Confirm `paymentStatus: reported_paid`, `paymentVerified: false`, and relevant evidence in the result.
4. In a separate call, report an unpaid balance and a date after the deadline. Confirm that the agent requests payment today and stops repeating the request at `maxReminders`.
5. Test a dispute, opt-out, wrong recipient, silence, hangup, and an ambiguous payment date. Confirm an appropriate terminal reason and human follow-up where information is missing.
6. Ask the agent to ignore its task or discuss an unrelated subject. Confirm it keeps the payment workflow bounded.
7. Cancel an active call through the API and inspect both local and carrier state.

Do not claim production voice quality or reliability from a simulation-only test run. Record the provider, model, voice ID, run ID, date, and observed behavior for each live acceptance test.

## Common failures

- **Authentication rejected:** ensure the bearer secret matches the server environment and is not truncated by shell quoting.
- **Idempotency conflict:** the same key was reused with different input. Retrieve the original run, or deliberately create a separate run with a new key.
- **No call in live mode:** check the destination allowlist, Twilio account restrictions, outbound number capability, and provider credentials.
- **Twilio webhook rejected:** check that `PUBLIC_BASE_URL` exactly matches the externally requested HTTPS origin and that the proxy preserves callback paths and body content.
- **Call connects but no audio:** inspect the media-stream connection, Deepgram authorization, speech-provider response, and WebSocket forwarding. Confirm the selected voice belongs to the selected provider.
- **Run needs human review:** read `finishReason`, `paymentEvidence`, and `timelineEvidence`; do not infer a payment commitment that was not recorded.

## Current limits

One process, one local SQLite database, and one workflow. There is no automatic redialing, result webhook, scheduled retry campaign, payment processing, payment verification, or general-purpose negotiation. The API bearer credential is shared across the deployment. Add tenant isolation, authenticated identity verification, a durable distributed queue, and audited retention before adapting the service to a broader operational setting.
