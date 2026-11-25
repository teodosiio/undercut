import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.js';
import { MAX_PRICE, MIN_TARGET } from './ladder.js';
import { priceKey } from './monitor.js';
import { isAllowedEndpoint } from './push.js';

const MAX_BODY = 16 * 1024;
const MAX_SEARCHES_PER_MINUTE = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'Request is not valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request must be a JSON object.');
  }
  return body;
}

function cleanText(value, label, { min, max }) {
  if (typeof value !== 'string') throw new ApiError(400, `${label} is required.`);
  const text = value.normalize('NFC').replace(/\p{C}/gu, '').replace(/\s+/g, ' ').trim();
  if (text.length < min || text.length > max) {
    throw new ApiError(400, `${label} must be ${min} to ${max} characters.`);
  }
  return text;
}

// An alert price, or null when that alert is off (missing, null or an empty string).
function parsePrice(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || value < MIN_TARGET || value > MAX_PRICE) {
    throw new ApiError(400, `${label} must be from ${MIN_TARGET} to ${MAX_PRICE.toLocaleString('en-US')} coins.`);
  }
  return value;
}

function checkPrices(under, above) {
  if (under === null && above === null) throw new ApiError(400, 'Set an under price, an above price, or both.');
  if (under !== null && above !== null && above <= under) {
    throw new ApiError(400, 'The above price must be higher than the under price.');
  }
}

function parseWatch(body, provider) {
  if (!['console', 'pc'].includes(body.platform)) throw new ApiError(400, 'Choose Console or PC.');
  if (provider.platforms && !provider.platforms.includes(body.platform)) {
    throw new ApiError(400, 'This price source only has console prices.');
  }
  const sourceRef = body.sourceRef ? cleanText(body.sourceRef, 'Source ID', { min: 1, max: 120 }) : '';
  if (provider.requiresRef && !sourceRef) throw new ApiError(400, 'Source ID is required.');
  if (sourceRef && provider.isValidRef && !provider.isValidRef(sourceRef)) {
    throw new ApiError(400, 'Choose a card from the search results.');
  }
  const targetPrice = parsePrice(body.targetPrice, 'Under price');
  const abovePrice = parsePrice(body.abovePrice, 'Above price');
  checkPrices(targetPrice, abovePrice);
  return {
    playerName: cleanText(body.playerName, 'Player name', { min: 2, max: 60 }),
    cardVersion: cleanText(body.cardVersion || 'Standard', 'Card version', { min: 1, max: 40 }),
    platform: body.platform,
    sourceRef,
    targetPrice,
    abovePrice,
  };
}

function parseSubscription(body) {
  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  const validKey = (key) => typeof key === 'string' && key.length <= 256 && /^[\w-]+=*$/.test(key);
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isAllowedEndpoint(endpoint)
    || !validKey(p256dh) || !validKey(auth)) {
    throw new ApiError(400, 'This browser push subscription is not supported.');
  }
  return { endpoint, p256dh, auth };
}

export function createApp({ store, monitor, push, provider, config, vapidPublicKey, log = console }) {
  const searchWindows = new Map();

  function limitSearch(accountId) {
    const minute = Math.floor(Date.now() / 60_000);
    const entry = searchWindows.get(accountId);
    if (entry?.minute !== minute) {
      searchWindows.set(accountId, { minute, count: 1 });
    } else if (++entry.count > MAX_SEARCHES_PER_MINUTE) {
      throw new ApiError(429, 'Too many searches. Try again in a minute.');
    }
  }

  async function authenticate(req) {
    const match = /^Bearer ([\w-]{20,100})$/.exec(req.headers.authorization ?? '');
    const accountId = match ? await store.accountIdForToken(match[1]) : null;
    if (!accountId) throw new ApiError(401, 'Sign-in code is not valid.');
    return accountId;
  }

  // Scheduled checks (GitHub Actions or Vercel) call /api/cron with "Authorization: Bearer <CRON_SECRET>".
  function cronAllowed(req) {
    if (!config.cronSecret) return false;
    const digest = (value) => createHash('sha256').update(value).digest();
    return timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${config.cronSecret}`));
  }

  async function stateFor(accountId) {
    const [watches, alerts, unread, pushDevices, lastRun] = await Promise.all([
      store.listWatches(accountId),
      store.listAlerts(accountId),
      store.unreadAlerts(accountId),
      store.countSubscriptions(accountId),
      monitor.lastRun(),
    ]);
    return { watches, alerts, unread, limit: config.maxWatches, pushDevices, lastRun };
  }

  async function handleApi(req, res, pathname, searchParams) {
    const { method } = req;

    if (method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        maxWatches: config.maxWatches,
        pollSeconds: config.pollSeconds,
        vapidPublicKey,
        provider: {
          id: provider.id,
          label: provider.label,
          live: provider.live,
          requiresRef: provider.requiresRef,
          canSimulateDrop: typeof provider.forceDrop === 'function',
          canSearch: typeof provider.searchCards === 'function',
          notice: provider.notice ?? null,
          platforms: provider.platforms ?? ['console', 'pc'],
          search: provider.search ?? null,
          credit: provider.credit ?? null,
        },
      });
    }

    if (pathname === '/api/cron') {
      if (!['GET', 'POST'].includes(method)) throw new ApiError(405, 'Method not allowed.');
      if (!cronAllowed(req)) throw new ApiError(401, 'Not allowed.');
      return sendJson(res, 200, await monitor.run());
    }

    if (method === 'POST' && pathname === '/api/accounts') {
      return sendJson(res, 201, { token: await store.createAccount() });
    }

    const accountId = await authenticate(req);

    if (method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, await stateFor(accountId));
    }

    if (method === 'GET' && pathname === '/api/cards/search') {
      if (typeof provider.searchCards !== 'function') throw new ApiError(404, 'Not found.');
      const query = cleanText(searchParams.get('q') ?? '', 'Search', { min: 2, max: 200 });
      limitSearch(accountId);
      try {
        return sendJson(res, 200, { cards: await provider.searchCards(query) });
      } catch (error) {
        log.error('Card search failed:', error.message);
        throw new ApiError(502, 'Player search is unavailable right now.');
      }
    }

    if (method === 'POST' && pathname === '/api/watches') {
      const watch = await store.addWatch(accountId, parseWatch(await readJson(req), provider));
      await monitor.run({ watchIds: [watch.id] });
      return sendJson(res, 201, { id: watch.id, state: await stateFor(accountId) });
    }

    const watchMatch = /^\/api\/watches\/(\d{1,9})(\/simulate-drop)?$/.exec(pathname);
    if (watchMatch) {
      const id = Number(watchMatch[1]);

      if (watchMatch[2]) {
        if (method !== 'POST') throw new ApiError(405, 'Method not allowed.');
        if (typeof provider.forceDrop !== 'function') throw new ApiError(404, 'Not found.');
        const row = await store.getWatchFor(accountId, id);
        if (!row) throw new ApiError(404, 'Player not found.');
        if (row.paused) throw new ApiError(409, 'Resume this player first.');
        // Demo only: crosses the under price if there is one, otherwise the above price.
        if (row.target_price !== null) provider.forceDrop(priceKey(row), row.target_price);
        else provider.forceRise(priceKey(row), row.above_price);
        await monitor.run({ watchIds: [id] });
        return sendJson(res, 200, { state: await stateFor(accountId) });
      }

      if (method === 'PATCH') {
        const body = await readJson(req);
        const patch = {};
        if (body.targetPrice !== undefined) patch.targetPrice = parsePrice(body.targetPrice, 'Under price');
        if (body.abovePrice !== undefined) patch.abovePrice = parsePrice(body.abovePrice, 'Above price');
        if (patch.targetPrice !== undefined || patch.abovePrice !== undefined) {
          const current = await store.getWatchFor(accountId, id);
          if (!current) throw new ApiError(404, 'Player not found.');
          checkPrices(
            patch.targetPrice !== undefined ? patch.targetPrice : current.target_price,
            patch.abovePrice !== undefined ? patch.abovePrice : current.above_price,
          );
        }
        if (body.paused !== undefined) {
          if (typeof body.paused !== 'boolean') throw new ApiError(400, 'Paused must be true or false.');
          patch.paused = body.paused;
        }
        await store.updateWatch(accountId, id, patch);
        await monitor.run({ watchIds: [id] });
        return sendJson(res, 200, { state: await stateFor(accountId) });
      }

      if (method === 'DELETE') {
        await store.deleteWatch(accountId, id);
        return sendJson(res, 200, { state: await stateFor(accountId) });
      }
      throw new ApiError(405, 'Method not allowed.');
    }

    if (method === 'POST' && pathname === '/api/alerts/read') {
      await store.markAlertsRead(accountId);
      return sendJson(res, 200, { state: await stateFor(accountId) });
    }

    if (method === 'POST' && pathname === '/api/push/subscribe') {
      await store.saveSubscription(accountId, parseSubscription(await readJson(req)));
      return sendJson(res, 200, { pushDevices: await store.countSubscriptions(accountId) });
    }

    if (method === 'POST' && pathname === '/api/push/unsubscribe') {
      const { endpoint } = await readJson(req);
      if (typeof endpoint !== 'string') throw new ApiError(400, 'Endpoint is required.');
      await store.deleteOwnSubscription(accountId, endpoint);
      return sendJson(res, 200, { pushDevices: await store.countSubscriptions(accountId) });
    }

    if (method === 'POST' && pathname === '/api/push/test') {
      return sendJson(res, 200, await push.sendTest(accountId));
    }

    throw new ApiError(404, 'Not found.');
  }

  async function serveStatic(req, res, pathname) {
    if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'Method not allowed.');
    const relative = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
    const file = path.resolve(config.publicDir, `.${decodeURIComponent(relative)}`);
    const type = MIME[path.extname(file)];
    if (!file.startsWith(config.publicDir + path.sep) || !type || file.includes('\0')) {
      throw new ApiError(404, 'Not found.');
    }
    let content;
    try {
      content = await readFile(file);
    } catch {
      throw new ApiError(404, 'Not found.');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  }

  return async function handler(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname, searchParams);
      return await serveStatic(req, res, pathname);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof ApiError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof URIError || error.code === 'ERR_INVALID_URL') {
        return sendJson(res, 400, { error: 'Bad request.' });
      }
      log.error(error);
      return sendJson(res, 500, { error: 'Something went wrong.' });
    }
  };
}
