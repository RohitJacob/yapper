import { z } from 'zod';

const EnvSchema = z.object({
  YAPPER_MODE: z.enum(['simulation', 'live']).default('simulation'),
  YAPPER_API_KEY: z.string().min(32),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().default('./data/yapper.sqlite'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  MAX_CONCURRENT_CALLS: z.coerce.number().int().min(1).max(50).default(2),
  ALLOWED_NUMBERS: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: z.string().default('jev-latest'),
  ELEVENLABS_API_KEY: z.string().optional(),
  MINIMAX_API_KEY: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const value = parsed.data;
  const allowedNumbers = value.ALLOWED_NUMBERS.split(',')
    .map((number) => number.trim())
    .filter(Boolean);
  const base = new URL(value.PUBLIC_BASE_URL);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error(
      'PUBLIC_BASE_URL must be an origin without credentials, path, query or fragment',
    );
  }
  if (value.YAPPER_MODE === 'live') {
    const required = [
      'TWILIO_ACCOUNT_SID',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_FROM_NUMBER',
      'DEEPGRAM_API_KEY',
      'TYPESAFE_API_KEY',
    ] as const;
    const missing = required.filter((key) => !value[key]);
    if (missing.length)
      throw new Error(`Live mode requires: ${missing.join(', ')}`);
    if (base.protocol !== 'https:')
      throw new Error('Live mode requires an HTTPS PUBLIC_BASE_URL');
    if (
      !allowedNumbers.length ||
      allowedNumbers.some((number) => !/^\+[1-9]\d{7,14}$/.test(number))
    ) {
      throw new Error(
        'Live mode requires ALLOWED_NUMBERS as comma-separated E.164 numbers',
      );
    }
    if (!/^AC[0-9a-f]{32}$/i.test(value.TWILIO_ACCOUNT_SID ?? ''))
      throw new Error('Invalid TWILIO_ACCOUNT_SID');
    if (!/^\+[1-9]\d{7,14}$/.test(value.TWILIO_FROM_NUMBER ?? ''))
      throw new Error('Invalid TWILIO_FROM_NUMBER');
  }
  return { ...value, PUBLIC_BASE_URL: base.origin, allowedNumbers };
}
