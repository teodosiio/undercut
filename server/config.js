import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Values pasted into hosting dashboards often carry a trailing newline.
const env = (name) => (process.env[name] ?? '').trim();

function intEnv(name, fallback, min, max) {
  const raw = env(name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

const priceProvider = env('PRICE_PROVIDER') || 'simulated';
const defaultPollSeconds = { simulated: 15, futgenie: 900, datafluxor: 120 }[priceProvider] ?? 60;

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 8787, 1, 65535),
  maxWatches: intEnv('MAX_WATCHES', 20, 1, 500),
  maxAccounts: intEnv('MAX_ACCOUNTS', 100, 1, 1_000_000),
  pollSeconds: intEnv('POLL_SECONDS', defaultPollSeconds, 5, 3600),
  priceProvider,
  feedUrl: process.env.PRICE_FEED_URL || '',
  feedToken: process.env.PRICE_FEED_TOKEN || '',
  dataFluxorKey: process.env.DATAFLUXOR_API_KEY || '',
  dataFluxorSandbox: process.env.DATAFLUXOR_SANDBOX === '1',
  // Neon via the Vercel integration sets DATABASE_URL. Without it, a local PGlite database is used.
  databaseUrl: env('DATABASE_URL') || env('POSTGRES_URL'),
  cronSecret: env('CRON_SECRET'),
  vapidSubject: env('VAPID_SUBJECT')
    || (env('VERCEL_PROJECT_PRODUCTION_URL') ? `https://${env('VERCEL_PROJECT_PRODUCTION_URL')}` : 'mailto:alerts@example.com'),
};
