/**
 * The observable run.
 *
 *   npm run scrape:headed -w backend -- --product=15
 *   npm run scrape:headed -w backend -- --product=nordkraft-slimbook-pro --simulate=all
 *
 * A visible Chromium, a live overlay pinned to the page, and the same narration on
 * stdout. What you are watching is the production engine — `scrapeOne` from
 * `src/scraper/engine.ts`, the same retries, the same validation, the same log rows —
 * with the strategy chain reordered to put `browser` first so there is something on
 * screen. A demo that runs different code from production demonstrates nothing.
 *
 * --simulate intercepts the live quote request and holds it, breaks it, or both. The
 * store is genuinely asked; the answer is genuinely degraded. See `installSimulation`
 * in src/scraper/browser.ts for why the failure count is eight.
 *
 * Flags
 *   --product=<id|slug|name>   which product to watch (default: 15)
 *   --simulate=slow|error|late|all
 *   --no-db                    dry run: narrate everything, write nothing
 *   --keep-open                leave the browser open when the run finishes
 *   --headless                 run without a window (for CI smoke checks)
 */
import type { Page } from 'playwright';
import { env } from '../src/lib/env.js';
import { createLogger, setPretty } from '../src/lib/logger.js';
import { isDbConfigured } from '../src/db/client.js';
import { getLogs, getProductByStoreId, getTrackedWithProduct, listTracked, trackProduct, upsertProducts } from '../src/db/queries.js';
import type { ProductRow, TrackedProductRow } from '../src/db/types.js';
import { scrapeOne, type ScrapeStageEvent } from '../src/scraper/engine.js';
import { closeBrowser, resetSimulation, type SimulationMode } from '../src/scraper/browser.js';
import { configureBrowserStrategy } from '../src/scraper/strategies/browser.js';
import { fetchCatalogSample, fetchProduct, productUrl, type StoreProduct } from '../src/scraper/storeClient.js';
import { closeFetcher } from '../src/scraper/fetcher.js';
import crypto from 'node:crypto';

setPretty(true);
const log = createLogger({ run: 'headed' });

// --- flags -------------------------------------------------------------------

function flag(name: string): string | null {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1]!;
  return null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const PRODUCT = flag('product') ?? '15';
const SIMULATE = (flag('simulate') as SimulationMode | null) ?? null;
const DRY = has('no-db') || !isDbConfigured();
const KEEP_OPEN = has('keep-open');
const HEADLESS = has('headless');

if (SIMULATE && !['slow', 'error', 'late', 'all'].includes(SIMULATE)) {
  console.error(`--simulate must be one of: slow, error, late, all (got "${SIMULATE}")`);
  process.exit(2);
}

// --- the overlay -------------------------------------------------------------

/**
 * A panel pinned to the page, updated from Node as the engine reports stages.
 *
 * Rendered in a shadow root so the store's own stylesheet cannot reach into it and
 * ours cannot leak out — this runs on someone else's page, and the recording should
 * show their page, not our CSS bleeding into it.
 */
const OVERLAY_BOOTSTRAP = `
(() => {
  if (window.__ineOverlay) return;
  const host = document.createElement('div');
  host.id = 'ine-tracker-overlay';
  host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = \`
    <style>
      :host { all: initial; }
      .panel {
        width: 370px; background: #0F141A; color: #E9EBEE;
        font: 12px/1.5 ui-monospace, "SF Mono", "IBM Plex Mono", Menlo, Consolas, monospace;
        border: 1px solid #2A333D; border-radius: 10px; overflow: hidden;
        box-shadow: 0 18px 44px rgba(6,10,14,.5);
      }
      .hdr { display:flex; align-items:center; gap:8px; padding:10px 12px; background:#151C24; border-bottom:1px solid #2A333D; }
      .dot { width:8px; height:8px; border-radius:50%; background:#6B7580; box-shadow:0 0 0 3px rgba(107,117,128,.18); }
      .dot.run { background:#4C9AFF; box-shadow:0 0 0 3px rgba(76,154,255,.2); animation: pulse 1.1s ease-in-out infinite; }
      .dot.ok  { background:#2FBF87; box-shadow:0 0 0 3px rgba(47,191,135,.2); }
      .dot.err { background:#E05B45; box-shadow:0 0 0 3px rgba(224,91,69,.2); }
      .dot.wait{ background:#D9A93A; box-shadow:0 0 0 3px rgba(217,169,58,.2); }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.45} }
      .ttl { font-weight:600; letter-spacing:.02em; font-size:11px; text-transform:uppercase; color:#93A0AD; }
      .clock { margin-left:auto; color:#6B7580; font-variant-numeric: tabular-nums; }
      .rows { padding: 4px 12px 10px; }
      .row { display:flex; gap:10px; padding:4px 0; border-bottom:1px dashed rgba(42,51,61,.7); }
      .row:last-child { border-bottom:0; }
      .k { color:#6B7580; width:104px; flex:none; }
      .v { color:#E9EBEE; word-break:break-word; font-variant-numeric: tabular-nums; }
      .v.err { color:#F08C79; }
      .v.ok  { color:#5FD3A6; }
      .v.wait{ color:#EBC46A; }
      .bar { height:3px; background:#1D262F; }
      .bar > i { display:block; height:100%; background:#D9A93A; width:0%; transition:width .2s linear; }
      .reading { padding:10px 12px; background:#101820; border-top:1px solid #2A333D; display:none; }
      .reading.on { display:block; }
      .price { font-size:22px; font-weight:600; letter-spacing:-.01em; color:#FFFFFF; }
      .sub { color:#93A0AD; margin-top:2px; }
      .feed { max-height:132px; overflow:auto; padding:6px 12px 10px; border-top:1px solid #2A333D; color:#7C8894; }
      .feed div { padding:1px 0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .feed b { color:#B8C2CC; font-weight:500; }
    </style>
    <div class="panel">
      <div class="hdr"><span class="dot" id="dot"></span><span class="ttl">INE tracker · headed run</span><span class="clock" id="clock">0.0s</span></div>
      <div class="rows">
        <div class="row"><span class="k">attempt</span><span class="v" id="attempt">—</span></div>
        <div class="row"><span class="k">strategy</span><span class="v" id="strategy">—</span></div>
        <div class="row"><span class="k">status</span><span class="v" id="status">idle</span></div>
        <div class="row"><span class="k">waiting on</span><span class="v" id="waiting">—</span></div>
        <div class="row"><span class="k">simulation</span><span class="v" id="sim">off</span></div>
      </div>
      <div class="bar"><i id="bar"></i></div>
      <div class="reading" id="reading">
        <div class="price" id="price">—</div>
        <div class="sub" id="stock"></div>
      </div>
      <div class="feed" id="feed"></div>
    </div>\`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  const started = Date.now();
  let backoffUntil = 0, backoffTotal = 0;

  setInterval(() => {
    $('clock').textContent = ((Date.now() - started) / 1000).toFixed(1) + 's';
    if (backoffUntil > Date.now()) {
      const left = backoffUntil - Date.now();
      $('waiting').textContent = 'backoff · ' + (left / 1000).toFixed(1) + 's to next attempt';
      $('bar').style.width = (100 - (left / backoffTotal) * 100).toFixed(1) + '%';
    } else if (backoffTotal) {
      $('bar').style.width = '0%'; backoffTotal = 0;
    }
  }, 100);

  window.__ineOverlay = (patch) => {
    if (patch.attempt !== undefined) $('attempt').textContent = patch.attempt;
    if (patch.strategy !== undefined) $('strategy').textContent = patch.strategy;
    if (patch.sim !== undefined) $('sim').textContent = patch.sim;
    if (patch.status !== undefined) {
      $('status').textContent = patch.status;
      $('status').className = 'v ' + (patch.tone || '');
    }
    if (patch.waiting !== undefined) $('waiting').textContent = patch.waiting;
    if (patch.dot !== undefined) $('dot').className = 'dot ' + patch.dot;
    if (patch.backoffMs) { backoffUntil = Date.now() + patch.backoffMs; backoffTotal = patch.backoffMs; }
    if (patch.price !== undefined) {
      $('reading').classList.add('on');
      $('price').textContent = patch.price;
      $('stock').textContent = patch.stock || '';
    }
    if (patch.feed) {
      const line = document.createElement('div');
      line.innerHTML = '<b>' + ((Date.now() - started) / 1000).toFixed(1) + 's</b> · ' + patch.feed;
      $('feed').appendChild(line);
      $('feed').scrollTop = $('feed').scrollHeight;
    }
  };
})();
`;

let currentPage: Page | null = null;

async function injectOverlay(page: Page): Promise<void> {
  currentPage = page;
  // addInitScript so it survives the SPA's own navigations within the run.
  await page.addInitScript(OVERLAY_BOOTSTRAP);
  page.on('load', () => void page.evaluate(OVERLAY_BOOTSTRAP).catch(() => undefined));
}

async function overlay(patch: Record<string, unknown>): Promise<void> {
  if (!currentPage || currentPage.isClosed()) return;
  await currentPage
    .evaluate((p) => (window as unknown as { __ineOverlay?: (x: unknown) => void }).__ineOverlay?.(p), patch)
    .catch(() => undefined);
}

// --- narration ---------------------------------------------------------------

const STAGE_COPY: Record<string, { status: string; waiting: string; tone?: string; dot?: string }> = {
  'attempt-start': { status: 'attempt started', waiting: 'strategy chain', dot: 'run' },
  'strategy:api': { status: 'JSON handshake', waiting: '/api/challenge', dot: 'run' },
  'strategy:dom': { status: 'parsing served HTML', waiting: 'cheerio selectors', dot: 'run' },
  'strategy:embedded_json': { status: 'scanning for state blobs', waiting: '__NEXT_DATA__ / JSON-LD', dot: 'run' },
  challenge: { status: 'fetching challenge', waiting: 'GET /api/challenge', dot: 'run' },
  wasm: { status: 'running challenge WASM', waiting: 'WebAssembly.instantiate', dot: 'run' },
  'proof-of-work': { status: 'solving proof of work', waiting: 'sha256 nonce search', dot: 'run' },
  session: { status: 'exchanging for a token', waiting: 'POST /api/session', dot: 'run' },
  quote: { status: 'fetching the quote', waiting: 'GET /api/products/:id/price', dot: 'run' },
  decrypted: { status: 'quote decrypted', waiting: 'validation', dot: 'run' },
  'browser:navigating': { status: 'opening the product page', waiting: 'DOMContentLoaded', dot: 'run' },
  'browser:waiting-for-price-block': { status: 'waiting for the price block', waiting: '.price-block', dot: 'wait' },
  'browser:satisfying-interaction-gate': { status: 'satisfying the reveal gate', waiting: '8 pointer samples + 600ms dwell', dot: 'wait' },
  'browser:clicking-reveal': { status: 'clicking "Reveal price"', waiting: 'state to leave idle', dot: 'run' },
  'browser:click-was-swallowed': { status: 'click was dropped by the store', waiting: 're-issuing the click', tone: 'wait', dot: 'wait' },
  'browser:waiting-for-settled-price': { status: 'waiting for a settled figure', waiting: 'price-success, not "Updating…"', dot: 'wait' },
  'browser:extracted': { status: 'figure read from the page', waiting: 'validation', dot: 'run' },
  validated: { status: 'validated', waiting: 'writing history', tone: 'ok', dot: 'ok' },
  'stale-quote': { status: 'store served a stale quote', waiting: 'a settled figure', tone: 'wait', dot: 'wait' },
  'second-opinion': { status: 'large move — asking a 2nd strategy', waiting: 'confirmation', tone: 'wait', dot: 'wait' },
  'second-opinion-agrees': { status: 'second strategy agrees', waiting: 'writing history', tone: 'ok', dot: 'ok' },
  'second-opinion-disagrees': { status: 'strategies disagree — rejected', waiting: 'nothing written', tone: 'err', dot: 'err' },
  'structure-changed': { status: 'store structure changed', waiting: 'alert raised', tone: 'wait', dot: 'wait' },
  backoff: { status: 'attempt failed — backing off', waiting: 'next attempt', tone: 'err', dot: 'err' },
  failed: { status: 'failed, no retries left', waiting: 'nothing written', tone: 'err', dot: 'err' },
  'product-gone': { status: 'product is gone (404)', waiting: 'tracking paused', tone: 'err', dot: 'err' },
  success: { status: 'success', waiting: '—', tone: 'ok', dot: 'ok' },
};

const money = (n: number, currency: string): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

async function narrate(event: ScrapeStageEvent): Promise<void> {
  const copy = STAGE_COPY[event.stage];
  const detail = event.detail ?? {};
  const detailText = Object.entries(detail)
    .filter(([, v]) => v !== undefined && v !== null && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');

  process.stdout.write(
    `\x1b[2m${stamp()}\x1b[0m  ${(copy?.status ?? event.stage).padEnd(34)} ${detailText ? `\x1b[2m${detailText}\x1b[0m` : ''}\n`,
  );

  const patch: Record<string, unknown> = {
    feed: `${copy?.status ?? event.stage}${detailText ? ` <span style="opacity:.6">${detailText}</span>` : ''}`,
  };
  if (copy) {
    patch['status'] = copy.status;
    patch['waiting'] = copy.waiting;
    if (copy.tone) patch['tone'] = copy.tone;
    if (copy.dot) patch['dot'] = copy.dot;
  }
  if (event.stage === 'attempt-start') patch['attempt'] = `${detail['attempt']} of ${detail['of']}`;
  if (typeof detail['strategy'] === 'string') patch['strategy'] = detail['strategy'];
  if (event.stage.startsWith('strategy:')) patch['strategy'] = event.stage.slice('strategy:'.length);
  if (event.stage === 'backoff' && typeof detail['waitMs'] === 'number') {
    patch['backoffMs'] = detail['waitMs'];
    patch['status'] = `failed: ${String(detail['code'])}`;
  }
  if (event.stage === 'success') {
    patch['price'] = money(Number(detail['price']), String(detail['currency'] ?? 'INR'));
    patch['stock'] = `${String(detail['stock'])} · read via ${String(detail['strategy'])} on attempt ${String(detail['attempt'])}`;
  }

  await overlay(patch);
}

// --- resolving the product ---------------------------------------------------

async function resolveProduct(input: string): Promise<StoreProduct> {
  if (/^\d+$/.test(input)) return fetchProduct(input);

  if (isDbConfigured()) {
    const { searchProducts } = await import('../src/db/queries.js');
    const hits = await searchProducts(input.replace(/-/g, ' '), 1).catch(() => []);
    const first = hits[0];
    if (first) return fetchProduct(first.store_product_id);
  }

  log.info('resolving product by sampling the catalogue', { needle: input });
  const needle = input.toLowerCase();
  for (let draw = 0; draw < 25; draw++) {
    const sample = await fetchCatalogSample(60);
    const hit = sample.items.find(
      (p) => p.slug === input || p.name.toLowerCase().includes(needle) || p.sku?.toLowerCase() === needle,
    );
    if (hit) return hit;
  }
  throw new Error(`Could not find a product matching "${input}". Try --product=<numeric id>.`);
}

// --- main --------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('\x1b[1m  INE Price Tracker — observable run\x1b[0m');
  console.log(`  store      ${env.storeBaseUrl}`);
  console.log(`  product    ${PRODUCT}`);
  console.log(`  simulate   ${SIMULATE ?? 'off'}`);
  console.log(`  database   ${DRY ? 'DRY RUN — nothing will be written' : 'live'}`);
  console.log('');

  const storeProduct = await resolveProduct(PRODUCT);
  log.info('product resolved', { id: storeProduct.id, name: storeProduct.name, url: productUrl(storeProduct.id) });

  resetSimulation();
  configureBrowserStrategy({
    headless: HEADLESS,
    slowMo: HEADLESS ? 0 : 250,
    simulate: SIMULATE,
    onPage: injectOverlay,
    onSimulatedFault: (what, detail) => {
      process.stdout.write(`\x1b[2m${stamp()}\x1b[0m  \x1b[33m⚡ simulated fault\x1b[0m                  \x1b[2m${what} (${detail['step']}/${detail['of']})\x1b[0m\n`);
      void overlay({ feed: `<span style="color:#EBC46A">⚡ ${what}</span>`, sim: `${SIMULATE} · step ${detail['step']}/${detail['of']}` });
    },
  });

  // Build the tracked record the engine expects. With a database we use (or create)
  // the real row so the run shows up in the UI; without one we synthesise it and the
  // engine runs in dry mode.
  let tracked: TrackedProductRow & { product: ProductRow };

  if (DRY) {
    const now = new Date().toISOString();
    tracked = {
      id: crypto.randomUUID(),
      product_id: crypto.randomUUID(),
      is_active: true,
      scrape_interval_minutes: 120,
      alert_price_below: null,
      alert_on_restock: false,
      created_at: now,
      last_scraped_at: null,
      last_success_at: null,
      consecutive_failures: 0,
      product: {
        id: crypto.randomUUID(),
        store_product_id: String(storeProduct.id),
        name: storeProduct.name,
        url: productUrl(storeProduct.id),
        image_url: null,
        category: storeProduct.category ?? null,
        brand: storeProduct.brand ?? null,
        sku: storeProduct.sku ?? null,
        slug: storeProduct.slug ?? null,
        description: storeProduct.description ?? null,
        specs: (storeProduct.specs ?? null) as Record<string, unknown> | null,
        first_seen_at: now,
        last_seen_at: now,
      },
    };
  } else {
    let product: ProductRow | null = await getProductByStoreId(String(storeProduct.id));
    if (!product) {
      const created = await upsertProducts([
        {
          store_product_id: String(storeProduct.id),
          name: storeProduct.name,
          url: productUrl(storeProduct.id),
          brand: storeProduct.brand ?? null,
          category: storeProduct.category ?? null,
          sku: storeProduct.sku ?? null,
          slug: storeProduct.slug ?? null,
          description: storeProduct.description ?? null,
          specs: (storeProduct.specs ?? null) as Record<string, unknown> | null,
        },
      ]);
      product = created[0] ?? null;
    }
    if (!product) throw new Error('Could not create the product row');

    const existing = (await listTracked(true)).find((t) => t.store_product_id === String(storeProduct.id));
    const row = existing
      ? await getTrackedWithProduct(existing.tracked_id)
      : await trackProduct(product.id).then((t) => getTrackedWithProduct(t.id));
    if (!row) throw new Error('Could not create the tracked row');
    tracked = row;
    log.info('tracking row ready', { trackedId: tracked.id });
  }

  const CHAIN: ('browser' | 'api')[] = SIMULATE ? ['browser'] : ['browser', 'api'];
  const runId = crypto.randomUUID();
  await overlay({ sim: SIMULATE ?? 'off' });

  console.log('\x1b[2m  ─────────────────────────────────────────────────────────────────\x1b[0m');
  const result = await scrapeOne(tracked, {
    runId,
    // Browser first so the run is watchable. Without a simulation the API strategy
    // stays behind it, so a genuine browser failure demonstrates the chain falling
    // back. With one, the chain is browser-only: route interception cannot reach the
    // HTTP client, so leaving `api` in would rescue every simulated fault and the
    // retry machinery — the thing the recording exists to show — would never run.
    only: CHAIN,
    simulate: SIMULATE,
    dryRun: DRY,
    onStage: (e) => void narrate(e),
    logger: createLogger({ runId }),
  });
  console.log('\x1b[2m  ─────────────────────────────────────────────────────────────────\x1b[0m\n');

  // --- summary ---------------------------------------------------------------
  const ok = result.outcome === 'success';
  console.log(`  \x1b[1m${ok ? '\x1b[32mSUCCESS' : '\x1b[31mFAILED'}\x1b[0m  after ${result.attempts} attempt${result.attempts === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`);
  if (ok) {
    console.log(`  reading   ${money(result.price ?? 0, result.currency ?? 'INR')}  ·  ${result.stockStatus}`);
    console.log(`  strategy  ${result.strategy}`);
  } else {
    console.log(`  error     ${result.errorCode} — ${result.errorMessage}`);
    console.log('  history   untouched (this is the point: no row is better than a wrong row)');
  }
  if (result.structureChanged) console.log('  \x1b[33mstructure change detected and alerted\x1b[0m');

  if (!DRY) {
    const { rows } = await getLogs(tracked.id, { limit: 10 });
    const thisRun = rows.filter((r) => r.run_id === runId).reverse();
    console.log(`\n  \x1b[1mscrape_logs rows written by this run\x1b[0m (${thisRun.length})`);
    console.log('  ' + 'time'.padEnd(14) + '#'.padEnd(4) + 'outcome'.padEnd(10) + 'strategy'.padEnd(10) + 'ms'.padEnd(8) + 'error');
    for (const r of thisRun) {
      const colour = r.outcome === 'success' ? '\x1b[32m' : r.outcome === 'retried' ? '\x1b[33m' : '\x1b[31m';
      console.log(
        '  ' +
          r.started_at.slice(11, 23).padEnd(14) +
          String(r.attempt_number).padEnd(4) +
          `${colour}${r.outcome.padEnd(10)}\x1b[0m` +
          String(r.strategy ?? '—').padEnd(10) +
          String(r.duration_ms).padEnd(8) +
          `\x1b[2m${r.error_code ?? ''}\x1b[0m`,
      );
    }
    console.log('');
  }

  if (KEEP_OPEN) {
    console.log('  --keep-open: the browser stays up. Ctrl-C when you are done.\n');
    await new Promise(() => undefined);
  }
}

main()
  .then(async () => {
    await closeBrowser();
    await closeFetcher();
    process.exit(0);
  })
  .catch(async (err) => {
    log.error('headed run failed', { err: String(err), stack: (err as Error).stack });
    await closeBrowser().catch(() => undefined);
    await closeFetcher().catch(() => undefined);
    process.exit(1);
  });
