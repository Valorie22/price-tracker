/**
 * Strategy 3 — HTML parsing with cheerio.
 *
 * Against today's store this strategy misses on a plain HTTP fetch, and that is the
 * honest, expected result: `GET /product/15` returns a 459-byte Vite shell with an
 * empty `<div id="root">`. It is in the chain anyway for two reasons. It is the
 * fallback if the JSON surface ever disappears — a private API is exactly the thing
 * that vanishes without notice — and the browser strategy reuses this exact extractor
 * on rendered HTML, so the selector work is shared rather than duplicated.
 *
 * THE DECOYS
 * ----------
 * The store ships two hidden nodes carrying deliberately wrong numbers:
 *
 *   <span class="price-value" aria-hidden="true" style="display:none">₹118,631</span>
 *   <span class="amount" data-price="true" aria-hidden="true" style="display:none">₹122,679</span>
 *
 * `.price-value` and `[data-price]` are the two selectors a scraper reaches for first,
 * and both are traps. The real reading sits in an element whose classes are a rotating
 * random token plus the layout's published `priceValue` class (`v7k2ab pv-z6`), beside
 * a struck-through MRP and a "N% off" badge. Every candidate below therefore runs
 * through `isDecoy()` before its text is believed.
 */
import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { computeFingerprint } from '../fingerprint.js';
import { ScrapeError } from '../errors.js';
import { isPlaceholder, parsePriceText, parseStockText, type ParsedStock } from '../parse.js';
import { fetchProductHtml, type StoreLayout } from '../storeClient.js';
import type { Strategy, StrategyContext, StrategyResult } from './types.js';

type Cheerio$ = cheerio.CheerioAPI;

/**
 * Price candidates, best first. Each is tried in order and the first that yields a
 * believable, non-decoy, currency-shaped number wins.
 */
function priceSelectors(layout: StoreLayout | null): { sel: string; why: string }[] {
  const published = layout?.classes?.['priceValue'];
  return [
    ...(published ? [{ sel: `.price-main .${published}`, why: 'class published by /api/layout' }] : []),
    { sel: '.price-main [class*="pv-"]', why: 'priceValue class family' },
    { sel: '.price-main [style*="2.4rem"]', why: 'the display reading is the only 2.4rem node' },
    { sel: '.price-main [style*="var(--serif)"]', why: 'display reading uses the serif face' },
    { sel: '.price-success .price-main > span', why: 'positional fallback inside a settled price block' },
    { sel: '.price-block .price-main', why: 'whole block, regex-scanned' },
  ];
}

function mrpSelectors(layout: StoreLayout | null): string[] {
  const published = layout?.classes?.['mrp'];
  return [
    ...(published ? [`.price-main .${published}`] : []),
    '.price-main [class*="mr-"]',
    '.price-main [style*="line-through"]',
  ];
}

function stockSelectors(layout: StoreLayout | null): string[] {
  const published = layout?.classes?.['stock'];
  return [
    '.price-facets .stock-badge',
    ...(published ? [`.price-facets .${published}`] : []),
    '.price-facets [class*="st-"]',
    '[class*="stock-badge"]',
    '.price-facets div:last-child',
  ];
}

const DECOY_CLASSES = ['price-value', 'amount'];
const DECOY_ATTRS = ['data-price'];

/** Hidden, aria-hidden, struck through, or one of the two known decoy nodes. */
function isDecoy($: Cheerio$, el: Element): boolean {
  const node = $(el);
  const cls = (node.attr('class') ?? '').split(/\s+/);
  if (DECOY_CLASSES.some((c) => cls.includes(c))) return true;
  if (DECOY_ATTRS.some((a) => node.attr(a) !== undefined)) return true;
  if (node.attr('aria-hidden') === 'true') return true;
  const style = (node.attr('style') ?? '').replace(/\s+/g, '').toLowerCase();
  if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
  if (style.includes('line-through')) return true; // that is the MRP, not the price
  const text = node.text();
  if (/deal\s*price/i.test(text)) return true; // that is the sale line
  if (/%\s*off/i.test(text) && !/[₹$€£]/.test(text)) return true; // that is the badge
  return false;
}

/** `div.detail > div.price-block.price-success > div.price-main > span.pv-z6` */
function ancestorPath($: Cheerio$, el: Element): string {
  const parts: string[] = [];
  let current: AnyNode | null = el;
  let depth = 0;
  while (current && depth < 8) {
    if (current.type === 'tag') {
      const node = current as Element;
      const cls = (node.attribs?.['class'] ?? '')
        .split(/\s+/)
        .filter(Boolean)
        // Rotating per-render tokens (`v7k2ab`) would make every page look like a change.
        .filter((c) => !/^v[a-z0-9]{5,6}$/.test(c))
        .sort()
        .join('.');
      parts.unshift(cls ? `${node.tagName}.${cls}` : node.tagName);
    }
    current = current.parent as AnyNode | null;
    depth++;
  }
  return parts.join(' > ');
}

export interface DomExtraction {
  price: number | null;
  currency: string;
  priceShape: string | null;
  mrp: number | null;
  stock: ParsedStock;
  matchedSelectors: string[];
  ancestorPath: string | null;
  identity: { name?: string; sku?: string; id?: string };
  /** True when the store rendered its "Updating…" marker beside the figure. */
  pending: boolean;
  /** Set when the block is present but has not settled (idle / loading / error). */
  blockPhase: 'idle' | 'loading' | 'error' | 'success' | 'absent';
}

/** Shared by the `dom` and `browser` strategies — same selectors, different HTML source. */
export function extractFromHtml(html: string, layout: StoreLayout | null): DomExtraction {
  const $ = cheerio.load(html);
  const matched: string[] = [];

  const block = $('.price-block').first();
  let blockPhase: DomExtraction['blockPhase'] = 'absent';
  if (block.length > 0) {
    const cls = block.attr('class') ?? '';
    blockPhase = cls.includes('price-success')
      ? 'success'
      : cls.includes('price-error')
        ? 'error'
        : cls.includes('price-idle')
          ? 'idle'
          : 'loading';
  }

  // --- price -----------------------------------------------------------------
  let price: number | null = null;
  let currency = 'INR';
  let priceShape: string | null = null;
  let priceNode: Element | null = null;

  for (const { sel } of priceSelectors(layout)) {
    const hits = $(sel).toArray() as Element[];
    if (hits.length === 0) continue;
    for (const el of hits) {
      if (isDecoy($, el)) continue;
      const text = $(el).text();
      if (isPlaceholder(text)) continue;
      const parsed = parsePriceText(text);
      if (!parsed) continue;
      price = parsed.value;
      currency = parsed.currency;
      priceShape = parsed.shape;
      priceNode = el;
      matched.push(sel);
      break;
    }
    if (price !== null) break;
  }

  // Last resort: a currency-shaped token in the price block's own text, with the
  // struck-through MRP and the "Deal price" line removed first so we cannot pick
  // up the wrong one of the three numbers the `triple` variant renders.
  if (price === null && block.length > 0) {
    const scratch = cheerio.load($.html(block));
    scratch('[style*="line-through"], [aria-hidden="true"], .price-value, .amount, [data-price]').remove();
    scratch('*').each((_, el) => {
      if (/deal\s*price/i.test(scratch(el).text()) && scratch(el).children().length === 0) scratch(el).remove();
    });
    const text = scratch.root().text().normalize('NFKC').replace(/[​-‍﻿]/g, '');
    const m = /(?:₹|Rs\.?|INR)\s*([0-9][0-9\s.,']*)/i.exec(text);
    const parsed = m ? parsePriceText(m[0]) : null;
    if (parsed) {
      price = parsed.value;
      currency = parsed.currency;
      priceShape = parsed.shape;
      matched.push('regex:currency-token-near-price-block');
    }
  }

  // --- MRP -------------------------------------------------------------------
  let mrp: number | null = null;
  for (const sel of mrpSelectors(layout)) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const parsed = parsePriceText(el.text());
    if (parsed) {
      mrp = parsed.value;
      matched.push(sel);
      break;
    }
  }

  // --- stock -----------------------------------------------------------------
  let stock: ParsedStock = { status: 'unknown', quantity: null, raw: '' };
  for (const sel of stockSelectors(layout)) {
    const el = $(sel).first();
    if (el.length === 0) continue;
    const parsed = parseStockText(el.text());
    if (parsed.raw !== '') {
      stock = parsed;
      matched.push(sel);
      if (parsed.status !== 'unknown') break;
    }
  }

  // --- identity + pending ----------------------------------------------------
  const name = $('.detail-info h1').first().text().trim() || $('h1').first().text().trim();
  const skuMatch = /SKU\s+([A-Z]{2,4}-\d{3,6})/i.exec($.root().text());
  const pending = /updating…|updating\.\.\./i.test(block.text());

  return {
    price,
    currency,
    priceShape,
    mrp,
    stock,
    matchedSelectors: matched,
    ancestorPath: priceNode ? ancestorPath($, priceNode) : null,
    identity: { ...(name ? { name } : {}), ...(skuMatch?.[1] ? { sku: skuMatch[1] } : {}) },
    pending,
    blockPhase,
  };
}

export const domStrategy: Strategy = {
  name: 'dom',
  available: () => true,

  async run(ctx: StrategyContext): Promise<StrategyResult> {
    const started = Date.now();
    ctx.onStage?.('strategy:dom');

    const html = await fetchProductHtml(ctx.storeProductId);
    const extraction = extractFromHtml(html, null);

    const fingerprint = computeFingerprint({
      strategy: 'dom',
      matchedSelectors: extraction.matchedSelectors,
      ...(extraction.ancestorPath ? { ancestorPath: extraction.ancestorPath } : {}),
    });

    if (extraction.price === null) {
      throw new ScrapeError(
        'PARSE_MISS',
        extraction.blockPhase === 'absent'
          ? `No price block in the served HTML (${html.length} bytes; the store renders on the client)`
          : `Price block was present but in phase "${extraction.blockPhase}" with no readable figure`,
        { httpStatus: 200 },
      );
    }

    return {
      reading: {
        price: extraction.price,
        currency: extraction.currency,
        stockStatus: extraction.stock.status,
        stockQuantity: extraction.stock.quantity,
        stockRaw: extraction.stock.raw,
        mrp: extraction.mrp,
        pending: extraction.pending,
        identity: { ...extraction.identity, id: ctx.storeProductId },
      },
      httpStatus: 200,
      fingerprint,
      durationMs: Date.now() - started,
      meta: { priceShape: extraction.priceShape, blockPhase: extraction.blockPhase, matched: extraction.matchedSelectors },
    };
  },
};
