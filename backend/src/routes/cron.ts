/**
 * The scheduled-scrape entry point.
 *
 * Called by cron-job.org every two hours with a shared secret in a header. Three
 * things matter here and they pull against each other:
 *
 *   1. The secret must be compared in constant time. A plain `===` on a string leaks
 *      its prefix through timing, and this endpoint is the only write path into the
 *      database that is reachable from the internet.
 *   2. cron-job.org gives up after 30 s, and a run of several products with retries
 *      can take longer. So the response is sent as soon as the run is *accepted* and
 *      the work continues in the background — the caller gets an acknowledgement, not
 *      a timeout, and the durable record of what happened is `cron_runs` + `scrape_logs`.
 *   3. Free-tier cron double-fires. The overlap lock is taken inside `runCycle`, and a
 *      second concurrent call gets 409 with nothing written twice.
 *
 * `?wait=1` makes it synchronous, which is what the verification steps in HANDOFF.md use.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { runCycle } from '../scraper/engine.js';
import { listCronRuns } from '../db/queries.js';

export const cronRouter = Router();

function secretMatches(provided: string | undefined): boolean {
  if (!provided || !env.cronSecret) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(env.cronSecret);
  // timingSafeEqual throws on a length mismatch, which would itself be a length oracle.
  // Hashing first makes both sides fixed-length so only the comparison is timed.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

cronRouter.post('/cron/scrape', async (req, res) => {
  const provided = (req.header('x-cron-secret') ?? req.header('authorization')?.replace(/^Bearer\s+/i, '')) ?? undefined;

  if (!secretMatches(provided)) {
    logger.warn('cron call rejected: bad or missing secret', { ip: req.ip });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const wait = req.query['wait'] === '1' || req.query['wait'] === 'true';
  const force = req.query['force'] === '1' || req.query['force'] === 'true';
  const startedAt = Date.now();

  if (wait) {
    try {
      const result = await runCycle({ triggerSource: 'cron', force });
      res.status(result.skipped ? 409 : 200).json(summarise(result, startedAt));
    } catch (err) {
      logger.error('cron run threw', { err: String(err) });
      res.status(500).json({ error: 'run_failed', message: String(err) });
    }
    return;
  }

  // Acknowledge first, work second.
  const acceptedAt = new Date().toISOString();
  let settled = false;
  const runPromise = runCycle({ triggerSource: 'cron', force });

  // Give the run a moment to take (or fail to take) the lock, so a double-fire gets a
  // truthful 409 rather than a cheerful "accepted" that quietly does nothing.
  const raced = await Promise.race([
    runPromise.then((r) => { settled = true; return r; }),
    new Promise<null>((r) => setTimeout(() => r(null), 1_500)),
  ]);

  if (raced && raced.skipped) {
    res.status(409).json({ skipped: raced.skipped, runId: raced.runId, acceptedAt });
    return;
  }
  if (raced && settled) {
    res.status(200).json(summarise(raced, startedAt));
    return;
  }

  runPromise
    .then((r) => logger.info('background cron run finished', { runId: r.runId, attempted: r.attempted, succeeded: r.succeeded }))
    .catch((err) => logger.error('background cron run failed', { err: String(err) }));

  res.status(202).json({
    accepted: true,
    acceptedAt,
    note: 'Run started. Poll GET /api/cron/runs or the per-product scrape log for the outcome.',
  });
});

cronRouter.get('/cron/runs', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 20) || 20, 100);
    const runs = await listCronRuns(limit);
    res.json({ runs });
  } catch (err) {
    next(err);
  }
});

function summarise(result: Awaited<ReturnType<typeof runCycle>>, startedAt: number): Record<string, unknown> {
  return {
    runId: result.runId,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    budgetExceeded: result.budgetExceeded,
    durationMs: Date.now() - startedAt,
    products: result.products.map((p) => ({
      storeProductId: p.storeProductId,
      name: p.name,
      outcome: p.outcome,
      attempts: p.attempts,
      strategy: p.strategy,
      price: p.price,
      currency: p.currency,
      stockStatus: p.stockStatus,
      errorCode: p.errorCode,
      structureChanged: p.structureChanged,
      durationMs: p.durationMs,
    })),
  };
}
