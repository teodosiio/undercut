import webpush from 'web-push';

// The server posts to subscription endpoints, so only real browser push services are accepted.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

export function isAllowedEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.port === '' && !url.username && !url.password
      && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch {
    return false;
  }
}

// Generated once and stored, so every server instance signs pushes with the same keys.
export async function loadVapidKeys(store) {
  const saved = await store.getSetting('vapid');
  if (saved) return JSON.parse(saved);
  await store.setSettingIfAbsent('vapid', JSON.stringify(webpush.generateVAPIDKeys()));
  return JSON.parse(await store.getSetting('vapid'));
}

const coins = (value) => value.toLocaleString('en-US');

export function createPush({ store, vapid, subject, send = webpush.sendNotification, log = console }) {
  const options = (topic) => ({
    TTL: 3600,
    urgency: 'high',
    topic,
    vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
  });

  async function deliver(accountId, payload, topic) {
    const subscriptions = await store.subscriptionsFor(accountId);
    const results = await Promise.allSettled(subscriptions.map((sub) => send(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      options(topic),
    )));

    let delivered = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        delivered += 1;
      } else if ([404, 410].includes(result.reason?.statusCode)) {
        await store.deleteSubscription(subscriptions[index].endpoint);
      } else {
        log.error('Push failed:', result.reason?.statusCode ?? result.reason?.message);
      }
    }
    return { delivered, attempted: subscriptions.length };
  }

  return {
    sendAlert(alert) {
      const above = alert.direction === 'above';
      const card = `${alert.cardVersion}, ${alert.platform === 'pc' ? 'PC' : 'Console'}`;
      return deliver(alert.accountId, {
        title: `${alert.playerName} is ${above ? 'above' : 'under'} your price`,
        body: `${coins(alert.price)} coins now, your ${above ? 'above' : 'under'} price is ${coins(alert.targetPrice)} (${card})`,
        tag: `watch-${alert.watchId}-${above ? 'above' : 'under'}`,
        url: '/?view=alerts',
      }, `watch-${alert.watchId}-${above ? 'above' : 'under'}`);
    },
    sendTest(accountId) {
      return deliver(accountId, {
        title: 'Undercut notifications are on',
        body: 'You will get an alert here when a player drops under your price.',
        tag: 'test',
        url: '/',
      }, 'test');
    },
  };
}
