// Transfer-market style price steps, used to keep demo prices realistic.
export const MIN_PRICE = 150;
export const MAX_PRICE = 15_000_000;
export const MIN_TARGET = 200;

export function stepFor(price) {
  if (price < 1_000) return 50;
  if (price < 10_000) return 100;
  if (price < 50_000) return 250;
  if (price < 100_000) return 500;
  return 1_000;
}

const clamp = (price) => Math.min(MAX_PRICE, Math.max(MIN_PRICE, price));

export function snap(price) {
  const bounded = clamp(price);
  const step = stepFor(bounded);
  return clamp(Math.round(bounded / step) * step);
}

// A valid ladder price roughly 3% under the target, always strictly below it.
export function priceBelow(target) {
  const raw = clamp(Math.floor(target * 0.97));
  const step = stepFor(raw);
  let value = Math.floor(raw / step) * step;
  if (value >= target) value -= step;
  return clamp(value);
}
