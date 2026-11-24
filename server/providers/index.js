import { createDataFluxorProvider } from './datafluxor.js';
import { createFeedProvider } from './feed.js';
import { createFutGenieProvider } from './futgenie.js';
import { createSimulatedProvider } from './simulated.js';

// `state` is a small key-value store (backed by the database) for providers that must remember
// things across server instances, such as a pause requested by the price source.
export function createProvider(config, { state = null } = {}) {
  switch (config.priceProvider) {
    case 'simulated':
      return createSimulatedProvider();
    case 'futgenie':
      return createFutGenieProvider({ state });
    case 'datafluxor':
      return createDataFluxorProvider({
        apiKey: config.dataFluxorKey,
        sandbox: config.dataFluxorSandbox,
      });
    case 'feed':
      return createFeedProvider({ url: config.feedUrl, token: config.feedToken });
    default:
      throw new Error(`Unknown PRICE_PROVIDER "${config.priceProvider}"`);
  }
}
