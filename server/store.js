import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

// Every write is a single statement, so it stays atomic over Neon's HTTP driver.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS watches (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    player_name TEXT NOT NULL,
    card_version TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('console', 'pc')),
    source_ref TEXT NOT NULL DEFAULT '',
    identity TEXT NOT NULL,
    target_price INTEGER NOT NULL,
    current_price INTEGER,
    armed BOOLEAN NOT NULL DEFAULT TRUE,
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    last_checked BIGINT,
    last_error TEXT,
    created_at BIGINT NOT NULL,
    UNIQUE (account_id, identity, platform)
  )`,
  `CREATE TABLE IF NOT EXISTS price_points (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
    at BIGINT NOT NULL,
    price INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS price_points_watch ON price_points (watch_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    watch_id INTEGER REFERENCES watches(id) ON DELETE SET NULL,
    player_name TEXT NOT NULL,
    card_version TEXT NOT NULL,
    platform TEXT NOT NULL,
    price INTEGER NOT NULL,
    target_price INTEGER NOT NULL,
    created_at BIGINT NOT NULL,
    read_at BIGINT
  )`,
  'CREATE INDEX IF NOT EXISTS alerts_account ON alerts (account_id, id DESC)',
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Above alerts: a watch has an under price (target_price), an above price, or both.
  // These upgrade databases created before above alerts existed, and are no-ops afterwards.
  'ALTER TABLE watches ALTER COLUMN target_price DROP NOT NULL',
  'ALTER TABLE watches ADD COLUMN IF NOT EXISTS above_price INTEGER',
  'ALTER TABLE watches ADD COLUMN IF NOT EXISTS armed_above BOOLEAN NOT NULL DEFAULT TRUE',
  "ALTER TABLE alerts ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'under'",
];

const HISTORY_KEPT = 120;
const HISTORY_SENT = 40;
const ALERTS_SENT = 30;
const MAX_DEVICES = 10;

const hashToken = (token) => createHash('sha256').update(token).digest('hex');
// Neon returns BIGINT and COUNT as strings; PGlite returns numbers.
const int = (value) => (value === null || value === undefined ? null : Number(value));

export const identityOf = ({ playerName, cardVersion, sourceRef = '' }) =>
  [playerName, cardVersion, sourceRef].map((part) => part.toLocaleLowerCase()).join('|');

function watchRow(row) {
  return {
    ...row,
    id: int(row.id),
    account_id: int(row.account_id),
    target_price: int(row.target_price),
    above_price: int(row.above_price),
    current_price: int(row.current_price),
    last_checked: int(row.last_checked),
    created_at: int(row.created_at),
  };
}

function publicWatch(row, history = []) {
  return {
    id: row.id,
    playerName: row.player_name,
    cardVersion: row.card_version,
    platform: row.platform,
    sourceRef: row.source_ref,
    targetPrice: row.target_price,
    abovePrice: row.above_price,
    currentPrice: row.current_price,
    paused: row.paused,
    lastChecked: row.last_checked,
    lastError: row.last_error,
    history,
  };
}

function alertFromRow(row) {
  return {
    id: int(row.id),
    accountId: int(row.account_id),
    watchId: int(row.watch_id),
    playerName: row.player_name,
    cardVersion: row.card_version,
    platform: row.platform,
    price: int(row.price),
    targetPrice: int(row.target_price),
    direction: row.direction ?? 'under',
    createdAt: int(row.created_at),
    read: row.read_at !== null && row.read_at !== undefined,
  };
}

export async function createStore({ db, maxWatches, maxAccounts, now = Date.now }) {
  for (const statement of SCHEMA) await db.query(statement);

  const one = async (text, params) => (await db.query(text, params))[0] ?? null;
  const count = async (text, params) => int((await one(text, params))?.n ?? 0);

  async function countWatches(accountId) {
    return count('SELECT count(*) AS n FROM watches WHERE account_id = $1', [accountId]);
  }

  return {
    close: () => db.close(),

    async createAccount() {
      const token = randomBytes(32).toString('base64url');
      const created = await one(
        `INSERT INTO accounts (token_hash, created_at)
         SELECT $1::text, $2::bigint WHERE (SELECT count(*) FROM accounts) < $3::int
         RETURNING id`,
        [hashToken(token), now(), maxAccounts],
      );
      if (!created) {
        throw new ApiError(503, 'This Undercut has no room for another watchlist. Open your private link from a device that is already set up.');
      }
      return token;
    },

    async accountIdForToken(token) {
      return int((await one('SELECT id FROM accounts WHERE token_hash = $1', [hashToken(token)]))?.id);
    },

    async listWatches(accountId) {
      const rows = (await db.query('SELECT * FROM watches WHERE account_id = $1 ORDER BY id', [accountId])).map(watchRow);
      if (rows.length === 0) return [];
      const points = await db.query(
        `SELECT watch_id, price FROM (
           SELECT watch_id, price, id, row_number() OVER (PARTITION BY watch_id ORDER BY id DESC) AS rank
           FROM price_points WHERE watch_id = ANY($1::int[])
         ) recent WHERE rank <= $2 ORDER BY id`,
        [rows.map((row) => row.id), HISTORY_SENT],
      );
      const history = new Map();
      for (const point of points) {
        const id = int(point.watch_id);
        if (!history.has(id)) history.set(id, []);
        history.get(id).push(int(point.price));
      }
      return rows.map((row) => publicWatch(row, history.get(row.id) ?? []));
    },

    countWatches,

    async addWatch(accountId, input) {
      const row = await one(
        `INSERT INTO watches
           (account_id, player_name, card_version, platform, source_ref, identity, target_price, above_price, created_at)
         SELECT $1::int, $2::text, $3::text, $4::text, $5::text, $6::text, $7::int, $10::int, $8::bigint
         WHERE (SELECT count(*) FROM watches WHERE account_id = $1::int) < $9::int
         ON CONFLICT (account_id, identity, platform) DO NOTHING
         RETURNING *`,
        [accountId, input.playerName, input.cardVersion, input.platform, input.sourceRef,
          identityOf(input), input.targetPrice ?? null, now(), maxWatches, input.abovePrice ?? null],
      );
      if (row) return publicWatch(watchRow(row));
      if (await countWatches(accountId) >= maxWatches) {
        throw new ApiError(409, `You can watch up to ${maxWatches} players.`);
      }
      throw new ApiError(409, 'You are already watching this card on that platform.');
    },

    // In `patch`, an undefined price is left alone and null clears it. Changing a price, or resuming,
    // re-arms that alert so it can fire again.
    async updateWatch(accountId, id, patch) {
      const setUnder = patch.targetPrice !== undefined;
      const setAbove = patch.abovePrice !== undefined;
      const row = await one(
        `UPDATE watches SET
           target_price = CASE WHEN $3::boolean THEN $4::int ELSE target_price END,
           above_price = CASE WHEN $5::boolean THEN $6::int ELSE above_price END,
           paused = COALESCE($7::boolean, paused),
           armed = CASE WHEN $3::boolean OR $7::boolean = FALSE THEN TRUE ELSE armed END,
           armed_above = CASE WHEN $5::boolean OR $7::boolean = FALSE THEN TRUE ELSE armed_above END
         WHERE id = $1 AND account_id = $2
         RETURNING id`,
        [id, accountId, setUnder, patch.targetPrice ?? null, setAbove, patch.abovePrice ?? null, patch.paused ?? null],
      );
      if (!row) throw new ApiError(404, 'Player not found.');
    },

    async deleteWatch(accountId, id) {
      const row = await one('DELETE FROM watches WHERE id = $1 AND account_id = $2 RETURNING id', [id, accountId]);
      if (!row) throw new ApiError(404, 'Player not found.');
    },

    async getWatchFor(accountId, id) {
      const row = await one('SELECT * FROM watches WHERE id = $1 AND account_id = $2', [id, accountId]);
      return row ? watchRow(row) : null;
    },

    async activeWatches(ids = null) {
      const rows = ids
        ? await db.query('SELECT * FROM watches WHERE paused = FALSE AND id = ANY($1::int[]) ORDER BY id', [ids])
        : await db.query('SELECT * FROM watches WHERE paused = FALSE ORDER BY id');
      return rows.map(watchRow);
    },

    // Records a price and returns the alerts it fired: one when it goes strictly under the under price,
    // one when it goes strictly over the above price, each only while that alert is armed. An alert
    // re-arms once the price is back on the other side of its line. The checks run inside the
    // statements, so prices edited mid-check are respected and two checks cannot both fire.
    async recordPrice(row, price, at) {
      const fire = (direction) => one(
        `WITH fired AS (
           UPDATE watches SET ${direction === 'under' ? 'armed' : 'armed_above'} = FALSE
           WHERE id = $1 AND paused = FALSE AND ${direction === 'under'
    ? 'armed = TRUE AND target_price IS NOT NULL AND $2::int < target_price'
    : 'armed_above = TRUE AND above_price IS NOT NULL AND $2::int > above_price'}
           RETURNING id, account_id, player_name, card_version, platform,
             ${direction === 'under' ? 'target_price' : 'above_price'} AS line
         )
         INSERT INTO alerts
           (account_id, watch_id, player_name, card_version, platform, price, target_price, created_at, direction)
         SELECT account_id, id, player_name, card_version, platform, $2::int, line, $3::bigint, '${direction}'
         FROM fired
         RETURNING *`,
        [row.id, price, at],
      );
      const alerts = [await fire('under'), await fire('above')].filter(Boolean).map(alertFromRow);

      await db.query(
        `UPDATE watches SET current_price = $2::int,
           armed = (target_price IS NULL OR $2::int >= target_price),
           armed_above = (above_price IS NULL OR $2::int <= above_price),
           last_checked = $3::bigint, last_error = NULL
         WHERE id = $1 AND paused = FALSE`,
        [row.id, price, at],
      );
      if (row.current_price !== price) {
        await db.query(
          `INSERT INTO price_points (watch_id, at, price)
           SELECT $1::int, $2::bigint, $3::int WHERE EXISTS (SELECT 1 FROM watches WHERE id = $1::int)`,
          [row.id, at, price],
        );
        await db.query(
          `DELETE FROM price_points WHERE watch_id = $1 AND id < (
             SELECT id FROM price_points WHERE watch_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1
           )`,
          [row.id, HISTORY_KEPT - 1],
        );
      }
      return alerts;
    },

    async recordError(id, message, at) {
      await db.query('UPDATE watches SET last_checked = $2, last_error = $3 WHERE id = $1', [id, at, message]);
    },

    async listAlerts(accountId) {
      const rows = await db.query('SELECT * FROM alerts WHERE account_id = $1 ORDER BY id DESC LIMIT $2', [accountId, ALERTS_SENT]);
      return rows.map(alertFromRow);
    },

    unreadAlerts: (accountId) => count('SELECT count(*) AS n FROM alerts WHERE account_id = $1 AND read_at IS NULL', [accountId]),

    async markAlertsRead(accountId) {
      await db.query('UPDATE alerts SET read_at = $2 WHERE account_id = $1 AND read_at IS NULL', [accountId, now()]);
    },

    async saveSubscription(accountId, { endpoint, p256dh, auth }) {
      const saved = await one(
        `INSERT INTO push_subscriptions (endpoint, account_id, p256dh, auth, created_at)
         SELECT $1::text, $2::int, $3::text, $4::text, $5::bigint
         WHERE EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = $1::text AND account_id = $2::int)
            OR (SELECT count(*) FROM push_subscriptions WHERE account_id = $2::int) < $6::int
         ON CONFLICT (endpoint) DO UPDATE
           SET account_id = EXCLUDED.account_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth
         RETURNING endpoint`,
        [endpoint, accountId, p256dh, auth, now(), MAX_DEVICES],
      );
      if (!saved) throw new ApiError(409, `You can connect up to ${MAX_DEVICES} devices.`);
    },

    subscriptionsFor: (accountId) => db.query('SELECT * FROM push_subscriptions WHERE account_id = $1', [accountId]),
    countSubscriptions: (accountId) => count('SELECT count(*) AS n FROM push_subscriptions WHERE account_id = $1', [accountId]),

    async deleteSubscription(endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    },

    async deleteOwnSubscription(accountId, endpoint) {
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND account_id = $2', [endpoint, accountId]);
    },

    async getSetting(key) {
      return (await one('SELECT value FROM settings WHERE key = $1', [key]))?.value ?? null;
    },

    async setSetting(key, value) {
      await db.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        [key, value],
      );
    },

    async setSettingIfAbsent(key, value) {
      await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
    },
  };
}
