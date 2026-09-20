/**
 * Extraction, against pages actually captured from the store.
 *
 * The single most important test in this file is "ignores the decoy nodes". The store
 * puts five numbers in the price block — two hidden decoys, a struck-through MRP, a
 * "Deal price" line and the real figure — and the two most obvious selectors a scraper
 * would reach for (`.price-value` and `[data-price]`) are both traps.
 */
import { describe, expect, it } from 'vitest';
import { extractFromHtml } from '../src/scraper/strategies/dom.js';
import { collectJsonBlobs, findReading } from '../src/scraper/strategies/embeddedJson.js';
import { computeFingerprint, describeStructureChange } from '../src/scraper/fingerprint.js';
import type { StoreLayout } from '../src/scraper/storeClient.js';
import { DECOY_PRICES, FIXTURES, MRP, SALE_LINE, TRUE_PRICE, fixture, jsonFixture } from './fixtures.js';

const layout = jsonFixture<StoreLayout>(FIXTURES.apiLayout);

describe('extractFromHtml — happy path', () => {
  it('reads the settled price from a real captured page', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    expect(got.blockPhase).toBe('success');
    expect(got.price).toBe(TRUE_PRICE);
    expect(got.currency).toBe('INR');
    expect(got.matchedSelectors.length).toBeGreaterThan(0);
  });

  it('ignores the decoy nodes, the MRP and the sale line', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    for (const decoy of DECOY_PRICES) expect(got.price).not.toBe(decoy);
    expect(got.price).not.toBe(MRP);
    expect(got.price).not.toBe(SALE_LINE);
  });

  it('picks up the struck-through figure as the MRP, not as the price', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    expect(got.mrp).toBe(MRP);
    expect(got.price).toBeLessThan(got.mrp as number);
  });

  it('reads the stock sentence and maps it by quantity', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    expect(got.stock.quantity).toBe(151);
    expect(got.stock.status).toBe('in_stock');
  });

  it('gets the same number from a second capture rendered in a different format', () => {
    // Same product, minutes apart: the store used the plain shape instead of `lakh`
    // and gave the price node a new random class. The reading must not move.
    const a = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    const b = extractFromHtml(fixture(FIXTURES.renderedSuccess2), layout);
    expect(a.price).toBe(b.price);
  });
});

describe('extractFromHtml — states that are not readings', () => {
  it('returns no price for the served shell, because there is nothing in it', () => {
    const got = extractFromHtml(fixture(FIXTURES.servedShell), null);
    expect(got.blockPhase).toBe('absent');
    expect(got.price).toBeNull();
  });

  it('returns no price while the store is still loading it', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedLoading), layout);
    expect(got.blockPhase).toBe('loading');
    expect(got.price).toBeNull();
  });

  it('returns no price from the idle "Price hidden" state', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedIdle), layout);
    expect(got.blockPhase).toBe('idle');
    expect(got.price).toBeNull();
  });

  it('returns no price when the store gave up after its own retries', () => {
    const got = extractFromHtml(fixture(FIXTURES.renderedError503), layout);
    expect(got.blockPhase).toBe('error');
    expect(got.price).toBeNull();
  });
});

describe('extractFromHtml — the store moves things around', () => {
  it('still finds the price after the whole class family is renamed', () => {
    // -z6 → -q1 everywhere, and the price re-rendered in the euro shape. The published
    // class no longer matches, so this exercises the positional and style-based
    // candidates further down the selector list.
    const got = extractFromHtml(fixture(FIXTURES.structureChanged), null);
    expect(got.price).toBe(TRUE_PRICE);
  });

  it('reassembles a price split across one span per character', () => {
    const got = extractFromHtml(fixture(FIXTURES.priceSplit), layout);
    expect(got.price).toBe(TRUE_PRICE);
  });

  it('reads stock wording it does not recognise as unknown, keeping the words', () => {
    const got = extractFromHtml(fixture(FIXTURES.unknownStock), layout);
    expect(got.stock.status).toBe('unknown');
    expect(got.stock.raw).toContain('Dispatch window');
    expect(got.price).toBe(TRUE_PRICE); // the price is still readable
  });

  it('reads an out-of-stock badge', () => {
    const got = extractFromHtml(fixture(FIXTURES.outOfStock), layout);
    expect(got.stock.status).toBe('out_of_stock');
    expect(got.stock.quantity).toBe(0);
  });
});

describe('embedded JSON strategy', () => {
  it('finds nothing in the served shell, and says so rather than inventing a reading', () => {
    const blobs = collectJsonBlobs(fixture(FIXTURES.servedShell));
    expect(blobs).toHaveLength(0);
    expect(findReading(blobs)).toBeNull();
  });

  it('reads a schema.org Offer', () => {
    const reading = findReading(collectJsonBlobs(fixture(FIXTURES.ssrJsonLd)));
    expect(reading?.price).toBe(TRUE_PRICE);
    expect(reading?.currency).toBe('INR');
    expect(reading?.stockStatus).toBe('in_stock');
  });

  it('reads a __NEXT_DATA__ blob', () => {
    const reading = findReading(collectJsonBlobs(fixture(FIXTURES.ssrNextData)));
    expect(reading?.price).toBe(TRUE_PRICE);
    expect(reading?.stockQuantity).toBe(151);
    expect(reading?.stockStatus).toBe('in_stock');
  });
});

describe('structure fingerprinting', () => {
  it('is stable across two captures of the same store shape', () => {
    const a = extractFromHtml(fixture(FIXTURES.renderedSuccess), layout);
    const b = extractFromHtml(fixture(FIXTURES.renderedSuccess2), layout);
    const fa = computeFingerprint({ strategy: 'dom', layout, matchedSelectors: a.matchedSelectors, ancestorPath: a.ancestorPath ?? '' });
    const fb = computeFingerprint({ strategy: 'dom', layout, matchedSelectors: b.matchedSelectors, ancestorPath: b.ancestorPath ?? '' });
    // The per-render random class (`vcla9xn` vs `vkru3i3`) is stripped before hashing;
    // without that, every single page load would look like a breaking change.
    expect(fa.fingerprint).toBe(fb.fingerprint);
  });

  it('changes when the store changes its published layout', () => {
    const moved: StoreLayout = {
      ...layout,
      variant: 7,
      priceCarrier: 'split',
      classes: Object.fromEntries(Object.entries(layout.classes).map(([k, v]) => [k, v.replace('-z6', '-q1')])),
    };
    const before = computeFingerprint({ strategy: 'api', layout, quoteKeys: ['price', 'mrp'] });
    const after = computeFingerprint({ strategy: 'api', layout: moved, quoteKeys: ['price', 'mrp'] });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it('describes what moved, in words a person can act on', () => {
    const before = computeFingerprint({ strategy: 'api', layout, quoteKeys: ['price'] });
    const after = computeFingerprint({
      strategy: 'api',
      layout: { ...layout, priceCarrier: 'split', variant: 9 },
      quoteKeys: ['price', 'surcharge'],
    });
    const description = describeStructureChange(before.details, after.details);
    expect(description).toContain('priceCarrier');
    expect(description).toContain('surcharge');
  });
});
