/**
 * Build the local catalogue index.
 *
 * The store has no search endpoint, `/api/catalog` ignores its `page` parameter and
 * returns a fresh random sample every call, and the sample caps out around 60 items
 * (STORE_NOTES.md §3). So "search by partial product name" is only possible against
 * a copy of the catalogue we hold ourselves, and building that copy is a collection
 * problem rather than a pagination one.
 *
 * Two passes:
 *   1. Draw random samples of 60 until new ids stop arriving. This is the coupon
 *      collector's problem — roughly (1000/60) × H(1000) ≈ 125 draws for full coverage,
 *      and each draw brings full metadata, so it is far cheaper than 1000 detail fetches.
 *   2. Fill whatever is still missing with `/api/product/:id`, since ids are contiguous
 *      1–1000 and the total is published in every catalogue response.
 *
 * Idempotent: re-running refreshes `last_seen_at` and picks up anything new.
 *
 *   npm run seed:catalog -w backend                    # full index
 *   npm run seed:catalog -w backend -- --max-draws 40
 *   npm run seed:catalog -w backend -- --dump catalog.json   # harvest only, no database
 *
 * `--dump` writes the harvested rows to a file instead of upserting them. Useful when the
 * database is not reachable from where you are standing, and for inspecting exactly what
 * the store returned before trusting it.
 */
import { env } from '../src/lib/env.js';
import { createLogger, setPretty } from '../src/lib/logger.js';
import { countProducts, listAllStoreProductIds, upsertProducts, type ProductUpsert } from '../src/db/queries.js';
import { fetchCatalogSample, fetchProduct, productUrl, type StoreProduct } from '../src/scraper/storeClient.js';
import { closeFetcher } from '../src/scraper/fetcher.js';

setPretty(true);
const log = createLogger({ script: 'seed-catalog' });

function flagStr(name: string): string | null {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith('--') ? next : null;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

const MAX_DRAWS = arg('max-draws', 400);
/** Stop once this many consecutive draws bring nothing new. */
const PATIENCE = arg('patience', 12);

const toRow = (p: StoreProduct): ProductUpsert => ({
  store_product_id: String(p.id),
  name: p.name,
  url: productUrl(p.id),
  brand: p.brand ?? null,
  category: p.category ?? null,
  sku: p.sku ?? null,
  slug: p.slug ?? null,
  description: p.description ?? null,
  specs: (p.specs ?? null) as Record<string, unknown> | null,
});

async function main(): Promise<void> {
  log.info('seeding catalogue index', { store: env.storeBaseUrl, pacerGapMs: env.minRequestGapMs });

  const collected = new Map<string, StoreProduct>();
  let total = 0;
  let barrenDraws = 0;
  let draws = 0;

  for (; draws < MAX_DRAWS; draws++) {
    let sample;
    try {
      sample = await fetchCatalogSample(60);
    } catch (err) {
      log.warn('catalogue draw failed; continuing', { draw: draws + 1, err: String(err) });
      barrenDraws++;
      if (barrenDraws > PATIENCE * 2) break;
      continue;
    }

    total = sample.total || total;
    const before = collected.size;
    for (const item of sample.items) collected.set(String(item.id), item);
    const gained = collected.size - before;

    barrenDraws = gained === 0 ? barrenDraws + 1 : 0;

    if (draws % 10 === 0 || gained === 0) {
      log.info('collecting', {
        draw: draws + 1,
        have: collected.size,
        of: total || '?',
        gained,
        barren: barrenDraws,
      });
    }

    if (total > 0 && collected.size >= total) {
      log.info('full coverage from sampling', { draws: draws + 1, have: collected.size });
      break;
    }
    if (barrenDraws >= PATIENCE) {
      log.info('sampling has plateaued; switching to gap filling', { draws: draws + 1, have: collected.size });
      break;
    }
  }

  // --- pass 2: fill the gaps directly ---------------------------------------
  if (total > 0 && collected.size < total) {
    const missing: number[] = [];
    for (let id = 1; id <= total; id++) if (!collected.has(String(id))) missing.push(id);
    log.info('filling gaps by id', { missing: missing.length });

    for (const [i, id] of missing.entries()) {
      try {
        collected.set(String(id), await fetchProduct(id));
      } catch (err) {
        log.warn('could not fetch product', { id, err: String(err).slice(0, 120) });
      }
      if (i % 25 === 0) log.info('gap filling', { done: i, of: missing.length, have: collected.size });
    }
  }

  // --- write ----------------------------------------------------------------
  const rows = [...collected.values()].map(toRow);

  const dumpPath = flagStr('dump');
  if (dumpPath) {
    const fs = await import('node:fs');
    fs.writeFileSync(dumpPath, JSON.stringify(rows, null, 1));
    log.info('dumped instead of writing', { path: dumpPath, rows: rows.length, storeTotal: total || 'unknown' });
    return;
  }

  log.info('writing to the database', { rows: rows.length });

  const BATCH = 250;
  for (let i = 0; i < rows.length; i += BATCH) {
    await upsertProducts(rows.slice(i, i + BATCH));
    log.info('upserted', { done: Math.min(i + BATCH, rows.length), of: rows.length });
  }

  const indexed = await countProducts();
  const ids = await listAllStoreProductIds();
  log.info('done', {
    indexed,
    distinctIds: ids.size,
    storeTotal: total || 'unknown',
    coverage: total ? `${((ids.size / total) * 100).toFixed(1)}%` : 'unknown',
    draws,
  });
}

main()
  .then(() => closeFetcher())
  .then(() => process.exit(0))
  .catch(async (err) => {
    log.error('seeding failed', { err: String(err), stack: (err as Error).stack });
    await closeFetcher().catch(() => undefined);
    process.exit(1);
  });
