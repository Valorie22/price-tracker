/**
 * Strategy 1 — the store's own JSON.
 *
 * This is the primary path and it wins essentially every time: ~600 ms, a few kB,
 * no browser. It also sidesteps the entire display layer, so none of the store's
 * six price-rendering tricks can produce a wrong number here — we read `p` as an
 * integer, not `₹1.65.813,00` as a string.
 *
 * What it cannot sidestep is the `pending` flag. Phase 1 caught the store returning
 * a settled-looking quote 22% below the true price, marked `pending: 1` under the
 * variant name `stale` (3 of 29 successful fetches). That is handled in validate.ts,
 * not here: this strategy reports what it saw, including the flag, and the guardrail
 * decides. Strategies observe; validation judges.
 */
import { computeFingerprint } from '../fingerprint.js';
import { stockFromQuantity } from '../parse.js';
import { fetchLayout, fetchProduct, fetchQuote, type StoreLayout, type StoreProduct } from '../storeClient.js';
import type { Strategy, StrategyContext, StrategyResult } from './types.js';

/**
 * The layout document describes the whole store, not one product, and Phase 1 saw it
 * hold the same revision across every sample. Caching it for a minute keeps a run of
 * N products from making N identical requests into a rate limiter that Phase 1 showed
 * is easy to trip.
 */
let layoutCache: { at: number; value: StoreLayout } | null = null;
const LAYOUT_TTL_MS = 60_000;

async function cachedLayout(): Promise<StoreLayout | null> {
  if (layoutCache && Date.now() - layoutCache.at < LAYOUT_TTL_MS) return layoutCache.value;
  try {
    const value = await fetchLayout();
    layoutCache = { at: Date.now(), value };
    return value;
  } catch {
    // The layout is used for fingerprinting and for DOM selector hints. Losing it
    // degrades change detection; it must never fail a scrape that otherwise worked.
    return layoutCache?.value ?? null;
  }
}

export function resetLayoutCache(): void {
  layoutCache = null;
}

/** Product metadata within one run: identity check input, and dashboard detail. */
const productCache = new Map<string, { at: number; value: StoreProduct }>();
const PRODUCT_TTL_MS = 5 * 60_000;

async function cachedProduct(id: string): Promise<StoreProduct | null> {
  const hit = productCache.get(id);
  if (hit && Date.now() - hit.at < PRODUCT_TTL_MS) return hit.value;
  try {
    const value = await fetchProduct(id);
    productCache.set(id, { at: Date.now(), value });
    return value;
  } catch (err) {
    // A 404 here is meaningful — the product is gone — so it is rethrown for the
    // engine to classify. Anything else degrades to "no identity data".
    if ((err as { code?: string }).code === 'PRODUCT_GONE') throw err;
    return null;
  }
}

export const apiStrategy: Strategy = {
  name: 'api',
  available: () => true,

  async run(ctx: StrategyContext): Promise<StrategyResult> {
    const started = Date.now();
    ctx.onStage?.('strategy:api');

    const [layout, product] = await Promise.all([cachedLayout(), cachedProduct(ctx.storeProductId)]);
    const { quote, httpStatus, trace } = await fetchQuote(ctx.storeProductId, { onStage: ctx.onStage });

    const fingerprint = computeFingerprint({
      strategy: 'api',
      layout,
      quoteKeys: ['price', 'mrp', 'salePrice', 'badgePct', 'stockQuantity', 'currency', 'rating', 'ratingCount', 'seller', 'deliveryDays', 'pending', 'format', 'triple'].filter(
        (k) => (quote as unknown as Record<string, unknown>)[k] !== undefined,
      ),
    });

    return {
      reading: {
        price: quote.price,
        currency: quote.currency,
        stockStatus: stockFromQuantity(quote.stockQuantity),
        stockQuantity: quote.stockQuantity,
        stockRaw: `quantity=${quote.stockQuantity}`,
        mrp: quote.mrp,
        pending: quote.pending,
        identity: product
          ? { name: product.name, slug: product.slug, sku: product.sku, id: String(product.id) }
          : { id: ctx.storeProductId },
      },
      httpStatus,
      fingerprint,
      durationMs: Date.now() - started,
      meta: {
        variant: quote.variant,
        format: quote.format,
        triple: quote.triple,
        pending: quote.pending,
        rating: quote.rating,
        ratingCount: quote.ratingCount,
        seller: quote.seller,
        deliveryDays: quote.deliveryDays,
        badgePct: quote.badgePct,
        salePrice: quote.salePrice,
        quotedAt: quote.quotedAt,
        handshake: trace,
        productName: product?.name ?? null,
        productSpecs: product?.specs ?? null,
      },
    };
  },
};
