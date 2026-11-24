// Connects to a price API you are authorized to use. See "Connect live prices" in README.md.
export function createFeedProvider({ url, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!url) throw new Error('PRICE_FEED_URL is required when PRICE_PROVIDER=feed');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('PRICE_FEED_URL must use http or https');
  }

  return {
    id: 'feed',
    label: 'Live price feed',
    live: true,
    requiresRef: true,

    async getPrices(items) {
      const response = await fetchImpl(parsed, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          items: items.map(({ key, ref, platform }) => ({ key, ref, platform })),
        }),
      });
      if (!response.ok) throw new Error(`Price feed returned HTTP ${response.status}`);

      const body = await response.json();
      const prices = body?.prices;
      if (!prices || typeof prices !== 'object') throw new Error('Price feed response has no prices');

      const result = new Map();
      for (const item of items) {
        if (Object.hasOwn(prices, item.key)) result.set(item.key, prices[item.key]);
      }
      return result;
    },
  };
}
