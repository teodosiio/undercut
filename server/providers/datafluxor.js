const BASE = {
  production: 'https://datafluxor.com/api/v1/fut',
  sandbox: 'https://datafluxor.com/api/fut-sandbox',
};
const MARKETS = {
  console: { param: 'ps', market: 'console' },
  pc: { param: 'pc', market: 'pc' },
};
const MAX_BATCH = 500;
const SEARCH_TTL_MS = 5 * 60_000;
const MAX_CACHED_SEARCHES = 500;
const EA_ID = /^[1-9]\d{0,11}$/;

function describeStatus(status) {
  if (status === 401 || status === 403) return 'DataFluxor rejected the API key';
  if (status === 402) return 'DataFluxor monthly request allowance is used up';
  if (status === 429) return 'DataFluxor rate limit reached';
  return `DataFluxor returned HTTP ${status}`;
}

// A price can trigger an alert only when the source marks it current and listed.
function usablePrice(row, market, sandbox) {
  if (!Number.isSafeInteger(row.price) || row.price <= 0) return null;
  if (row.stale === true || row.pending === true || row.availability !== 'listed') return null;
  // The sandbox returns the same fixed console rows for every platform.
  if (!sandbox && row.market !== market) return null;
  return row.price;
}

const displayPrice = (quote) => (Number.isSafeInteger(quote?.lowest) && quote.lowest > 0 ? quote.lowest : null);
const text = (value, fallback, max) => String(value || fallback).slice(0, max);

export function createDataFluxorProvider({
  apiKey = '',
  sandbox = false,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  now = Date.now,
}) {
  if (!sandbox && !apiKey) {
    throw new Error('DATAFLUXOR_API_KEY is required, or set DATAFLUXOR_SANDBOX=1 for sample data');
  }
  const base = sandbox ? BASE.sandbox : BASE.production;
  const searches = new Map();

  async function request(path) {
    const response = await fetchImpl(`${base}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: 'application/json',
        ...(sandbox ? {} : { 'x-api-key': apiKey }),
      },
    });
    if (!response.ok) throw new Error(describeStatus(response.status));
    const body = await response.json();
    if (!body?.success || !body.data) throw new Error('DataFluxor returned an unexpected response');
    return body.data;
  }

  return {
    id: 'datafluxor',
    label: sandbox ? 'DataFluxor sandbox' : 'DataFluxor prices',
    live: !sandbox,
    requiresRef: true,
    notice: sandbox
      ? { title: 'Sandbox prices.', text: 'This is fixed DataFluxor sample data, not real FC 27 market prices.' }
      : null,

    isValidRef: (ref) => EA_ID.test(ref),

    async getPrices(items) {
      const result = new Map();
      for (const [platform, { param, market }] of Object.entries(MARKETS)) {
        const keyById = new Map(items
          .filter((item) => item.platform === platform && EA_ID.test(item.ref))
          .map((item) => [item.ref, item.key]));
        const ids = [...keyById.keys()];

        for (let start = 0; start < ids.length; start += MAX_BATCH) {
          const batch = ids.slice(start, start + MAX_BATCH).join(',');
          const data = await request(`/prices?ea_ids=${batch}&platform=${param}`);
          for (const row of data.items ?? []) {
            const key = keyById.get(String(row.ea_id));
            const price = key ? usablePrice(row, market, sandbox) : null;
            if (price !== null) result.set(key, price);
          }
        }
      }
      return result;
    },

    async searchCards(query) {
      const normalized = query.normalize('NFC').trim().toLocaleLowerCase();
      const cached = searches.get(normalized);
      if (cached && now() - cached.at < SEARCH_TTL_MS) return cached.cards;

      const data = await request(`/cards/search?q=${encodeURIComponent(normalized)}&limit=8`);
      const cards = (data.cards ?? [])
        .filter((card) => EA_ID.test(String(card.ea_id)) && !card.replaced)
        .map((card) => ({
          ref: String(card.ea_id),
          name: text(card.name, 'Unknown player', 60),
          version: text(card.rarity_name || card.rarity, 'Standard', 40),
          rating: Number.isInteger(card.rating) ? card.rating : null,
          position: text(card.position, '', 8),
          club: text(card.club, '', 40),
          prices: { console: displayPrice(card.price), pc: displayPrice(card.price_pc) },
        }));

      if (searches.size >= MAX_CACHED_SEARCHES) searches.clear();
      searches.set(normalized, { at: now(), cards });
      return cards;
    },
  };
}
