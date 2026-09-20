import { describe, expect, it } from 'vitest';
import {
  detectCurrency, isPlaceholder, LOW_STOCK_THRESHOLD, parsePriceText,
  parseStockText, stockFromQuantity,
} from '../src/scraper/parse.js';

describe('parsePriceText — the store renders one price six different ways', () => {
  // Every string here was produced by the store's own formatter, read out of its
  // bundle in Phase 1 and confirmed in captured pages.
  const cases: [label: string, input: string, expected: number][] = [
    ['plain en-IN grouping', '₹1,29,249', 129_249],
    ['spaced', '₹1 29 249', 129_249],
    ['euro (dots group, comma decimates)', '₹1.29.249,00', 129_249],
    ['trailing prose', '₹1,29,249/- (incl. of all taxes)', 129_249],
    ['full-width digits', '₹１,２９,２４９', 129_249],
    ['lakh with Rs. and NBSP', 'Rs.\u00A01,29,249.00', 129_249],
    ['zero-width joiner between every character', '₹\u00A0\u200B1\u00A0\u200B,\u00A0\u200B2\u00A0\u200B9\u00A0\u200B,\u00A0\u200B2\u00A0\u200B4\u00A0\u200B9', 129_249],
    ['whitespace and newlines', '\n   ₹1,29,249   \n', 129_249],
    ['small price, two decimals', '₹499.50', 499.5],
  ];

  for (const [label, input, expected] of cases) {
    it(`reads the ${label}`, () => {
      expect(parsePriceText(input)?.value).toBe(expected);
    });
  }

  it('keeps the currency it found', () => {
    expect(parsePriceText('₹1,29,249')?.currency).toBe('INR');
    expect(parsePriceText('Rs. 1,29,249.00')?.currency).toBe('INR');
    expect(parsePriceText('$1,299.00')?.currency).toBe('USD');
  });

  it('returns null rather than a guess for anything that is not a reading', () => {
    for (const junk of ['', '—', '--', 'Loading…', 'N/A', '₹0.00', '$0.00', '₹', 'Price hidden', '   ']) {
      expect(parsePriceText(junk), `expected null for ${JSON.stringify(junk)}`).toBeNull();
    }
  });

  it('never returns zero as a value', () => {
    expect(parsePriceText('₹0')).toBeNull();
    expect(parsePriceText('0')).toBeNull();
  });
});

describe('isPlaceholder', () => {
  it("recognises the store's idle and in-flight markers", () => {
    for (const s of ['—', '--', 'Loading…', 'Updating…', 'N/A', 'Price hidden', '₹0.00', '']) {
      expect(isPlaceholder(s), s).toBe(true);
    }
  });

  it('does not swallow a real reading', () => {
    for (const s of ['₹1,29,249', 'Rs. 1,29,249.00', '₹499.50']) {
      expect(isPlaceholder(s), s).toBe(false);
    }
  });
});

describe('detectCurrency', () => {
  it('falls back only when there is nothing to go on', () => {
    expect(detectCurrency('1,29,249')).toBe('INR');
    expect(detectCurrency('1,29,249', 'USD')).toBe('USD');
  });
});

describe("parseStockText — the store's full observed vocabulary", () => {
  // These five phrasings are chosen by the store using `quantity % 5`, so the wording
  // carries no information about scarcity. Only the number does. That is why every
  // one of these maps by quantity rather than by tone.
  const cases: [input: string, status: string, qty: number | null][] = [
    ['In stock · 151 left', 'in_stock', 151],
    ['Only 151 left', 'in_stock', 151],
    ['151 in stock', 'in_stock', 151],
    ['Selling fast — 151 left', 'in_stock', 151],
    ['Hurry, just 151 left', 'in_stock', 151],
    ['Only 3 left', 'low_stock', 3],
    ['Selling fast — 1 left', 'low_stock', 1],
    ['Out of stock', 'out_of_stock', 0],
    ['In stock', 'in_stock', null],
  ];

  for (const [input, status, qty] of cases) {
    it(`"${input}" → ${status}`, () => {
      const parsed = parseStockText(input);
      expect(parsed.status).toBe(status);
      expect(parsed.quantity).toBe(qty);
    });
  }

  it('maps wording it has never seen to unknown, and keeps the raw string', () => {
    const parsed = parseStockText('Dispatch window: ask the seller');
    expect(parsed.status).toBe('unknown');
    expect(parsed.raw).toBe('Dispatch window: ask the seller');
  });

  it('never coerces unfamiliar wording to in_stock', () => {
    // The tempting shortcut — "it did not say out of stock, so it must be available" —
    // is exactly how a tracker ends up reporting stock for something nobody can buy.
    for (const s of ['Ships when restocked', 'Enquire for availability', 'Temporarily on hold']) {
      expect(parseStockText(s).status, s).not.toBe('in_stock');
    }
  });

  it('treats an empty string as unknown, not as out of stock', () => {
    expect(parseStockText('').status).toBe('unknown');
    expect(parseStockText(null).status).toBe('unknown');
  });
});

describe('stockFromQuantity', () => {
  it('uses the quantity as the authority', () => {
    expect(stockFromQuantity(0)).toBe('out_of_stock');
    expect(stockFromQuantity(1)).toBe('low_stock');
    expect(stockFromQuantity(LOW_STOCK_THRESHOLD)).toBe('low_stock');
    expect(stockFromQuantity(LOW_STOCK_THRESHOLD + 1)).toBe('in_stock');
    expect(stockFromQuantity(151)).toBe('in_stock');
  });

  it('refuses to classify a negative or non-finite quantity', () => {
    expect(stockFromQuantity(-1)).toBe('unknown');
    expect(stockFromQuantity(Number.NaN)).toBe('unknown');
  });
});
