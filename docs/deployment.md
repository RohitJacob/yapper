# Configuration and deployment

Use Node.js 24 LTS. The application is a single instance with a persistent SQLite volume. Put it behind an HTTPS reverse proxy for live calls, preserving WebSocket upgrades. Make its public URL reachable from Twilio.

## Environment

Copy `.env.example` and set values for your deployment. `npm start` and `npm run dev` load `.env` when present; process environment values take precedence. The example local commands also source the file so curl can use the API secret. Containers receive variables through `--env-file`. Do not commit `.env`, provider credentials, call data, or SQLite files.

- `YAPPER_MODE`: `simulation` by default; set `live` to place real calls.
- `YAPPER_API_KEY`: required bearer secret, at least 32 characters. Generate a random value, for example `openssl rand -hex 32`.
- `HOST`: listen address, default `127.0.0.1`. Use `0.0.0.0` inside a container behind a controlled ingress.
- `PORT`: HTTP port, default `3000`.
- `DATABASE_PATH`: persistent SQLite path, default `./data/yapper.sqlite`.
- `MAX_CONCURRENT_CALLS`: worker concurrency, default `2`, range `1`–`50`.
- `PUBLIC_BASE_URL`: externally reachable HTTPS origin for live carrier webhooks and media URLs; defaults to `http://localhost:3000` for simulation. It must have no path, credentials, query, or fragment and must match the URL Twilio uses so signature validation succeeds.
- `ALLOWED_NUMBERS`: comma-separated E.164 destinations approved for live calls. Live mode requires an allowlist.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: live telephone account and an outbound-capable number.
- `DEEPGRAM_API_KEY`: live transcription credential.
- `TYPESAFE_API_KEY`: Jev credential for live decisions.
- `TYPESAFE_MODEL`: Jev model, default `jev-latest`.
- `ELEVENLABS_API_KEY`: credential for calls using ElevenLabs.
- `MINIMAX_API_KEY`: credential for calls using MiniMax.

The API selects provider and voice per run. ElevenLabs uses `eleven_v3`; MiniMax uses `speech-02-hd`. Ensure the voice ID exists in the selected account and your account has model access before making a test call.

## Container

```sh
docker build -t yapper:local .
docker volume create yapper-data
docker run --rm --name yapper \
  --env-file .env \
  -e HOST=0.0.0.0 \
  -e DATABASE_PATH=/app/data/yapper.sqlite \
  -p 127.0.0.1:3000:3000 \
  -v yapper-data:/app/data \
  yapper:local
```

The image runs as the unprivileged `node` user. A fresh named volume inherits the data directory's ownership. For an existing bind mount, ensure the runtime user can write to it. Keep the database, WAL, and shared-memory files together on the volume.

The Docker health check probes `/healthz`. It is liveness, not a provider connectivity test or a guarantee that an outbound call will succeed.

## Enable live calls

1. Create Twilio, Deepgram, TypeSafe, and the required speech-provider credentials. Provision a Twilio number capable of outbound voice calls.
2. Deploy one instance with a durable local volume and HTTPS ingress. Enable WebSocket upgrade forwarding and timeouts longer than the configured maximum call duration.
3. Set `YAPPER_MODE=live`, `PUBLIC_BASE_URL`, credentials, and an explicit `ALLOWED_NUMBERS` list containing only approved test recipients at first.
4. Submit a short authorized test call with valid consent attestations and a real provider voice ID. Check both interruption behavior and the final result.
5. Repeat with the second provider using a new idempotency key. Compare speech latency and intelligibility over the actual telephone network.

The service builds the per-call Twilio callback and stream URLs from `PUBLIC_BASE_URL`. Do not rewrite their external paths or hostnames without adjusting the deployment configuration. The reverse proxy must preserve request bodies needed for signature validation.

Live calls incur external provider charges. Concurrency and per-call duration limits bound individual workloads, but they are not an account spending cap; configure account-level limits with your providers.

## Release process

Install from the lockfile with `npm ci`, then run `npm run check`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run build`. CI executes these checks on pull requests and pushes. Back up the database before deploying a version that changes persistence. Drain active calls before restarting when possible.
