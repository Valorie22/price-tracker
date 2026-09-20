/**
 * Strategy 2 — state blobs embedded in the HTML.
 *
 * `__NEXT_DATA__`, `__NUXT__`, `window.__INITIAL_STATE__`, `<script type="application/json">`
 * and schema.org JSON-LD `Offer` blocks. When a store server-renders, this is the
 * cheapest correct reading available: no selectors to break, no formatting to undo.
 *
 * Against today's INE store it finds nothing, because the served HTML is a 459-byte
 * client-rendered shell. That is reported as a clean `PARSE_MISS` and the chain moves
 * on — it costs one already-fetched document and no extra request. It stays in the
 * chain because the store is a Vite SPA today and the cost of it becoming server-rendered
 * tomorrow is one code path that already exists and is already tested.
 */
import { computeFingerprint } from '../fingerprint.js';
import { ScrapeError } from '../errors.js';
import { isPlaceholder, parsePriceText, parseStockText, stockFromQuantity, type StockStatus } from '../parse.js';
import { fetchProductHtml } from '../storeClient.js';
import type { Strategy, StrategyContext, StrategyResult } from './types.js';

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

interface Blob {
  source: string;
  value: unknown;
}

/** Every JSON document we can find in the page, tagged with where it came from. */
export function collectJsonBlobs(html: string): Blob[] {
  const blobs: Blob[] = [];
  SCRIPT_RE.lastIndex = 0;

  for (let m = SCRIPT_RE.exec(html); m !== null; m = SCRIPT_RE.exec(html)) {
    const attrs = m[1] ?? '';
    const body = (m[2] ?? '').trim();
    if (body === '') continue;

    const typeMatch = /type\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const type = typeMatch?.[1]?.toLowerCase() ?? '';
    const idMatch = /id\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const id = idMatch?.[1] ?? '';

    if (type === 'application/ld+json' || type === 'application/json' || id === '__NEXT_DATA__') {
      try {
        blobs.push({ source: id || type, value: JSON.parse(body) });
      } catch {
        /* a malformed blob is not a reason to fail the page */
      }
      continue;
    }

    // `window.__NUXT__ = {...}` / `window.__INITIAL_STATE__ = {...}` / `self.__next_f.push`
    const assign = /(?:window|self|globalThis)\.(__[A-Z_]+__|__NUXT__)\s*=\s*/.exec(body);
    if (assign) {
      const start = body.indexOf('{', assign.index + assign[0].length - 1);
      if (start >= 0) {
        const json = balancedSlice(body, start);
        if (json) {
          try {
            blobs.push({ source: assign[1] ?? 'inline-state', value: JSON.parse(json) });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  return blobs;
}

/** Take `{...}` from `start`, respecting nesting and strings. */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") inString = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const PRICE_KEYS = ['price', 'currentprice', 'saleprice', 'lowprice', 'amount', 'p', 'shown', 'value'];
const CURRENCY_KEYS = ['pricecurrency', 'currency', 'currencycode', 'c'];
const STOCK_KEYS = ['availability', 'stockstatus', 'instock', 'stock', 's', 'inventory', 'quantity'];

export interface EmbeddedReading {
  price: number;
  currency: string;
  stockStatus: StockStatus;
  stockQuantity: number | null;
  stockRaw: string;
  source: string;
  path: string;
}

/** Depth-first walk looking for an object that carries a price and, ideally, a currency. */
export function findReading(blobs: Blob[]): EmbeddedReading | null {
  for (const blob of blobs) {
    const found = walk(blob.value, '', 0);
    if (found) return { ...found, source: blob.source };
  }
  return null;

  function walk(node: unknown, path: string, depth: number): Omit<EmbeddedReading, 'source'> | null {
    if (depth > 12 || node === null || typeof node !== 'object') return null;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 200; i++) {
        const hit = walk(node[i], `${path}[${i}]`, depth + 1);
        if (hit) return hit;
      }
      return null;
    }

    const obj = node as Record<string, unknown>;
    const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));

    const priceKey = PRICE_KEYS.find((k) => lower.has(k));
    if (priceKey) {
      const rawValue = obj[lower.get(priceKey) as string];
      const price =
        typeof rawValue === 'number'
          ? rawValue
          : typeof rawValue === 'string' && !isPlaceholder(rawValue)
            ? (parsePriceText(rawValue)?.value ?? null)
            : null;

      if (price !== null && Number.isFinite(price) && price > 0) {
        const currencyKey = CURRENCY_KEYS.find((k) => lower.has(k));
        const currency =
          (currencyKey ? String(obj[lower.get(currencyKey) as string] ?? '') : '').toUpperCase() || 'INR';

        const stockKey = STOCK_KEYS.find((k) => lower.has(k));
        const stockRawValue = stockKey ? obj[lower.get(stockKey) as string] : undefined;
        let stockStatus: StockStatus = 'unknown';
        let stockQuantity: number | null = null;
        let stockRaw = '';

        if (typeof stockRawValue === 'number') {
          stockQuantity = stockRawValue;
          stockStatus = stockFromQuantity(stockRawValue);
          stockRaw = `quantity=${stockRawValue}`;
        } else if (typeof stockRawValue === 'boolean') {
          stockStatus = stockRawValue ? 'in_stock' : 'out_of_stock';
          stockRaw = String(stockRawValue);
        } else if (typeof stockRawValue === 'string') {
          stockRaw = stockRawValue;
          // schema.org: "https://schema.org/InStock", "OutOfStock", "BackOrder"
          const tail = stockRawValue.split('/').pop() ?? stockRawValue;
          const parsed = parseStockText(tail.replace(/([a-z])([A-Z])/g, '$1 $2'));
          stockStatus = parsed.status;
          stockQuantity = parsed.quantity;
        }

        return { price, currency, stockStatus, stockQuantity, stockRaw, path: `${path}.${priceKey}` };
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      const hit = walk(value, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
}

export const embeddedJsonStrategy: Strategy = {
  name: 'embedded_json',
  available: () => true,

  async run(ctx: StrategyContext): Promise<StrategyResult> {
    const started = Date.now();
    ctx.onStage?.('strategy:embedded_json');

    const html = await fetchProductHtml(ctx.storeProductId);
    const blobs = collectJsonBlobs(html);
    const reading = findReading(blobs);

    const fingerprint = computeFingerprint({
      strategy: 'embedded_json',
      matchedSelectors: blobs.map((b) => `script:${b.source}`),
    });

    if (!reading) {
      throw new ScrapeError(
        'PARSE_MISS',
        blobs.length === 0
          ? `No embedded JSON in the served HTML (${html.length} bytes)`
          : `Found ${blobs.length} JSON blob(s) (${blobs.map((b) => b.source).join(', ')}) but none carried a price`,
        { httpStatus: 200 },
      );
    }

    return {
      reading: {
        price: reading.price,
        currency: reading.currency,
        stockStatus: reading.stockStatus,
        stockQuantity: reading.stockQuantity,
        stockRaw: reading.stockRaw,
        identity: { id: ctx.storeProductId },
      },
      httpStatus: 200,
      fingerprint,
      durationMs: Date.now() - started,
      meta: { source: reading.source, path: reading.path, blobCount: blobs.length },
    };
  },
};
