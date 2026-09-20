/**
 * Normalisation: text the store rendered → numbers and enums we are willing to store.
 *
 * The API strategy gets numbers directly and skips almost all of this. It exists for
 * the DOM and browser strategies, which have to survive the store's display layer —
 * and that layer is deliberately hostile. Phase 1 observed the store rendering the
 * same price in six different ways at random (STORE_NOTES.md §5):
 *
 *   ''        ₹1,65,813
 *   spaced    ₹1 65 813
 *   euro      ₹1.65.813,00                 ← dots group, comma decimates
 *   trailing  ₹1,65,813/- (incl. of all taxes)
 *   unicode   ₹１,６５,８１３                 ← full-width digits
 *   nbsp      ₹<NBSP><ZWSP>1<NBSP><ZWSP>,…  ← invisible joiner between every character
 *   lakh      Rs. 1,65,813.00
 *
 * and, independently, splitting the price across one `<span>` per character.
 */

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';

/** At or below this many units we call it low stock. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Values that look like data but are not.
 *
 * Treated as misses, never as readings. A `₹0` is not a free product; it is the
 * store not having answered yet.
 */
const PLACEHOLDER_TEXTS = new Set([
  '', '-', '--', '---', '—', '–', '．', '.', '…', '...',
  'n/a', 'na', 'tbd', 'loading', 'loading…', 'loading...', 'updating', 'updating…',
  'price hidden', 'check price', 'see price', 'reveal price', '--.--', '0', '0.00',
]);

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

export function isPlaceholder(raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined) return true;
  const cleaned = raw.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\u00A0/g, ' ').trim().toLowerCase();
  if (cleaned === '') return true;
  if (PLACEHOLDER_TEXTS.has(cleaned)) return true;
  // A currency symbol with nothing behind it, e.g. "₹", "₹ —", "$0.00".
  const digitsOnly = cleaned.replace(/[^0-9]/g, '');
  if (digitsOnly === '' || /^0+$/.test(digitsOnly)) return true;
  return false;
}

export interface ParsedPrice {
  value: number;
  currency: string;
  /** Which of the store's rendering variants this text looked like. */
  shape: string;
}

export function detectCurrency(raw: string, fallback = 'INR'): string {
  const text = raw.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase();
  if (text.includes('₹') || /\brs\.?\b/.test(text) || text.includes('inr')) return 'INR';
  if (text.includes('€') || text.includes('eur')) return 'EUR';
  if (text.includes('£') || text.includes('gbp')) return 'GBP';
  if (text.includes('$') || text.includes('usd')) return 'USD';
  return fallback;
}

/**
 * Parse any of the store's price renderings into a number.
 *
 * Returns `null` for a miss — never a guess, and never 0. The caller treats null
 * as "this strategy did not produce a reading" and moves to the next one.
 */
export function parsePriceText(raw: string | null | undefined, fallbackCurrency = 'INR'): ParsedPrice | null {
  if (raw === null || raw === undefined) return null;

  // NFKC folds full-width digits (１２３ → 123) and the ﹒ style variants.
  let text = raw.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\u00A0/g, ' ');
  const currency = detectCurrency(text, fallbackCurrency);

  if (isPlaceholder(text)) return null;

  // Drop the "/- (incl. of all taxes)" tail and any other trailing prose.
  text = text.replace(/\/-.*$/, ' ').replace(/\((?:[^)]*)\)/g, ' ');
  // Drop currency markers and any letters.
  text = text.replace(/[₹$€£]/g, ' ').replace(/[A-Za-z.]{2,}/g, ' ');

  // Keep digits and separators only.
  const token = text.match(/[0-9][0-9\s.,']*[0-9]|[0-9]/);
  if (!token) return null;
  let numeric = token[0].trim();

  const shape = classifyShape(raw, numeric);

  // Decide what the final separator means. Two digits after it → decimal point;
  // three → thousands group. This is what tells ₹1.65.813,00 from Rs. 1,65,813.00.
  const lastSepIndex = Math.max(numeric.lastIndexOf(','), numeric.lastIndexOf('.'));
  if (lastSepIndex >= 0) {
    const tail = numeric.slice(lastSepIndex + 1);
    if (/^\d{1,2}$/.test(tail)) {
      const intPart = numeric.slice(0, lastSepIndex).replace(/[\s.,']/g, '');
      numeric = `${intPart}.${tail}`;
    } else {
      numeric = numeric.replace(/[\s.,']/g, '');
    }
  } else {
    numeric = numeric.replace(/[\s']/g, '');
  }

  const value = Number.parseFloat(numeric);
  if (!Number.isFinite(value) || value <= 0) return null;

  return { value, currency, shape };
}

function classifyShape(raw: string, numeric: string): string {
  if (/[\u200B\u00A0]/.test(raw) && raw.replace(ZERO_WIDTH, '').length < raw.length) return 'nbsp';
  if (/[０-９]/.test(raw)) return 'unicode';
  if (/\/-/.test(raw)) return 'trailing';
  if (/\brs\.?/i.test(raw)) return 'lakh';
  if (/\d\.\d{3}.*,\d{2}\s*$/.test(numeric)) return 'euro';
  if (/\d\s\d{2}/.test(numeric)) return 'spaced';
  return 'plain';
}

// --- stock -------------------------------------------------------------------

/**
 * The store's full observed stock vocabulary, lifted from its own bundle and
 * confirmed in rendered pages. The wording is chosen by `quantity % 5`, so it
 * carries no information about scarcity — only the quantity does. Wording is used
 * to recognise the *sentence*; the number decides the enum.
 */
export const STOCK_PATTERNS: { re: RegExp; status: StockStatus | 'by_quantity' }[] = [
  { re: /out\s*of\s*stock/i, status: 'out_of_stock' },
  { re: /sold\s*out|unavailable|currently\s+not\s+available/i, status: 'out_of_stock' },
  { re: /in\s*stock\s*[·\-–—]\s*(\d[\d,]*)\s*left/i, status: 'by_quantity' },
  { re: /only\s+(\d[\d,]*)\s+left/i, status: 'by_quantity' },
  { re: /selling\s+fast\s*[—\-–]\s*(\d[\d,]*)\s+left/i, status: 'by_quantity' },
  { re: /hurry,?\s*just\s+(\d[\d,]*)\s+left/i, status: 'by_quantity' },
  { re: /(\d[\d,]*)\s+in\s+stock/i, status: 'by_quantity' },
  { re: /(\d[\d,]*)\s+left/i, status: 'by_quantity' },
  { re: /back\s*order/i, status: 'out_of_stock' },
  { re: /pre[\s-]?order/i, status: 'out_of_stock' },
  { re: /\bin\s*stock\b/i, status: 'in_stock' },
  { re: /\bavailable\b/i, status: 'in_stock' },
];

export interface ParsedStock {
  status: StockStatus;
  quantity: number | null;
  /** The exact words the store used, kept so unmapped wording can be reviewed. */
  raw: string;
}

/** Quantity → enum. Authoritative when we have a number. */
export function stockFromQuantity(quantity: number): StockStatus {
  if (!Number.isFinite(quantity) || quantity < 0) return 'unknown';
  if (quantity === 0) return 'out_of_stock';
  if (quantity <= LOW_STOCK_THRESHOLD) return 'low_stock';
  return 'in_stock';
}

/**
 * Parse a stock sentence.
 *
 * Wording that matches nothing maps to `unknown` and the raw string is kept for
 * the log. It is never coerced to `in_stock`: "probably available" is a guess, and
 * a guess in the history is the failure this project is graded on avoiding.
 */
export function parseStockText(raw: string | null | undefined): ParsedStock {
  const text = (raw ?? '').normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\u00A0/g, ' ').trim();
  if (text === '') return { status: 'unknown', quantity: null, raw: '' };

  for (const { re, status } of STOCK_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (status === 'by_quantity') {
      const qty = Number.parseInt((m[1] ?? '').replace(/,/g, ''), 10);
      if (!Number.isFinite(qty)) return { status: 'unknown', quantity: null, raw: text };
      return { status: stockFromQuantity(qty), quantity: qty, raw: text };
    }
    return { status, quantity: status === 'out_of_stock' ? 0 : null, raw: text };
  }

  return { status: 'unknown', quantity: null, raw: text };
}

/** Currencies we are willing to write to the database. */
export const KNOWN_CURRENCIES = new Set(['INR', 'USD', 'EUR', 'GBP']);
