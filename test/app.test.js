import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import webpush from 'web-push';
import { createApp } from '../server/app.js';
import { config } from '../server/config.js';
import { priceBelow, snap } from '../server/ladder.js';
import { openDatabase } from '../server/db.js';
import { createMonitor } from '../server/monitor.js';
import { createDataFluxorProvider } from '../server/providers/datafluxor.js';
import { createFeedProvider } from '../server/providers/feed.js';
import {
  createFutGenieProvider, nameQueries, parseCardPage, parseCardRef, parseListing,
} from '../server/providers/futgenie.js';
import { createPush, isAllowedEndpoint } from '../server/push.js';
import { createStore } from '../server/store.js';

const quiet = { error() {} };
const validSub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
  keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

const memoryStore = async ({ maxWatches = 20, maxAccounts = 50 } = {}) =>
  createStore({ db: await openDatabase(), maxWatches, maxAccounts });

async function harness({ maxWatches = 20, sendImpl } = {}) {
  const store = await memoryStore({ maxWatches });
  const sent = [];
  const send = sendImpl ?? (async (sub, payload) => { sent.push({ sub, payload: JSON.parse(payload) }); });
  const push = createPush({
    store,
    vapid: { publicKey: 'public', privateKey: 'private' },
    subject: 'mailto:test@example.com',
    send,
    log: quiet,
  });
  const market = new Map();
  let failing = false;
  const provider = {
    id: 'fake', label: 'Fake', live: true, requiresRef: false,
    async getPrices(items) {
      if (failing) throw new Error('offline');
      return new Map(items.map((item) => [item.key, market.get(item.playerName)]));
    },
  };
  const monitor = createMonitor({ store, provider, push, log: quiet });
  return { store, push, monitor, market, sent, setFailing: (value) => { failing = value; } };
}

const card = (playerName, targetPrice = 10_000) => ({
  playerName, cardVersion: 'Gold', platform: 'console', sourceRef: '', targetPrice,
});

async function account(store) {
  return store.accountIdForToken(await store.createAccount());
}

test('one notification per drop, and it re-arms after recovery', async () => {
  const { store, monitor, market, sent } = await harness();
  const id = await account(store);
  await store.saveSubscription(id, { endpoint: validSub.endpoint, ...validSub.keys });
  await store.addWatch(id, card('Test Player'));

  for (const [price, expected] of [[11_000, 0], [10_000, 0], [9_900, 1], [9_800, 1], [10_100, 1], [9_700, 2]]) {
    market.set('Test Player', price);
    await monitor.run();
    assert.equal(sent.length, expected, `after price ${price}`);
  }
  assert.match(sent[0].payload.title, /Test Player is under your price/);
  assert.equal((await store.listAlerts(id)).length, 2);
  assert.deepEqual((await store.listWatches(id))[0].history, [11_000, 10_000, 9_900, 9_800, 10_100, 9_700]);
  assert.equal((await monitor.lastRun()).checked, 1);
});

test('editing the target re-arms the alert', async () => {
  const { store, monitor, market, sent } = await harness();
  const id = await account(store);
  await store.saveSubscription(id, { endpoint: validSub.endpoint, ...validSub.keys });
  const watch = await store.addWatch(id, card('Test Player'));
  market.set('Test Player', 9_000);
  await monitor.run();
  await store.updateWatch(id, watch.id, { targetPrice: 9_500 });
  await monitor.run({ watchIds: [watch.id] });
  assert.equal(sent.length, 2);
});

test('a failed or invalid price never fires and keeps the last good price', async () => {
  const { store, monitor, market, sent, setFailing } = await harness();
  const id = await account(store);
  await store.saveSubscription(id, { endpoint: validSub.endpoint, ...validSub.keys });
  await store.addWatch(id, card('Test Player'));
  market.set('Test Player', 12_000);
  await monitor.run();

  setFailing(true);
  await monitor.run();
  assert.equal((await store.listWatches(id))[0].lastError, 'Price source unavailable');
  setFailing(false);

  for (const bad of [0, -5, null, '100', 12.5]) {
    market.set('Test Player', bad);
    await monitor.run();
  }
  const [watch] = await store.listWatches(id);
  assert.equal(watch.currentPrice, 12_000);
  assert.equal(watch.lastError, 'No price available');
  assert.equal(sent.length, 0);
});

test('paused players are not checked or alerted', async () => {
  const { store, monitor, market, sent } = await harness();
  const id = await account(store);
  await store.saveSubscription(id, { endpoint: validSub.endpoint, ...validSub.keys });
  const watch = await store.addWatch(id, card('Test Player'));
  await store.updateWatch(id, watch.id, { paused: true });
  market.set('Test Player', 1_000);
  await monitor.run();
  assert.equal(sent.length, 0);
  assert.equal((await store.listWatches(id))[0].currentPrice, null);
});

test('the account limit keeps a private deployment private', async () => {
  const store = await memoryStore({ maxAccounts: 1 });
  await store.createAccount();
  await assert.rejects(store.createAccount(), /private link/);
});

test('expired push subscriptions are removed', async () => {
  const { store, push } = await harness({
    sendImpl: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); },
  });
  const id = await account(store);
  await store.saveSubscription(id, { endpoint: validSub.endpoint, ...validSub.keys });
  const result = await push.sendTest(id);
  assert.deepEqual(result, { delivered: 0, attempted: 1 });
  assert.equal(await store.countSubscriptions(id), 0);
});

test('alert push is a valid signed request that a device can decrypt', async () => {
  const device = createECDH('prime256v1');
  const devicePublic = device.generateKeys();
  const authSecret = randomBytes(16);
  const store = await memoryStore({ maxAccounts: 5 });
  const id = await account(store);
  await store.saveSubscription(id, {
    endpoint: validSub.endpoint,
    p256dh: devicePublic.toString('base64url'),
    auth: authSecret.toString('base64url'),
  });

  let request;
  const push = createPush({
    store,
    vapid: webpush.generateVAPIDKeys(),
    subject: 'mailto:test@example.com',
    log: quiet,
    send: async (subscription, payload, options) => {
      request = webpush.generateRequestDetails(subscription, payload, options);
    },
  });
  const result = await push.sendAlert({
    accountId: id, watchId: 7, playerName: 'Test Player', cardVersion: 'Gold',
    platform: 'console', price: 9_900, targetPrice: 10_000,
  });
  assert.deepEqual(result, { delivered: 1, attempted: 1 });
  assert.match(request.headers.Authorization, /^vapid t=.+, k=.+/);
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(request.headers.Urgency, 'high');
  assert.equal(request.headers.Topic, 'watch-7');

  // RFC 8291 decryption, as performed by the receiving browser.
  const body = request.body;
  const salt = body.subarray(0, 16);
  const keyLength = body[20];
  const senderPublic = body.subarray(21, 21 + keyLength);
  const encrypted = body.subarray(21 + keyLength);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), devicePublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', device.computeSecret(senderPublic), authSecret, info, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
  const message = JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
  assert.equal(message.title, 'Test Player is under your price');
  assert.match(message.body, /9,900 coins now, your target is 10,000/);
  store.close();
});

test('push endpoints are limited to browser push services', () => {
  assert.equal(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x'), true);
  assert.equal(isAllowedEndpoint('https://web.push.apple.com/x'), true);
  assert.equal(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
  assert.equal(isAllowedEndpoint('http://fcm.googleapis.com/x'), false);
  assert.equal(isAllowedEndpoint('https://fcm.googleapis.com.evil.test/x'), false);
  assert.equal(isAllowedEndpoint('https://127.0.0.1/x'), false);
  assert.equal(isAllowedEndpoint('https://fcm.googleapis.com:8443/x'), false);
});

test('demo prices stay on the ladder and drops land under target', () => {
  assert.equal(snap(12_380), 12_500);
  for (const target of [200, 975, 1_000, 10_000, 50_000, 100_000, 15_000_000]) {
    assert.ok(priceBelow(target) < target, `target ${target}`);
  }
});

test('feed provider sends refs and auth, and reports errors', async () => {
  let request;
  const provider = createFeedProvider({
    url: 'https://prices.example.test/v1/prices',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ prices: { 'console:abc': 4_500 } });
    },
  });
  const prices = await provider.getPrices([{ key: 'console:abc', ref: 'abc', platform: 'console' }]);
  assert.equal(prices.get('console:abc'), 4_500);
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(request.options.body).items[0], { key: 'console:abc', ref: 'abc', platform: 'console' });

  const failing = createFeedProvider({
    url: 'https://prices.example.test/',
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  await assert.rejects(failing.getPrices([]), /HTTP 503/);
});

test('DataFluxor uses the right market and ignores unsafe prices', async () => {
  const urls = [];
  const row = (ea_id, market, price, extra = {}) => ({
    ea_id, market, price, availability: 'listed', stale: false, pending: false, ...extra,
  });
  const provider = createDataFluxorProvider({
    apiKey: 'server-key',
    fetchImpl: async (url, options) => {
      urls.push({ url, key: options.headers['x-api-key'] });
      const items = url.includes('platform=pc')
        ? [row(100, 'pc', 900), row(101, 'console', 800)]
        : [
          row(100, 'console', 1_000),
          row(102, 'console', 500, { stale: true }),
          row(103, 'console', 500, { pending: true }),
          row(104, 'console', 500, { availability: 'extinct' }),
          row(105, 'console', 0),
        ];
      return Response.json({ success: true, data: { items, unresolved: [] } });
    },
  });
  const item = (platform, ref) => ({ key: `${platform}:${ref}`, platform, ref });
  const prices = await provider.getPrices([
    item('console', '100'), item('console', '102'), item('console', '103'),
    item('console', '104'), item('console', '105'), item('pc', '100'), item('pc', '101'),
  ]);
  assert.deepEqual([...prices.entries()].sort(), [['console:100', 1_000], ['pc:100', 900]]);
  assert.equal(urls.length, 2);
  assert.ok(urls.every(({ url, key }) => url.startsWith('https://datafluxor.com/api/v1/fut/prices?') && key === 'server-key'));
});

test('DataFluxor sandbox sends no key and is never labelled live', async () => {
  let request;
  const provider = createDataFluxorProvider({
    sandbox: true,
    apiKey: 'must-not-be-sent',
    fetchImpl: async (url, options) => {
      request = { url, headers: options.headers };
      return Response.json({ success: true, data: { items: [] } });
    },
  });
  await provider.getPrices([{ key: 'console:100', platform: 'console', ref: '100' }]);
  assert.ok(request.url.startsWith('https://datafluxor.com/api/fut-sandbox/prices?'));
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(provider.live, false);
  assert.match(provider.notice.text, /not real/);
});

test('DataFluxor search caches results and skips unusable cards', async () => {
  let calls = 0;
  const provider = createDataFluxorProvider({
    apiKey: 'server-key',
    fetchImpl: async () => {
      calls += 1;
      return Response.json({
        success: true,
        data: {
          cards: [
            { ea_id: 231747, name: 'Test Player', rating: 91, position: 'ST', rarity_name: 'Gold Rare', club: 'Test FC', price: { lowest: 118_000 }, price_pc: { lowest: 121_000 } },
            { ea_id: 0, name: 'No Exact Id' },
            { ea_id: 555, name: 'Old Version', replaced: true },
          ],
        },
      });
    },
  });
  const first = await provider.searchCards('Test');
  const second = await provider.searchCards('  test ');
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].prices, { console: 118_000, pc: 121_000 });
});

test('DataFluxor errors explain the problem without exposing the key', async () => {
  const provider = createDataFluxorProvider({
    apiKey: 'super-secret-key',
    fetchImpl: async () => new Response('{}', { status: 402 }),
  });
  await assert.rejects(
    provider.getPrices([{ key: 'console:100', platform: 'console', ref: '100' }]),
    (error) => /allowance/.test(error.message) && !error.message.includes('super-secret-key'),
  );
  assert.throws(() => createDataFluxorProvider({}), /DATAFLUXOR_API_KEY/);
});

function futGeniePage({
  updated = 'Updated 5 minutes ago',
  points = [{ t: 1, v: 120_000 }, { t: 2, v: 118_000 }],
  title = 'Test Player 91 Gold Rare: Price &amp; Stats (FC 27)',
} = {}) {
  const flight = `35:["$","$L3b",null,{"series":[{"id":"console","label":"Console","points":${JSON.stringify(points)}}],"ranges":[]}]\n`;
  return `<html><head><meta property="og:title" content="${title}"/>`
    + '<meta name="description" content="Test Player Gold Rare 91 OVR ST in EA FC 27."/></head>'
    + `<body><span>${updated}</span><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`;
}

test('FUTGenie page parsing uses only fresh console prices', () => {
  assert.deepEqual(parseCardPage(futGeniePage()), {
    name: 'Test Player', rating: 91, version: 'Gold Rare', position: 'ST',
    prices: { console: 118_000, pc: null },
  });
  assert.equal(parseCardPage(futGeniePage({ updated: 'Updated just now' })).prices.console, 118_000);
  assert.equal(parseCardPage(futGeniePage({ updated: 'Updated an hour ago' })).prices.console, 118_000);
  assert.equal(parseCardPage(futGeniePage({ updated: 'Updated 5 hours ago' })).prices.console, null);
  assert.equal(parseCardPage(futGeniePage({ updated: 'Price' })).prices.console, null);
  assert.equal(parseCardPage(futGeniePage(), { cacheAgeMs: 3 * 3_600_000 }).prices.console, null);
  assert.equal(parseCardPage(futGeniePage({ points: [] })).prices.console, null);
  assert.equal(parseCardPage('<html>Not a card</html>'), null);
});

test('FUTGenie links only resolve to FUTGenie card ids', () => {
  assert.equal(parseCardRef('https://www.futgenie.gg/player-items/981778'), '981778');
  assert.equal(parseCardRef('futgenie.gg/player-items/981778/'), '981778');
  assert.equal(parseCardRef('https://www.futgenie.gg/es/player-items/981778'), '981778');
  assert.equal(parseCardRef('981778'), '981778');
  assert.equal(parseCardRef('https://futgenie.gg.evil.test/player-items/981778'), null);
  assert.equal(parseCardRef('https://www.futgenie.gg/players'), null);
  assert.equal(parseCardRef('Kylian Mbappe'), null);
});

function futGenieListing(items) {
  const flight = `2f:["$","$L30",null,{"items":${JSON.stringify(items)},"changeSuffix":"7d"}]\n`;
  return `<html><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`;
}

const listingItem = (id, platform, price, recordedAt) => ({
  id,
  player: { name: 'Test Player' },
  itemPrices: [{ price, recordedAt: `$D${new Date(recordedAt).toISOString()}`, platform }],
});

test('FUTGenie list parsing reads the requested platform with its timestamp', () => {
  const at = Date.parse('2026-11-24T10:00:00Z');
  const parsed = parseListing(futGenieListing([listingItem(7, 'pc', 98_000, at), listingItem(8, 'console', 5, at)]), 'pc');
  assert.deepEqual([...parsed.entries()], [['7', { price: 98_000, recordedAt: at }]]);
  assert.equal(parseListing('<html></html>', 'pc').size, 0);
});

test('FUTGenie checks both platforms, skips old prices, spaces requests and pauses when pushed back', async () => {
  let clock = Date.parse('2026-11-24T10:00:00Z');
  const fresh = clock - 20 * 60_000;
  const old = clock - 5 * 3_600_000;
  const waits = [];
  const requested = [];
  let status = 200;
  const provider = createFutGenieProvider({
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
    log: quiet,
    fetchImpl: async (url, options) => {
      const filter = JSON.parse(new URL(url).searchParams.get('f'));
      requested.push({ filter, agent: options.headers['user-agent'] });
      if (status !== 200) return new Response('slow down', { status, headers: { 'retry-after': '120' } });
      const prices = {
        console: [listingItem(1, 'console', 118_000, fresh), listingItem(2, 'console', 50_000, old)],
        pc: [listingItem(1, 'pc', 121_000, fresh)],
      };
      return new Response(futGenieListing(prices[filter.platform]));
    },
  });
  const item = (platform, ref, playerName) => ({ key: `${platform}:${ref}`, platform, ref, playerName });

  const prices = await provider.getPrices([
    item('console', '1', 'Test Player'),
    item('console', '2', 'Other Player'),
    item('pc', '1', 'Test Player'),
  ]);
  assert.deepEqual([...prices.entries()], [['console:1', 118_000], ['pc:1', 121_000]]);
  assert.deepEqual(requested.map((r) => r.filter), [
    { platform: 'console', playerName: 'Test Player', take: 96 },
    { platform: 'console', playerName: 'Other Player', take: 96 },
    { platform: 'pc', playerName: 'Test Player', take: 96 },
  ]);
  assert.match(requested[0].agent, /^Undercut\//);
  assert.deepEqual(waits, [3_000, 3_000]);

  clock += 120_000;
  status = 429;
  await assert.rejects(provider.getPrices([item('console', '4', 'Someone')]), /paused/);
  const before = requested.length;
  await assert.rejects(provider.getPrices([item('console', '5', 'Someone Else')]), /paused/);
  assert.equal(requested.length, before, 'no request while paused');

  clock += 121_000;
  status = 200;
  assert.equal(requested.length, before);
  await provider.getPrices([item('pc', '1', 'Test Player')]);
  assert.equal(requested.length, before + 1, 'checks resume after the pause');
});

test('a FUTGenie pause carries over to a fresh server instance', async () => {
  const store = await memoryStore();
  const state = { get: (key) => store.getSetting(key), set: (key, value) => store.setSetting(key, value) };
  const clock = Date.parse('2026-11-24T10:00:00Z');
  let requests = 0;
  const make = (status) => createFutGenieProvider({
    now: () => clock,
    sleep: async () => {},
    log: quiet,
    state,
    fetchImpl: async () => {
      requests += 1;
      return new Response('slow down', { status });
    },
  });
  const item = { key: 'pc:1', platform: 'pc', ref: '1', playerName: 'Test Player' };
  await assert.rejects(make(429).getPrices([item]), /paused/);
  await assert.rejects(make(200).getPrices([item]), /paused/);
  assert.equal(requests, 1, 'the second instance must not contact FUTGenie');
});

test('FUTGenie name search falls back past shortened names and remembers what worked', async () => {
  assert.deepEqual(nameQueries('Diego Armando Maradona'), ['Diego Armando Maradona', 'Maradona']);
  assert.deepEqual(nameQueries('Manuel Franc. dos Santos'), ['Manuel Franc. dos Santos', 'dos Santos', 'Santos']);
  assert.deepEqual(nameQueries('C. Ronaldo dos Santos Aveiro'), ['C. Ronaldo dos Santos Aveiro', 'Ronaldo dos Santos Aveiro', 'Aveiro']);

  const clock = Date.parse('2026-11-24T10:00:00Z');
  const searched = [];
  const provider = createFutGenieProvider({
    now: () => clock,
    sleep: async () => {},
    log: quiet,
    fetchImpl: async (url) => {
      const { playerName } = JSON.parse(new URL(url).searchParams.get('f'));
      searched.push(playerName);
      const items = playerName === 'dos Santos' ? [listingItem(981836, 'pc', 1_979_000, clock - 60_000)] : [];
      return new Response(futGenieListing(items));
    },
  });
  const item = { key: 'pc:981836', platform: 'pc', ref: '981836', playerName: 'Manuel Franc. dos Santos' };
  assert.equal((await provider.getPrices([item])).get('pc:981836'), 1_979_000);
  assert.deepEqual(searched, ['Manuel Franc. dos Santos', 'dos Santos']);
});

let server;
let base;
let ctx;

async function call(method, url, { token, body } = {}) {
  const response = await fetch(base + url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* static file */ }
  return { status: response.status, json, text };
}

before(async () => {
  ctx = await harness();
  ctx.market.set('default', 20_000);
  const provider = {
    id: 'fake', label: 'Fake', live: true, requiresRef: false,
    getPrices: async (items) => new Map(items.map((item) => [item.key, 20_000])),
  };
  const monitor = createMonitor({ store: ctx.store, provider, push: ctx.push, log: quiet });
  const handler = createApp({
    store: ctx.store,
    monitor,
    push: ctx.push,
    provider,
    config: { ...config, maxWatches: 20, cronSecret: 'test-cron-secret', publicDir: path.join(config.root, 'public') },
    vapidPublicKey: 'public',
    log: quiet,
  });
  server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
});

test('API enforces the 20 player limit and rejects duplicates', async () => {
  const { json: { token } } = await call('POST', '/api/accounts');
  for (let index = 1; index <= 20; index += 1) {
    const created = await call('POST', '/api/watches', {
      token,
      body: { playerName: `Player ${index}`, cardVersion: 'Gold', platform: 'console', targetPrice: 10_000 },
    });
    assert.equal(created.status, 201);
  }
  const extra = await call('POST', '/api/watches', {
    token,
    body: { playerName: 'Player 21', cardVersion: 'Gold', platform: 'console', targetPrice: 10_000 },
  });
  assert.equal(extra.status, 409);
  assert.match(extra.json.error, /up to 20/);

  const { json: { token: second } } = await call('POST', '/api/accounts');
  await call('POST', '/api/watches', {
    token: second,
    body: { playerName: 'Same Card', cardVersion: 'Gold', platform: 'pc', targetPrice: 10_000 },
  });
  const duplicate = await call('POST', '/api/watches', {
    token: second,
    body: { playerName: 'same card', cardVersion: 'gold', platform: 'pc', targetPrice: 12_000 },
  });
  assert.equal(duplicate.status, 409);
});

test('API keeps accounts isolated and requires auth', async () => {
  assert.equal((await call('GET', '/api/state')).status, 401);
  const { json: { token: a } } = await call('POST', '/api/accounts');
  const { json: { token: b } } = await call('POST', '/api/accounts');
  const created = await call('POST', '/api/watches', {
    token: a,
    body: { playerName: 'Private Card', platform: 'console', targetPrice: 5_000 },
  });
  const url = `/api/watches/${created.json.id}`;
  assert.equal((await call('PATCH', url, { token: b, body: { targetPrice: 6_000 } })).status, 404);
  assert.equal((await call('DELETE', url, { token: b })).status, 404);
  assert.equal((await call('GET', '/api/state', { token: b })).json.watches.length, 0);
  assert.equal((await call('GET', '/api/state', { token: a })).json.watches.length, 1);
});

test('API validates input and rejects non-push endpoints', async () => {
  const { json: { token } } = await call('POST', '/api/accounts');
  for (const body of [
    { playerName: 'A', platform: 'console', targetPrice: 5_000 },
    { playerName: 'Valid Name', platform: 'switch', targetPrice: 5_000 },
    { playerName: 'Valid Name', platform: 'pc', targetPrice: 100 },
    { playerName: 'Valid Name', platform: 'pc', targetPrice: 12.5 },
    { playerName: 'Valid Name', platform: 'pc', targetPrice: 99_000_000 },
  ]) {
    assert.equal((await call('POST', '/api/watches', { token, body })).status, 400);
  }
  const bad = await call('POST', '/api/push/subscribe', {
    token,
    body: { ...validSub, endpoint: 'http://127.0.0.1:9000/steal' },
  });
  assert.equal(bad.status, 400);
  assert.equal((await call('POST', '/api/push/subscribe', { token, body: validSub })).status, 200);
});

test('scheduled checks need the cron secret', async () => {
  const run = (authorization) => fetch(`${base}/api/cron`, { method: 'POST', headers: authorization ? { authorization } : {} });
  assert.equal((await run()).status, 401);
  assert.equal((await run('Bearer wrong-secret')).status, 401);
  const ok = await run('Bearer test-cron-secret');
  assert.equal(ok.status, 200);
  assert.equal(typeof (await ok.json()).checked, 'number');
});

test('static serving blocks path traversal', async () => {
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/..%2fpackage.json`, { method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(response, 404);
});
