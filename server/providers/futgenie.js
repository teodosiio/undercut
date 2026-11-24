// Reads prices from FUTGenie's public pages, slowly and with an honest user agent.
// FUTGenie's robots.txt allows all bots. Its internal API is not used.
//
// - Card pages (/player-items/{id}) identify a card from the link the user pastes.
// - The players list (/players?f={...}) is FUTGenie's own filterable page. It carries each card's
//   console or PC price with the time it was recorded, which is what alerts use.
const ORIGIN = 'https://www.futgenie.gg';
const USER_AGENT = 'Undercut/0.1 (student price-alert project; low-rate personal use)';
const MIN_GAP_MS = 3_000;
const PAGE_TTL_MS = 60_000;
const MAX_CHECKS_PER_RUN = 20;
const MAX_PRICE_AGE_MS = 3 * 3_600_000;
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
const COOLDOWN_MS = 30 * 60_000;
const MAX_COOLDOWN_MS = 6 * 3_600_000;
const LISTING_SIZE = 96;
const PAUSE_KEY = 'futgenie.pausedUntil';
const QUERIES_KEY = 'futgenie.queries';
const PLATFORMS = ['console', 'pc'];
const CARD_ID = /^[1-9]\d{0,9}$/;
const UNIT_MS = {
  second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000,
};
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' };

const decode = (text) => text.replace(/&(?:amp|quot|#x27|#39|lt|gt);/g, (entity) => ENTITIES[entity]);

export function parseCardRef(input) {
  const text = String(input ?? '').trim();
  if (CARD_ID.test(text)) return text;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!['futgenie.gg', 'www.futgenie.gg'].includes(url.hostname.toLowerCase())) return null;
  const match = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?player-items\/(\d{1,10})\/?$/i.exec(url.pathname);
  return match && CARD_ID.test(match[1]) ? match[1] : null;
}

// Next.js streams page data as JSON string chunks inside script tags.
function flightText(html) {
  let text = '';
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      text += JSON.parse(match[1]);
    } catch {
      // Skip a malformed chunk rather than fail the whole page.
    }
  }
  return text;
}

function balancedJson(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function* jsonArraysAfter(flight, marker) {
  for (let at = flight.indexOf(marker); at !== -1; at = flight.indexOf(marker, at + marker.length)) {
    try {
      const value = JSON.parse(balancedJson(flight, at + marker.length - 1));
      if (Array.isArray(value)) yield value;
    } catch {
      // Not the block we want. Keep looking.
    }
  }
}

function updatedAgeMs(html) {
  const match = />\s*Updated (just now|(\d+|an?|one) (second|minute|hour|day|week|month)s? ago)\s*</i.exec(html);
  if (!match) return null;
  if (match[1].toLowerCase() === 'just now') return 0;
  const count = /^\d+$/.test(match[2]) ? Number(match[2]) : 1;
  return count * UNIT_MS[match[3].toLowerCase()];
}

// A card page: used to identify a pasted link, with its console price for display.
export function parseCardPage(html, { cacheAgeMs = 0 } = {}) {
  const title = decode(/<meta property="og:title" content="([^"]{1,240})"/.exec(html)?.[1] ?? '');
  const titleMatch = /^(.+?) (\d{2,3}) (.+?): Price & Stats \(FC \d{2}\)$/.exec(title);
  if (!titleMatch) return null;

  const description = decode(/<meta name="description" content="([^"]{1,400})"/.exec(html)?.[1] ?? '');
  let latest = null;
  for (const series of jsonArraysAfter(flightText(html), '"series":[')) {
    const points = series.find((entry) => entry?.id === 'console')?.points;
    if (Array.isArray(points)) {
      latest = points.at(-1);
      break;
    }
  }
  const age = updatedAgeMs(html);
  const fresh = age !== null && age + cacheAgeMs <= MAX_PRICE_AGE_MS;

  return {
    name: titleMatch[1].slice(0, 60),
    rating: Number(titleMatch[2]),
    version: titleMatch[3].slice(0, 40),
    position: /\d{2,3} OVR ([A-Z]{2,4})\b/.exec(description)?.[1] ?? '',
    prices: {
      console: fresh && Number.isSafeInteger(latest?.v) && latest.v > 0 ? latest.v : null,
      pc: null,
    },
  };
}

// The players list: card id -> { price, recordedAt } for the platform the page was filtered to.
export function parseListing(html, platform) {
  const found = new Map();
  for (const items of jsonArraysAfter(flightText(html), '"items":[')) {
    for (const item of items) {
      const entry = item?.itemPrices?.find?.((price) => price?.platform === platform);
      if (!Number.isSafeInteger(item?.id) || !entry) continue;
      found.set(String(item.id), {
        price: entry.price,
        recordedAt: Date.parse(String(entry.recordedAt ?? '').replace(/^\$D/, '')),
      });
    }
  }
  return found;
}

// FUTGenie's name filter matches real names, so shortened card names like "Manuel Franc. dos Santos"
// need a fallback: the longest run of unabbreviated words, then the last word.
export function nameQueries(name) {
  const tokens = String(name).split(/\s+/).filter(Boolean);
  const runs = [];
  let run = [];
  for (const token of tokens) {
    if (token.endsWith('.')) {
      if (run.length) runs.push(run.join(' '));
      run = [];
    } else {
      run.push(token);
    }
  }
  if (run.length) runs.push(run.join(' '));
  const longestRun = runs.sort((a, b) => b.length - a.length)[0];
  const lastWord = tokens.at(-1)?.replace(/\.$/, '');
  return [...new Set([tokens.join(' '), longestRun, lastWord])].filter((query) => query && query.length >= 2);
}

function freshPrice(entry, now) {
  if (!entry || !Number.isSafeInteger(entry.price) || entry.price <= 0) return null;
  if (!Number.isFinite(entry.recordedAt)) return null;
  const age = now - entry.recordedAt;
  return age <= MAX_PRICE_AGE_MS && age >= -MAX_CLOCK_SKEW_MS ? entry.price : null;
}

export function createFutGenieProvider({
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  log = console,
  state = null,
} = {}) {
  const pages = new Map();
  const workingQuery = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = -Infinity;
  let pausedUntil = 0;
  let queriesLoaded = false;

  // On Vercel each run may be a fresh instance, so a pause and the searches that worked are stored.
  async function syncState() {
    if (!state) return;
    pausedUntil = Math.max(pausedUntil, Number(await state.get(PAUSE_KEY)) || 0);
    if (!queriesLoaded) {
      queriesLoaded = true;
      try {
        for (const [ref, query] of Object.entries(JSON.parse((await state.get(QUERIES_KEY)) ?? '{}'))) {
          if (!workingQuery.has(ref)) workingQuery.set(ref, query);
        }
      } catch {
        // A damaged value only costs extra searches.
      }
    }
  }

  // One request at a time, spaced out, cached briefly, and paused when FUTGenie pushes back.
  async function load(path, parse) {
    const cached = pages.get(path);
    if (cached && now() - cached.at < PAGE_TTL_MS) return cached.value;
    if (now() < pausedUntil) throw new Error('FUTGenie asked Undercut to slow down, so checks are paused');

    const wait = lastRequestAt + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();

    const response = await fetchImpl(`${ORIGIN}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
    });

    if ([403, 429, 503].includes(response.status)) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : COOLDOWN_MS;
      pausedUntil = now() + Math.min(pause, MAX_COOLDOWN_MS);
      await state?.set(PAUSE_KEY, String(pausedUntil)).catch((error) => log.error('FUTGenie pause not saved:', error.message));
      throw new Error(`FUTGenie returned HTTP ${response.status}, so checks are paused`);
    }
    let value = null;
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`FUTGenie returned HTTP ${response.status}`);
      const cacheAgeMs = (Number(response.headers.get('age')) || 0) * 1_000;
      value = parse(await response.text(), cacheAgeMs);
    }
    if (pages.size >= 200) pages.clear();
    pages.set(path, { at: now(), value });
    return value;
  }

  function serial(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  const loadCard = (id) => serial(() => load(
    `/player-items/${id}`,
    (html, cacheAgeMs) => parseCardPage(html, { cacheAgeMs }),
  ));

  const loadListing = (platform, playerName) => {
    const filter = JSON.stringify({ platform, playerName, take: LISTING_SIZE });
    return serial(() => load(`/players?f=${encodeURIComponent(filter)}`, (html) => parseListing(html, platform)));
  };

  return {
    id: 'futgenie',
    label: 'FUTGenie prices',
    live: true,
    requiresRef: true,
    platforms: PLATFORMS,
    notice: null,
    credit: { text: 'Prices from FUTGenie', url: 'https://www.futgenie.gg/players' },
    search: {
      label: 'FUTGenie card link',
      placeholder: 'futgenie.gg/player-items/…',
      hint: 'Find the card on futgenie.gg/players, then paste its link here.',
      empty: 'That link does not match a FUTGenie card.',
    },

    isValidRef: (ref) => CARD_ID.test(ref),

    async getPrices(items) {
      await syncState();
      const knownQueries = JSON.stringify([...workingQuery]);
      const checks = new Map();
      for (const item of items) {
        if (!PLATFORMS.includes(item.platform) || !CARD_ID.test(item.ref) || !item.playerName) continue;
        const id = `${item.platform}|${item.ref}`;
        if (!checks.has(id)) checks.set(id, { ...item, keys: [] });
        checks.get(id).keys.push(item.key);
      }
      if (checks.size > MAX_CHECKS_PER_RUN) {
        log.error(`FUTGenie: checking the first ${MAX_CHECKS_PER_RUN} of ${checks.size} cards`);
      }

      const result = new Map();
      for (const check of [...checks.values()].slice(0, MAX_CHECKS_PER_RUN)) {
        const queries = [...new Set([workingQuery.get(check.ref), ...nameQueries(check.playerName)])]
          .filter(Boolean);
        let entry;
        try {
          for (const query of queries) {
            entry = (await loadListing(check.platform, query))?.get(check.ref);
            if (entry) {
              workingQuery.set(check.ref, query);
              break;
            }
          }
        } catch (error) {
          if (now() < pausedUntil) throw error;
          log.error(`FUTGenie ${check.platform} ${check.ref}:`, error.message);
          continue;
        }
        const price = freshPrice(entry, now());
        if (price !== null) for (const key of check.keys) result.set(key, price);
      }
      if (state && JSON.stringify([...workingQuery]) !== knownQueries) {
        await state.set(QUERIES_KEY, JSON.stringify(Object.fromEntries(workingQuery)))
          .catch((error) => log.error('FUTGenie searches not saved:', error.message));
      }
      return result;
    },

    async searchCards(query) {
      const ref = parseCardRef(query);
      if (!ref) return [];
      await syncState();
      const card = await loadCard(ref);
      if (!card) return [];
      return [{
        ref,
        name: card.name,
        version: card.version,
        rating: card.rating,
        position: card.position,
        club: '',
        prices: card.prices,
      }];
    },
  };
}
