import { Router } from 'express';
import { env } from '../lib/env.js';
import { isDbConfigured } from '../db/client.js';
import { getLastCronRun } from '../db/queries.js';

export const healthRouter = Router();

const bootedAt = Date.now();

healthRouter.get('/health', async (_req, res) => {
  let lastRunAt: string | null = null;
  let dbOk = false;

  if (isDbConfigured()) {
    try {
      const run = await getLastCronRun();
      lastRunAt = run?.started_at ?? null;
      dbOk = true;
    } catch {
      dbOk = false;
    }
  }

  // The service is "up" as long as it can serve. A database that is briefly
  // unreachable is reported, not fatal — Render restarting the instance because
  // Supabase hiccuped would turn a 20-second blip into a two-minute cold start.
  res.json({
    ok: true,
    version: env.version,
    env: env.nodeEnv,
    uptimeSeconds: Math.round((Date.now() - bootedAt) / 1000),
    database: dbOk ? 'reachable' : isDbConfigured() ? 'unreachable' : 'not configured',
    store: env.storeBaseUrl,
    lastRunAt,
    now: new Date().toISOString(),
  });
});

/**
 * Cheap warm-up ping, hit every 10 minutes by a second cron job.
 *
 * Render's free tier sleeps after 15 minutes idle and takes ~50 s to wake. A scrape
 * that has to pay that first would eat a fifth of its own budget before making a
 * single request.
 */
healthRouter.get('/cron/keepalive', (_req, res) => {
  res.status(200).json({ ok: true, at: new Date().toISOString() });
});
