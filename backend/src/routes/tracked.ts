import { Router } from 'express';
import { z } from 'zod';
import {
  deleteTracked, getAttemptsForChart, getHistory, getLogs, getProductByStoreId, getTracked,
  listTracked, trackProduct, updateTracked, upsertProducts, type HistoryRange,
} from '../db/queries.js';
import type { Outcome } from '../db/types.js';
import { fetchProduct, productUrl } from '../scraper/storeClient.js';
import { runCycle } from '../scraper/engine.js';
import { logger } from '../lib/logger.js';

export const trackedRouter = Router();

const RANGES: HistoryRange[] = ['24h', '7d', '30d', 'all'];
const parseRange = (raw: unknown): HistoryRange => (RANGES.includes(raw as HistoryRange) ? (raw as HistoryRange) : '7d');

// --- list --------------------------------------------------------------------

trackedRouter.get('/tracked', async (req, res, next) => {
  try {
    const includeInactive = req.query['includeInactive'] !== 'false';
    const rows = await listTracked(includeInactive);

    // A sparkline needs points, and N+1 round trips for N products is the kind of
    // thing that makes a dashboard feel broken on a cold Render instance. One query
    // per product in parallel is the honest middle ground at this scale.
    const withSpark = await Promise.all(
      rows.map(async (row) => {
        const points = await getHistory(row.tracked_id, '7d').catch(() => []);
        return {
          ...row,
          sparkline: points.map((p) => ({ t: p.scraped_at, price: Number(p.price) })),
        };
      }),
    );

    res.json({ tracked: withSpark });
  } catch (err) {
    next(err);
  }
});

// --- start tracking ----------------------------------------------------------

const trackBody = z.object({
  storeProductId: z.union([z.string(), z.number()]).transform(String),
  scrapeIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
});

trackedRouter.post('/tracked', async (req, res, next) => {
  try {
    const parsed = trackBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
      return;
    }
    const { storeProductId, scrapeIntervalMinutes } = parsed.data;

    // Make sure the product exists locally; if not, fetch it from the store now.
    let product = await getProductByStoreId(storeProductId);
    if (!product) {
      try {
        const fromStore = await fetchProduct(storeProductId);
        const [row] = await upsertProducts([
          {
            store_product_id: String(fromStore.id),
            name: fromStore.name,
            url: productUrl(fromStore.id),
            brand: fromStore.brand ?? null,
            category: fromStore.category ?? null,
            sku: fromStore.sku ?? null,
            slug: fromStore.slug ?? null,
            description: fromStore.description ?? null,
            specs: (fromStore.specs ?? null) as Record<string, unknown> | null,
          },
        ]);
        product = row ?? null;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'PRODUCT_GONE') {
          res.status(404).json({ error: 'product_not_found', storeProductId });
          return;
        }
        throw err;
      }
    }
    if (!product) {
      res.status(404).json({ error: 'product_not_found', storeProductId });
      return;
    }

    const tracked = await trackProduct(product.id, {
      ...(scrapeIntervalMinutes ? { intervalMinutes: scrapeIntervalMinutes } : {}),
    });
    logger.info('tracking started', { storeProductId, trackedId: tracked.id, name: product.name });

    // A brand-new tracker with an empty chart is a bad first impression, and the
    // first reading is the one that tells you the pipeline works. Kick off a scrape
    // immediately, out of band, so the response stays fast.
    void runCycle({ triggerSource: 'manual', onlyTrackedId: tracked.id }).catch((err) =>
      logger.warn('first scrape after tracking failed', { trackedId: tracked.id, err: String(err) }),
    );

    const overview = await getTracked(tracked.id);
    res.status(201).json({ tracked: overview ?? tracked, firstScrape: 'started' });
  } catch (err) {
    next(err);
  }
});

// --- detail ------------------------------------------------------------------

trackedRouter.get('/tracked/:id', async (req, res, next) => {
  try {
    const row = await getTracked(String(req.params['id']));
    if (!row) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ tracked: row });
  } catch (err) {
    next(err);
  }
});

const patchBody = z.object({
  isActive: z.boolean().optional(),
  scrapeIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
  alertPriceBelow: z.number().positive().nullable().optional(),
  alertOnRestock: z.boolean().optional(),
});

trackedRouter.patch('/tracked/:id', async (req, res, next) => {
  try {
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
      return;
    }
    const p = parsed.data;
    const patch = {
      ...(p.isActive !== undefined ? { is_active: p.isActive } : {}),
      ...(p.scrapeIntervalMinutes !== undefined ? { scrape_interval_minutes: p.scrapeIntervalMinutes } : {}),
      ...(p.alertPriceBelow !== undefined ? { alert_price_below: p.alertPriceBelow } : {}),
      ...(p.alertOnRestock !== undefined ? { alert_on_restock: p.alertOnRestock } : {}),
    };
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'nothing_to_update' });
      return;
    }
    await updateTracked(String(req.params['id']), patch);
    res.json({ tracked: await getTracked(String(req.params['id'])) });
  } catch (err) {
    next(err);
  }
});

trackedRouter.delete('/tracked/:id', async (req, res, next) => {
  try {
    await deleteTracked(String(req.params['id']));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// --- history + logs ----------------------------------------------------------

trackedRouter.get('/tracked/:id/history', async (req, res, next) => {
  try {
    const id = String(req.params['id']);
    const range = parseRange(req.query['range']);

    // The chart draws the price line AND a tick for every attempt on its baseline,
    // so both come back in one response — they have to share an x-axis.
    const [points, attempts] = await Promise.all([getHistory(id, range), getAttemptsForChart(id, range)]);

    res.json({
      range,
      points: points.map((p) => ({
        t: p.scraped_at,
        price: Number(p.price),
        currency: p.currency,
        mrp: p.mrp === null ? null : Number(p.mrp),
        stockStatus: p.stock_status,
        stockQuantity: p.stock_quantity,
        logId: p.scrape_log_id,
      })),
      attempts: attempts.map((a) => ({
        t: a.started_at,
        attempt: a.attempt_number,
        outcome: a.outcome,
        strategy: a.strategy,
        durationMs: a.duration_ms,
        httpStatus: a.http_status,
        errorCode: a.error_code,
        structureChanged: a.structure_changed,
      })),
    });
  } catch (err) {
    next(err);
  }
});

trackedRouter.get('/tracked/:id/logs', async (req, res, next) => {
  try {
    const id = String(req.params['id']);
    const limit = Math.min(Number(req.query['limit'] ?? 50) || 50, 200);
    const offset = Math.max(Number(req.query['offset'] ?? 0) || 0, 0);
    const outcomeRaw = String(req.query['outcome'] ?? 'all');
    const outcome = (['success', 'retried', 'failed', 'skipped', 'all'] as const).includes(outcomeRaw as never)
      ? (outcomeRaw as Outcome | 'all')
      : 'all';

    const { rows, total } = await getLogs(id, { limit, offset, outcome });
    res.json({
      total,
      limit,
      offset,
      logs: rows.map((r) => ({
        id: r.id,
        runId: r.run_id,
        attempt: r.attempt_number,
        outcome: r.outcome,
        strategy: r.strategy,
        httpStatus: r.http_status,
        durationMs: r.duration_ms,
        errorCode: r.error_code,
        errorMessage: r.error_message,
        priceFound: r.price_found === null ? null : Number(r.price_found),
        stockFound: r.stock_found,
        structureChanged: r.structure_changed,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --- manual scrape -----------------------------------------------------------

/**
 * Run the real engine for one product, right now.
 *
 * Same code path as the cron run — same retries, same validation, same logging —
 * only the `trigger_source` differs. A "test" button that runs different code is a
 * button that tells you nothing.
 */
trackedRouter.post('/tracked/:id/scrape-now', async (req, res, next) => {
  try {
    const id = String(req.params['id']);
    const tracked = await getTracked(id);
    if (!tracked) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const stages: { stage: string; detail?: Record<string, unknown>; at: string }[] = [];
    const result = await runCycle({
      triggerSource: 'manual',
      onlyTrackedId: id,
      onStage: (e) => stages.push({ stage: e.stage, ...(e.detail ? { detail: e.detail } : {}), at: new Date().toISOString() }),
    });

    if (result.skipped) {
      res.status(409).json({ skipped: result.skipped, runId: result.runId });
      return;
    }

    res.json({ runId: result.runId, result: result.products[0] ?? null, stages });
  } catch (err) {
    next(err);
  }
});
