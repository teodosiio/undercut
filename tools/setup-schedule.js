// Creates or updates the Upstash QStash schedule that runs Undercut's price check every 15 minutes.
//
//   node --env-file=.env.local tools/setup-schedule.js [--test]
//
// Needs QSTASH_TOKEN (and optionally QSTASH_URL) from the Vercel QStash integration, plus
// UNDERCUT_URL and CRON_SECRET (the same value as the CRON_SECRET set on Vercel).
// --test also sends one check right away. Secrets are never printed.
const SCHEDULE_ID = 'undercut-price-checks';
const CRON = '7,22,37,52 * * * *';

const env = (name) => (process.env[name] ?? '').trim();
const token = env('QSTASH_TOKEN');
const qstash = (env('QSTASH_URL') || 'https://qstash.upstash.io').replace(/\/+$/, '');
const site = env('UNDERCUT_URL').replace(/\/+$/, '');
const secret = env('CRON_SECRET');

for (const [name, value] of Object.entries({ QSTASH_TOKEN: token, UNDERCUT_URL: site, CRON_SECRET: secret })) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
}

const destination = `${site}/api/cron`;
const headers = {
  authorization: `Bearer ${token}`,
  'upstash-method': 'POST',
  'upstash-retries': '1',
  'upstash-forward-authorization': `Bearer ${secret}`,
};

async function qstashRequest(method, path, extraHeaders = {}) {
  const response = await fetch(`${qstash}${path}`, {
    method,
    headers: { ...headers, ...extraHeaders },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`QStash ${method} ${path.split('/').slice(0, 3).join('/')} returned ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

const created = await qstashRequest('POST', `/v2/schedules/${destination}`, {
  'upstash-cron': CRON,
  'upstash-schedule-id': SCHEDULE_ID,
});
console.log(`schedule ${created.scheduleId}: ${CRON} (UTC) -> ${destination}`);

const schedules = await qstashRequest('GET', '/v2/schedules');
const mine = schedules.find((schedule) => schedule.scheduleId === SCHEDULE_ID);
if (mine?.nextScheduleTime) console.log(`next run: ${new Date(mine.nextScheduleTime).toISOString()}`);
console.log(`active schedules: ${schedules.length}`);

if (process.argv.includes('--test')) {
  const sent = await qstashRequest('POST', `/v2/publish/${destination}`);
  console.log(`test check sent: ${sent.messageId}`);
}
