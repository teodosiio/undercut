import { priceBelow, snap } from '../ladder.js';

// Demo data only. These prices are generated locally and are not market prices.
export function createSimulatedProvider({ random = Math.random } = {}) {
  const prices = new Map();
  const forced = new Map();

  return {
    id: 'simulated',
    label: 'Demo prices',
    live: false,
    requiresRef: false,
    notice: { title: 'Demo prices.', text: 'These numbers are simulated and are not real FC 27 market prices.' },

    async getPrices(items) {
      const result = new Map();
      for (const item of items) {
        let price;
        if (forced.has(item.key)) {
          price = forced.get(item.key);
          forced.delete(item.key);
        } else if (prices.has(item.key)) {
          price = snap(prices.get(item.key) * (1 + (random() - 0.5) * 0.03));
        } else {
          price = snap(item.targetPrice * (1.06 + random() * 0.18));
        }
        prices.set(item.key, price);
        result.set(item.key, price);
      }
      return result;
    },

    forceDrop(key, targetPrice) {
      forced.set(key, priceBelow(targetPrice));
    },
  };
}
