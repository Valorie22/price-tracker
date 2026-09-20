/**
 * Guardrails.
 *
 * Nothing reaches `price_history` without passing every check here. The contract is
 * asymmetric on purpose: a gap in the chart is a correct description of a scrape that
 * did not work; a wrong point is a lie that survives forever. So the rejection path
 * is cheap and the acceptance path is strict.
 */
import { KNOWN_CURRENCIES, type StockStatus } from './parse.js';
import { ScrapeError, type ErrorCode } from './errors.js';

export const MAX_PLAUSIBLE_PRICE = 1_000_000;

export interface CandidateReading {
  price: number;
  currency: string;
  stockStatus: StockStatus;
  stockQuantity: number | null;
  /** The exact wording the store used for stock, if we read it from text. */
  stockRaw?: string;
  mrp?: number | null;
  /**
   * True when `price` and `mrp` came out of one atomic payload rather than two
   * separate elements. The API strategy sets it; anything reading a rendered page
   * does not, because picking two numbers out of a block that contains five of them
   * is exactly where an inverted read happens.
   */
  atomic?: boolean;
  /** The store's own "this figure is not final" flag, when the strategy can see it. */
  pending?: boolean;
  /** Name/slug/sku the page claimed, for the identity check. */
  identity?: { name?: string; slug?: string; sku?: string; id?: string };
}

export interface ValidationContext {
  /** What we are tracking, for the identity check. */
  expect: { storeProductId: string; name: string; slug?: string | null; sku?: string | null };
  /** Most recent accepted price, if any. */
  lastKnownPrice: number | null;
  /** Fractional change beyond which a reading needs a second opinion. */
  maxDeltaRatio: number;
}

export type ValidationOutcome =
  | { ok: true; flags: { largeDelta: boolean; unmappedStock: boolean }; deltaRatio: number | null }
  | { ok: false; error: ScrapeError; needsSecondOpinion: boolean; deltaRatio: number | null };

function reject(code: ErrorCode, message: string, needsSecondOpinion = false, deltaRatio: number | null = null): ValidationOutcome {
  return { ok: false, error: new ScrapeError(code, message), needsSecondOpinion, deltaRatio };
}

/** Loose match: the store renders names with the same words, occasionally reordered. */
function identityMatches(expect: ValidationContext['expect'], got: CandidateReading['identity']): boolean {
  if (!got) return true; // strategy could not read an identity; other checks still apply
  if (got.id && got.id !== expect.storeProductId) return false;
  if (got.sku && expect.sku && got.sku.toUpperCase() !== expect.sku.toUpperCase()) return false;
  if (got.slug && expect.slug && got.slug !== expect.slug) return false;
  if (got.name) {
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const a = new Set(norm(got.name).split(' ').filter(Boolean));
    const b = new Set(norm(expect.name).split(' ').filter(Boolean));
    if (b.size === 0) return true;
    let hits = 0;
    for (const word of b) if (a.has(word)) hits++;
    // Two thirds of the tracked product's words must appear on the page we read.
    return hits / b.size >= 0.66;
  }
  return true;
}

export function validateReading(reading: CandidateReading, ctx: ValidationContext): ValidationOutcome {
  // 1. The store's own "not final yet" flag.
  //    Phase 1 found `pending` arrives with a price ~22% below the real one, under the
  //    variant name `stale`. The store renders it greyed out with an "Updating…" label —
  //    it is telling us not to use it. We listen. Retrying gets the real figure.
  if (reading.pending === true) {
    return reject('STALE_QUOTE', 'Store served a pending/stale quote; retrying for a settled figure', false, null);
  }

  // 2. Price is a number in a plausible range.
  if (!Number.isFinite(reading.price)) {
    return reject('PARSE_MISS', `Price did not parse to a finite number (got ${String(reading.price)})`);
  }
  if (reading.price <= 0) {
    return reject('PLACEHOLDER', `Price of ${reading.price} is a placeholder, not a reading`);
  }
  if (reading.price >= MAX_PLAUSIBLE_PRICE) {
    return reject('VALIDATION_REJECT', `Price ${reading.price} is above the plausible ceiling of ${MAX_PLAUSIBLE_PRICE}`);
  }

  // 3. Currency is one we recognise.
  if (!KNOWN_CURRENCIES.has(reading.currency)) {
    return reject('VALIDATION_REJECT', `Unrecognised currency "${reading.currency}"`);
  }

  // 4. MRP sanity, for readings assembled from a page.
  //
  //    The store's price block holds five numbers: two hidden decoys, a struck-through
  //    MRP, a "Deal price" line and the real figure. A selector that drifts one element
  //    can come back with the MRP as the price and something smaller as the MRP — an
  //    inverted read that looks entirely plausible on its own. A price above its own
  //    list price is the signature of that mistake.
  //
  //    Skipped when the two figures came out of one payload: the store is the authority
  //    on its own numbers, and a genuine price rise past an old MRP is the store's
  //    business, not a parsing error.
  if (
    !reading.atomic &&
    reading.mrp != null &&
    Number.isFinite(reading.mrp) &&
    reading.mrp > 0 &&
    reading.price > reading.mrp * 1.02
  ) {
    return reject(
      'VALIDATION_REJECT',
      `Price ${reading.price} exceeds the list price ${reading.mrp} on the same page; the two figures did not come from where we think they did`,
    );
  }

  // 5. Identity: are we still reading the product we think we are tracking?
  if (!identityMatches(ctx.expect, reading.identity)) {
    return reject(
      'IDENTITY_MISMATCH',
      `Page identity ${JSON.stringify(reading.identity)} does not match tracked product "${ctx.expect.name}" (${ctx.expect.storeProductId})`,
    );
  }

  // 6. Continuity with history.
  let deltaRatio: number | null = null;
  if (ctx.lastKnownPrice != null && ctx.lastKnownPrice > 0) {
    deltaRatio = Math.abs(reading.price - ctx.lastKnownPrice) / ctx.lastKnownPrice;
    if (deltaRatio > ctx.maxDeltaRatio) {
      // Not a rejection yet — a demand for a second opinion from a different strategy.
      return {
        ok: false,
        error: new ScrapeError(
          'VALIDATION_REJECT',
          `Price moved ${(deltaRatio * 100).toFixed(1)}% (${ctx.lastKnownPrice} → ${reading.price}), above the ${(ctx.maxDeltaRatio * 100).toFixed(0)}% threshold`,
        ),
        needsSecondOpinion: true,
        deltaRatio,
      };
    }
  }

  // 7. Stock. `unknown` is allowed through — it is an honest reading of wording we do
  //    not recognise — but it is flagged so the raw string reaches the log.
  const unmappedStock = reading.stockStatus === 'unknown';

  return { ok: true, flags: { largeDelta: false, unmappedStock }, deltaRatio };
}

/**
 * Do two independent readings of the same product agree?
 *
 * Used to settle a large move: if a second strategy sees the same number, the move is
 * real and gets stored with `large_delta`. If not, nothing is stored.
 */
export function readingsAgree(a: number, b: number, tolerance = 0.01): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= tolerance;
}
