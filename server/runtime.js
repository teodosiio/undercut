import path from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { createMonitor } from './monitor.js';
import { createProvider } from './providers/index.js';
import { createPush, loadVapidKeys } from './push.js';
import { createStore } from './store.js';

// Wires the app together. Used by the local server (server/index.js) and the Vercel function (api/index.js).
export async function createRuntime(config, { log = console } = {}) {
  const db = await openDatabase({
    url: config.databaseUrl,
    dataDir: config.databaseUrl ? null : path.join(config.dataDir, 'pgdata'),
  });
  const store = await createStore({ db, maxWatches: config.maxWatches, maxAccounts: config.maxAccounts });
  const vapid = await loadVapidKeys(store);
  const state = { get: (key) => store.getSetting(key), set: (key, value) => store.setSetting(key, value) };
  const provider = createProvider(config, { state });
  const push = createPush({ store, vapid, subject: config.vapidSubject, log });
  const monitor = createMonitor({ store, provider, push, log });
  const handler = createApp({ store, monitor, push, provider, config, vapidPublicKey: vapid.publicKey, log });
  return { store, provider, monitor, handler, close: () => store.close() };
}
