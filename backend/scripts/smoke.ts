/**
 * Offline-friendly smoke check: runs the strategy chain against the live store with
 * no database, printing what each strategy did. Used during development and by CI's
 * "does the store still behave the way Phase 1 measured?" step.
 *
 *   npx tsx backend/scripts/smoke.ts 15
 */
import { setPretty, createLogger } from '../src/lib/logger.js';
import { apiStrategy } from '../src/scraper/strategies/api.js';
import { domStrategy } from '../src/scraper/strategies/dom.js';
import { embeddedJsonStrategy } from '../src/scraper/strategies/embeddedJson.js';
import { validateReading } from '../src/scraper/validate.js';
import { closeFetcher } from '../src/scraper/fetcher.js';
import { fetchProduct } from '../src/scraper/storeClient.js';
import type { StrategyContext } from '../src/scraper/strategies/types.js';

setPretty(true);
const log = createLogger({ script: 'smoke' });
const id = process.argv[2] ?? '15';

const product = await fetchProduct(id);
const ctx: StrategyContext = {
  storeProductId: String(product.id),
  expect: { storeProductId: String(product.id), name: product.name, slug: product.slug, sku: product.sku },
  attempt: 1,
  onStage: (s, d) => log.info(`  · ${s}`, d),
};

for (const strategy of [apiStrategy, embeddedJsonStrategy, domStrategy]) {
  const t0 = Date.now();
  try {
    const r = await strategy.run(ctx);
    const v = validateReading(r.reading, { expect: ctx.expect, lastKnownPrice: null, maxDeltaRatio: 0.7 });
    log.info(`${strategy.name}: reading`, {
      ms: Date.now() - t0, price: r.reading.price, currency: r.reading.currency,
      stock: r.reading.stockStatus, qty: r.reading.stockQuantity, pending: r.reading.pending,
      valid: v.ok, reject: v.ok ? undefined : v.error.code,
      fingerprint: r.fingerprint.fingerprint, meta: r.meta,
    });
  } catch (err) {
    log.warn(`${strategy.name}: missed`, { ms: Date.now() - t0, code: (err as { code?: string }).code, msg: (err as Error).message });
  }
}
await closeFetcher();
