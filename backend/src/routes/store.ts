/**
 * Live search against the store's catalogue.
 *
 * The store has no search endpoint, and `/api/catalog` returns a fresh random sample
 * on every call with the `page` parameter ignored (STORE_NOTES.md §3). So search runs
 * against our own ingested copy of the catalogue, ranked by trigram similarity in
 * Postgres. That is also what makes partial-name matching work: "slimbook", "nord",
 * "NOR-10015" and "sleep tracker" all find something.
 *
 * If the local index is cold, the endpoint falls back to sampling the live store so a
 * fresh deployment is still usable before the seeder has finished.
 */
import { Router } from 'express';
import { countProducts, searchProducts, upsertProducts } from '../db/queries.js';
import { fetchCatalogSample, productUrl } from '../scraper/storeClient.js';
import { logger } from '../lib/logger.js';

export const storeRouter = Router();

interface SearchHit {
  storeProductId: string;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
  slug: string | null;
  url: string;
  score: number;
}

storeRouter.get('/store/search', async (req, res, next) => {
  try {
    const q = String(req.query['q'] ?? '').trim();
    const limit = Math.min(Number(req.query['limit'] ?? 12) || 12, 40);

    if (q.length < 2) {
      res.json({ query: q, source: 'none', results: [], indexed: await countProducts().catch(() => 0) });
      return;
    }

    const indexed = await countProducts().catch(() => 0);
    if (indexed > 0) {
      const rows = await searchProducts(q, limit);
      const results: SearchHit[] = rows.map((r) => ({
        storeProductId: r.store_product_id,
        name: r.name,
        brand: r.brand,
        category: r.category,
        sku: r.sku,
        slug: r.slug,
        url: r.url,
        score: Number(r.score ?? 0),
      }));
      res.json({ query: q, source: 'index', indexed, results });
      return;
    }

    // Cold index: sample the live store so the UI still works, and keep what we saw.
    logger.warn('search ran against a cold index; sampling the live store', { q });
    const sample = await fetchCatalogSample(60);
    const needle = q.toLowerCase();
    const matches = sample.items.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.brand?.toLowerCase().includes(needle) ||
        p.sku?.toLowerCase().includes(needle),
    );
    await upsertProducts(
      sample.items.map((p) => ({
        store_product_id: String(p.id),
        name: p.name,
        url: productUrl(p.id),
        brand: p.brand ?? null,
        category: p.category ?? null,
        sku: p.sku ?? null,
        slug: p.slug ?? null,
        description: p.description ?? null,
      })),
    ).catch(() => undefined);

    res.json({
      query: q,
      source: 'live-sample',
      indexed,
      note: 'The catalogue index is still being built; these results come from a live sample of the store.',
      results: matches.slice(0, limit).map<SearchHit>((p) => ({
        storeProductId: String(p.id),
        name: p.name,
        brand: p.brand ?? null,
        category: p.category ?? null,
        sku: p.sku ?? null,
        slug: p.slug ?? null,
        url: productUrl(p.id),
        score: 0.5,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Index size, shown in the UI's empty state so "no results" is explicable. */
storeRouter.get('/store/index-status', async (_req, res, next) => {
  try {
    res.json({ indexed: await countProducts(), expected: 1000 });
  } catch (err) {
    next(err);
  }
});
