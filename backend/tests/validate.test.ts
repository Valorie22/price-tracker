import { describe, expect, it } from 'vitest';
import { readingsAgree, validateReading, type CandidateReading, type ValidationContext } from '../src/scraper/validate.js';
import { TRUE_PRICE } from './fixtures.js';

const expected: ValidationContext['expect'] = {
  storeProductId: '15',
  name: 'Nordkraft Slimbook Pro',
  slug: 'nordkraft-slimbook-pro',
  sku: 'NOR-10015',
};

const reading = (over: Partial<CandidateReading> = {}): CandidateReading => ({
  price: TRUE_PRICE,
  currency: 'INR',
  stockStatus: 'in_stock',
  stockQuantity: 151,
  mrp: 157_621,
  pending: false,
  identity: { name: 'Nordkraft Slimbook Pro', slug: 'nordkraft-slimbook-pro', sku: 'NOR-10015', id: '15' },
  ...over,
});

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  expect: expected,
  lastKnownPrice: null,
  maxDeltaRatio: 0.7,
  ...over,
});

describe('validateReading — what may be written', () => {
  it('accepts a clean reading', () => {
    const result = validateReading(reading(), ctx());
    expect(result.ok).toBe(true);
  });

  it('accepts a normal-sized move against history', () => {
    const result = validateReading(reading({ price: 165_813, mrp: 197_396 }), ctx({ lastKnownPrice: TRUE_PRICE }));
    expect(result.ok).toBe(true);
  });

  it('lets an unrecognised stock status through, flagged rather than guessed', () => {
    const result = validateReading(reading({ stockStatus: 'unknown', stockQuantity: null }), ctx());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flags.unmappedStock).toBe(true);
  });
});

describe('validateReading — what may not', () => {
  it('rejects a pending/stale quote outright', () => {
    // The store serves these with a figure roughly 22% below the real one, under the
    // variant name `stale`, and renders them greyed out with "Updating…". Storing one
    // would put a phantom price drop in the history that never happened.
    const result = validateReading(reading({ pending: true, price: 128_644 }), ctx({ lastKnownPrice: 165_813 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('STALE_QUOTE');
      expect(result.needsSecondOpinion).toBe(false); // retry, do not ask a different strategy
    }
  });

  it('rejects zero and negative prices as placeholders', () => {
    for (const price of [0, -1]) {
      const result = validateReading(reading({ price }), ctx());
      expect(result.ok, `price ${price}`).toBe(false);
    }
  });

  it('rejects a price above the plausible ceiling', () => {
    const result = validateReading(reading({ price: 99_999_999 }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_REJECT');
  });

  it('rejects a non-finite price', () => {
    const result = validateReading(reading({ price: Number.NaN }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('PARSE_MISS');
  });

  it('rejects an unrecognised currency', () => {
    const result = validateReading(reading({ currency: 'XYZ' }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_REJECT');
  });

  it('rejects a page-derived price that sits above its own list price', () => {
    // The signature of an inverted read: the selector drifted onto the struck-through
    // MRP and took something smaller for the list price.
    const result = validateReading(reading({ price: 200_000, mrp: 157_621, atomic: false }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_REJECT');
  });

  it('allows the same shape when both figures came from one atomic payload', () => {
    // A genuine price rise past a stale list price is the store's business. The API
    // strategy reads both numbers out of one decrypted object, so they cannot be mixed up.
    const result = validateReading(reading({ price: 200_000, mrp: 157_621, atomic: true }), ctx());
    expect(result.ok).toBe(true);
  });

  it('rejects a reading from a page that is not the tracked product', () => {
    const result = validateReading(
      reading({ identity: { name: 'Helix Turntable Lite', slug: 'helix-turntable-lite', sku: 'HEL-10326', id: '326' } }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('IDENTITY_MISMATCH');
  });
});

describe('validateReading — the large-move guard', () => {
  it('asks for a second opinion instead of accepting a move beyond the threshold', () => {
    const result = validateReading(reading({ price: 9_000 }), ctx({ lastKnownPrice: TRUE_PRICE }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.needsSecondOpinion).toBe(true);
      expect(result.deltaRatio).toBeGreaterThan(0.7);
    }
  });

  it('does not ask for one on the very first reading, when there is no history to compare', () => {
    const result = validateReading(reading({ price: 9_000 }), ctx({ lastKnownPrice: null }));
    expect(result.ok).toBe(true);
  });

  it('respects a configured threshold', () => {
    const tight = validateReading(reading({ price: 150_000 }), ctx({ lastKnownPrice: TRUE_PRICE, maxDeltaRatio: 0.1 }));
    expect(tight.ok).toBe(false);
    const loose = validateReading(reading({ price: 150_000 }), ctx({ lastKnownPrice: TRUE_PRICE, maxDeltaRatio: 0.9 }));
    expect(loose.ok).toBe(true);
  });
});

describe('readingsAgree', () => {
  it('accepts two readings within a percent of each other', () => {
    expect(readingsAgree(129_249, 129_249)).toBe(true);
    expect(readingsAgree(129_249, 129_600)).toBe(true);
  });

  it('rejects readings that are meaningfully apart', () => {
    expect(readingsAgree(129_249, 97_111)).toBe(false);
  });

  it('refuses to call two impossible numbers an agreement', () => {
    expect(readingsAgree(0, 0)).toBe(false);
    expect(readingsAgree(Number.NaN, Number.NaN)).toBe(false);
  });
});
