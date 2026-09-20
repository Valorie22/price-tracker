import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.resolve(here, '../../recon/fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

export function jsonFixture<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

/**
 * Every fixture in `recon/fixtures/` is a real response captured from
 * https://demo.inelabteamdev.com during Phase 1, except the seven marked `derived`,
 * which are that same real capture transformed in one specific way so a hostile case
 * can be tested deterministically. Each says what was changed.
 */
export const FIXTURES = {
  servedShell: 'served-shell.html',                   // real: what the server actually returns
  renderedIdle: 'rendered-idle.html',                 // real: price hidden, button disabled
  renderedLoading: 'rendered-loading.html',           // real: "Loading current price…" mid-flight
  renderedSuccess: 'rendered-success.html',           // real: settled, lakh format (Rs. 1,29,249.00)
  renderedSuccess2: 'rendered-success-2.html',        // real: same product, plain format, new rotating class
  renderedError503: 'rendered-error-503.html',        // real: forced 503s past the store's own retry budget
  structureChanged: 'rendered-structure-changed.html',// derived: class family -z6 -> -q1, euro price shape
  priceSplit: 'rendered-price-split.html',            // derived: one <span> per character + zero-width joiners
  absurdPrice: 'rendered-absurd-price.html',          // derived: price replaced with ₹9,99,99,999
  unknownStock: 'rendered-unknown-stock.html',        // derived: stock wording outside the known vocabulary
  outOfStock: 'rendered-out-of-stock.html',           // derived: "Out of stock"
  ssrJsonLd: 'ssr-jsonld.html',                       // derived: hypothetical SSR page with schema.org Offer
  ssrNextData: 'ssr-next-data.html',                  // derived: hypothetical SSR page with __NEXT_DATA__
  apiLayout: 'api-layout.json',                       // real
  apiProduct: 'api-product-15.json',                  // real
  apiCatalog: 'api-catalog.json',                     // real
  apiChallenge: 'api-challenge.json',                 // real
  apiProduct404: 'api-product-404.json',              // real: {"status":404,"body":{"error":"not_found"}}
  apiPrice401: 'api-price-401.json',                  // real: {"status":401,"body":{"error":"unauthorized"}}
} as const;

/** The true price of product 15 at capture time, confirmed by API and by DOM. */
export const TRUE_PRICE = 129_249;
/** The decoys the store hides in the same block. None of these is the price. */
export const DECOY_PRICES = [97_111, 114_234];
/** The struck-through list price and the "Deal price" line. Also not the price. */
export const MRP = 157_621;
export const SALE_LINE = 143_435;
