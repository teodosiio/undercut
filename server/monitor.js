const isValidPrice = (price) => Number.isSafeInteger(price) && price > 0;

export const priceKey = (row) =>
  `${row.platform}:${row.source_ref || `${row.player_name}|${row.card_version}`.toLocaleLowerCase()}`;

// Alerts fire once when a price goes strictly under target, then re-arm when it recovers.
// That rule lives in store.recordPrice so it is applied atomically in the database.
export function createMonitor({ store, provider, push, log = console, now = Date.now }) {
  let tail = Promise.resolve();

  async function runOnce(watchIds) {
    const full = !watchIds;
    const watches = await store.activeWatches(watchIds);
    let result;

    if (watches.length === 0) {
      result = { at: now(), ok: true, checked: 0, failed: 0, alerts: 0 };
    } else {
      const items = new Map();
      for (const row of watches) {
        const key = priceKey(row);
        if (!items.has(key)) {
          items.set(key, {
            key,
            ref: row.source_ref,
            platform: row.platform,
            playerName: row.player_name,
            cardVersion: row.card_version,
            targetPrice: row.target_price,
          });
        }
      }

      let prices = null;
      try {
        prices = await provider.getPrices([...items.values()]);
      } catch (error) {
        const at = now();
        log.error('Price check failed:', error.message);
        for (const row of watches) await store.recordError(row.id, 'Price source unavailable', at);
        result = { at, ok: false, checked: 0, failed: watches.length, alerts: 0 };
      }

      if (prices) {
        const at = now();
        const fired = [];
        let checked = 0;
        let failed = 0;
        for (const row of watches) {
          const price = prices.get(priceKey(row));
          if (!isValidPrice(price)) {
            await store.recordError(row.id, 'No price available', at);
            failed += 1;
            continue;
          }
          const alert = await store.recordPrice(row, price, at);
          if (alert) fired.push(alert);
          checked += 1;
        }
        await Promise.allSettled(fired.map((alert) => push.sendAlert(alert)));
        result = { at, ok: failed === 0, checked, failed, alerts: fired.length };
      }
    }

    if (full) await store.setSetting('monitor.lastRun', JSON.stringify(result));
    return result;
  }

  return {
    // With watchIds, checks only those (for a player just added or edited).
    run({ watchIds = null } = {}) {
      const result = tail.then(() => runOnce(watchIds));
      tail = result.catch((error) => log.error('Monitor run failed:', error));
      return result;
    },
    async lastRun() {
      const saved = await store.getSetting('monitor.lastRun');
      return saved ? JSON.parse(saved) : null;
    },
  };
}
