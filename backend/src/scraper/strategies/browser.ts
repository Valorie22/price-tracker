/**
 * Strategy 4 — render the page and read what a person would see.
 *
 * Last in the chain, and deliberately so. It is the only strategy that costs a
 * browser process, and Phase 1 showed it is never needed for a healthy store: the
 * JSON path answers in ~600 ms. It earns its place as insurance — if the store's
 * private API changes shape, this path keeps working from the rendered pixels — and
 * as the engine behind the observable run, where watching it work is the point.
 *
 * Extraction reuses `extractFromHtml` from the DOM strategy, so the rendered page and
 * a server-rendered one go through exactly one set of selectors. The decoy handling,
 * the six price formats and the stock vocabulary are written once.
 */
import { computeFingerprint } from '../fingerprint.js';
import { ScrapeError, toScrapeError } from '../errors.js';
import { env } from '../../lib/env.js';
import { getBrowserContext, installStoreRouting, isBrowserAvailable, revealPrice, type BrowserOptions } from '../browser.js';
import { extractFromHtml } from './dom.js';
import { fetchLayout, productUrl, type StoreLayout } from '../storeClient.js';
import type { Strategy, StrategyContext, StrategyResult } from './types.js';

let browserAvailable: boolean | null = null;

void isBrowserAvailable().then((v) => {
  browserAvailable = v;
});

/** Options the headed runner sets; the cron path leaves these alone. */
let runtimeOptions: BrowserOptions = {};
export function configureBrowserStrategy(opts: BrowserOptions): void {
  runtimeOptions = opts;
}

export async function runBrowserExtraction(
  storeProductId: string,
  ctx: Pick<StrategyContext, 'onStage'> & { simulate?: BrowserOptions['simulate']; attempt?: number },
  opts: BrowserOptions = {},
): Promise<StrategyResult> {
  const started = Date.now();
  const merged: BrowserOptions = { ...runtimeOptions, ...opts };
  if (ctx.simulate !== undefined) merged.simulate = ctx.simulate;

  const context = await getBrowserContext(merged);
  const page = await context.newPage();

  try {
    await installStoreRouting(page, merged, ctx.attempt ?? 1);
    await merged.onPage?.(page);

    ctx.onStage?.('browser:navigating', { url: productUrl(storeProductId) });
    const response = await page.goto(productUrl(storeProductId), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const httpStatus = response?.status() ?? 0;

    await revealPrice(page, { ...(ctx.onStage ? { onStage: ctx.onStage } : {}) });

    const html = await page.content();

    let layout: StoreLayout | null = null;
    try {
      layout = await fetchLayout();
    } catch {
      /* fingerprint detail only */
    }

    const extraction = extractFromHtml(html, layout);
    const fingerprint = computeFingerprint({
      strategy: 'browser',
      layout,
      matchedSelectors: extraction.matchedSelectors,
      ...(extraction.ancestorPath ? { ancestorPath: extraction.ancestorPath } : {}),
    });

    if (extraction.price === null) {
      throw new ScrapeError(
        'PARSE_MISS',
        `Rendered page settled in phase "${extraction.blockPhase}" but no figure could be read from it`,
        { httpStatus },
      );
    }

    ctx.onStage?.('browser:extracted', {
      price: extraction.price,
      stock: extraction.stock.raw,
      shape: extraction.priceShape,
    });

    return {
      reading: {
        price: extraction.price,
        currency: extraction.currency,
        stockStatus: extraction.stock.status,
        stockQuantity: extraction.stock.quantity,
        stockRaw: extraction.stock.raw,
        mrp: extraction.mrp,
        pending: extraction.pending,
        identity: { ...extraction.identity, id: storeProductId },
      },
      httpStatus,
      fingerprint,
      durationMs: Date.now() - started,
      meta: {
        priceShape: extraction.priceShape,
        blockPhase: extraction.blockPhase,
        matched: extraction.matchedSelectors,
        renderedBytes: html.length,
        simulate: merged.simulate ?? null,
      },
    };
  } catch (err) {
    throw toScrapeError(err);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export const browserStrategy: Strategy = {
  name: 'browser',

  available: () => env.browserFallbackEnabled && browserAvailable !== false,

  async run(ctx: StrategyContext): Promise<StrategyResult> {
    if (!env.browserFallbackEnabled) {
      throw new ScrapeError('BROWSER_UNAVAILABLE', 'Browser fallback is disabled (set BROWSER_FALLBACK_ENABLED=true)');
    }
    if (browserAvailable === null) browserAvailable = await isBrowserAvailable();
    if (!browserAvailable) {
      throw new ScrapeError('BROWSER_UNAVAILABLE', 'Playwright browsers are not installed in this environment');
    }
    return runBrowserExtraction(ctx.storeProductId, ctx, { ...(ctx.simulate ? { simulate: ctx.simulate } : {}) });
  },
};
