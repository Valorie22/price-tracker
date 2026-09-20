/**
 * Engine behaviour, with the database and the strategies stubbed.
 *
 * The contract being tested is the one the whole project is graded on:
 *
 *   a failed scrape writes log rows and ZERO history rows,
 *   a recovered scrape writes `retried`, `retried`, `success` — not just `success`,
 *   and a 404 never gets retried.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrapeError } from '../src/scraper/errors.js';
import type { ProductRow, TrackedProductRow } from '../src/db/types.js';
import type { StrategyResult } from '../src/scraper/strategies/types.js';
import { TRUE_PRICE } from './fixtures.js';

// --- database stub -----------------------------------------------------------

const written = {
  logs: [] as Record<string, unknown>[],
  history: [] as Record<string, unknown>[],
  alerts: [] as Record<string, unknown>[],
  trackedUpdates: [] as Record<string, unknown>[],
};

let lastKnownPrice: number | null = null;
let logId = 0;

vi.mock('../src/db/queries.js', () => ({
  getLastPrice: vi.fn(async () => (lastKnownPrice === null ? null : { price: lastKnownPrice, stock_status: 'in_stock' })),
  insertScrapeLog: vi.fn(async (row: Record<string, unknown>) => {
    logId += 1;
    written.logs.push({ ...row, id: logId });
    return { id: logId };
  }),
  insertPriceHistory: vi.fn(async (row: Record<string, unknown>) => {
    written.history.push(row);
    return { id: written.history.length };
  }),
  markAttemptFinished: vi.fn(async (id: string, update: Record<string, unknown>) => {
    written.trackedUpdates.push({ id, ...update });
    return update['succeeded'] ? 0 : written.trackedUpdates.filter((u) => !u['succeeded']).length;
  }),
  recordFingerprint: vi.fn(async () => ({ changed: false, previous: null })),
  listDueTracked: vi.fn(async () => []),
  listActiveTracked: vi.fn(async () => []),
  getTrackedWithProduct: vi.fn(async () => null),
  startCronRun: vi.fn(async () => undefined),
  finishCronRun: vi.fn(async () => undefined),
  tryAcquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined),
  insertAlert: vi.fn(async (row: Record<string, unknown>) => {
    written.alerts.push(row);
    return { id: written.alerts.length, ...row, created_at: new Date().toISOString() };
  }),
  hasRecentAlert: vi.fn(async () => false),
  markAlertEmailed: vi.fn(async () => undefined),
}));

// --- strategy stub -----------------------------------------------------------

type Step = StrategyResult | ScrapeError;
let script: Step[] = [];
let calls = 0;

const stubResult = (over: Partial<StrategyResult['reading']> = {}): StrategyResult => ({
  reading: {
    price: TRUE_PRICE,
    currency: 'INR',
    stockStatus: 'in_stock',
    stockQuantity: 151,
    stockRaw: 'quantity=151',
    mrp: 157_621,
    atomic: true,
    pending: false,
    identity: { name: 'Nordkraft Slimbook Pro', slug: 'nordkraft-slimbook-pro', sku: 'NOR-10015', id: '15' },
    ...over,
  },
  httpStatus: 200,
  fingerprint: { fingerprint: 'api:test', details: {} },
  durationMs: 12,
  meta: {},
});

vi.mock('../src/scraper/strategies/api.js', () => ({
  apiStrategy: {
    name: 'api',
    available: () => true,
    run: async () => {
      const step = script[Math.min(calls, script.length - 1)];
      calls += 1;
      if (step instanceof ScrapeError) throw step;
      if (!step) throw new ScrapeError('PARSE_MISS', 'no scripted step');
      return step;
    },
  },
  resetLayoutCache: () => undefined,
}));

// The other three are unavailable in this suite, so the chain is exactly one strategy
// and the assertions are about the engine rather than about strategy ordering.
const unavailable = (name: string) => ({
  name,
  available: () => false,
  run: async () => {
    throw new ScrapeError('BROWSER_UNAVAILABLE', 'stubbed out');
  },
});
vi.mock('../src/scraper/strategies/dom.js', () => ({ domStrategy: unavailable('dom'), extractFromHtml: () => ({}) }));
vi.mock('../src/scraper/strategies/embeddedJson.js', () => ({ embeddedJsonStrategy: unavailable('embedded_json') }));
vi.mock('../src/scraper/strategies/browser.js', () => ({
  browserStrategy: unavailable('browser'),
  configureBrowserStrategy: () => undefined,
  runBrowserExtraction: async () => {
    throw new ScrapeError('BROWSER_UNAVAILABLE', 'stubbed out');
  },
}));

const { scrapeOne } = await import('../src/scraper/engine.js');

// --- fixtures ----------------------------------------------------------------

const now = new Date().toISOString();
const product: ProductRow = {
  id: 'p-uuid', store_product_id: '15', name: 'Nordkraft Slimbook Pro',
  url: 'https://demo.inelabteamdev.com/product/15', image_url: null, category: 'Laptops',
  brand: 'Nordkraft', sku: 'NOR-10015', slug: 'nordkraft-slimbook-pro', description: null,
  specs: null, first_seen_at: now, last_seen_at: now,
};
const tracked: TrackedProductRow & { product: ProductRow } = {
  id: 't-uuid', product_id: 'p-uuid', is_active: true, scrape_interval_minutes: 120,
  alert_price_below: null, alert_on_restock: false, created_at: now,
  last_scraped_at: null, last_success_at: null, consecutive_failures: 0, product,
};

const run = (over: Parameters<typeof scrapeOne>[1] extends infer T ? Partial<T> : never = {}) =>
  scrapeOne(tracked, { runId: 'run-uuid', ...over });

beforeEach(() => {
  written.logs = [];
  written.history = [];
  written.alerts = [];
  written.trackedUpdates = [];
  script = [];
  calls = 0;
  logId = 0;
  lastKnownPrice = null;
});

// --- the tests ---------------------------------------------------------------

describe('a scrape that works first time', () => {
  it('writes one success log and one history row', async () => {
    script = [stubResult()];
    const result = await run();

    expect(result.outcome).toBe('success');
    expect(result.attempts).toBe(1);
    expect(written.logs).toHaveLength(1);
    expect(written.logs[0]).toMatchObject({ outcome: 'success', attempt_number: 1, strategy: 'api', price_found: TRUE_PRICE });
    expect(written.history).toHaveLength(1);
    expect(written.history[0]).toMatchObject({ price: TRUE_PRICE, currency: 'INR', stock_status: 'in_stock' });
  });

  it('records which attempt produced the stored row', async () => {
    script = [stubResult()];
    await run();
    expect(written.history[0]?.['scrape_log_id']).toBe(written.logs[0]?.['id']);
  });
});

describe('a scrape that recovers', () => {
  it('leaves retried, retried, success — the log tells the whole story', async () => {
    script = [
      new ScrapeError('HTTP_5XX', 'upstream_error', { httpStatus: 503 }),
      new ScrapeError('TIMEOUT', 'headers timeout'),
      stubResult(),
    ];
    const result = await run();

    expect(result.outcome).toBe('success');
    expect(result.attempts).toBe(3);
    expect(written.logs.map((l) => l['outcome'])).toEqual(['retried', 'retried', 'success']);
    expect(written.logs.map((l) => l['attempt_number'])).toEqual([1, 2, 3]);
    expect(written.logs[0]).toMatchObject({ error_code: 'HTTP_5XX', http_status: 503 });
    expect(written.logs[1]).toMatchObject({ error_code: 'TIMEOUT' });
    expect(written.history).toHaveLength(1);
  });
}, 30_000);

describe('a scrape that fails for good', () => {
  it('writes a log row per attempt and ZERO history rows', async () => {
    script = [new ScrapeError('HTTP_5XX', 'upstream_error', { httpStatus: 503 })];
    const result = await run();

    expect(result.outcome).toBe('failed');
    expect(written.history).toHaveLength(0);
    expect(written.logs).toHaveLength(4); // maxAttempts
    expect(written.logs.map((l) => l['outcome'])).toEqual(['retried', 'retried', 'retried', 'failed']);
    for (const row of written.logs) expect(row['price_found']).toBeNull();
  });

  it('counts the failure against the tracked product', async () => {
    script = [new ScrapeError('NETWORK', 'ECONNRESET')];
    await run();
    expect(written.trackedUpdates.at(-1)).toMatchObject({ succeeded: false });
  });
}, 40_000);

describe('a product that no longer exists', () => {
  it('does not retry a 404, pauses tracking and raises an alert', async () => {
    script = [new ScrapeError('PRODUCT_GONE', 'HTTP 404: {"error":"not_found"}', { httpStatus: 404 })];
    const result = await run();

    expect(result.outcome).toBe('failed');
    expect(result.attempts).toBe(1); // no retries — the answer will not change
    expect(written.logs).toHaveLength(1);
    expect(written.logs[0]).toMatchObject({ outcome: 'failed', error_code: 'PRODUCT_GONE' });
    expect(written.history).toHaveLength(0);
    expect(written.trackedUpdates.at(-1)).toMatchObject({ deactivate: true });
    expect(written.alerts.map((a) => a['kind'])).toContain('product_gone');
  });
});

describe('the stale-quote trap', () => {
  it('refuses a pending quote and retries instead, then stores the settled figure', async () => {
    lastKnownPrice = 165_813;
    script = [
      stubResult({ pending: true, price: 128_644, mrp: 197_396 }), // the trap
      stubResult({ price: 165_813, mrp: 197_396 }), // the truth
    ];
    const result = await run();

    expect(result.outcome).toBe('success');
    expect(result.price).toBe(165_813);
    expect(written.logs[0]).toMatchObject({ outcome: 'retried', error_code: 'STALE_QUOTE' });
    expect(written.history).toHaveLength(1);
    expect(written.history[0]?.['price']).toBe(165_813);
    // The phantom -22% never reaches the chart.
    expect(written.history.some((h) => h['price'] === 128_644)).toBe(false);
  });
}, 20_000);

describe('the large-move guard', () => {
  it('stores nothing when no second strategy can confirm an absurd move', async () => {
    lastKnownPrice = TRUE_PRICE;
    script = [stubResult({ price: 12 })]; // 99.99% drop, and nothing else is available to confirm it
    const result = await run();

    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('VALIDATION_REJECT');
    expect(written.history).toHaveLength(0);
    expect(written.logs.at(-1)).toMatchObject({ outcome: 'failed', error_code: 'VALIDATION_REJECT' });
  });
}, 40_000);

describe('alerts the user asked for', () => {
  it('raises a price-drop alert when the threshold is crossed', async () => {
    lastKnownPrice = 200_000;
    script = [stubResult({ price: 129_249 })];
    await scrapeOne({ ...tracked, alert_price_below: 150_000 }, { runId: 'run-uuid' });
    expect(written.alerts.map((a) => a['kind'])).toContain('price_drop');
  });

  it('does not raise one when the price was already below the threshold', async () => {
    lastKnownPrice = 130_000;
    script = [stubResult({ price: 129_249 })];
    await scrapeOne({ ...tracked, alert_price_below: 150_000 }, { runId: 'run-uuid' });
    expect(written.alerts.map((a) => a['kind'])).not.toContain('price_drop');
  });
});

describe('dry run', () => {
  it('narrates everything and writes nothing', async () => {
    script = [stubResult()];
    const stages: string[] = [];
    const result = await run({ dryRun: true, onStage: (e) => stages.push(e.stage) });

    expect(result.outcome).toBe('success');
    expect(written.logs).toHaveLength(0);
    expect(written.history).toHaveLength(0);
    expect(stages).toContain('attempt-start');
    expect(stages).toContain('success');
  });
});
