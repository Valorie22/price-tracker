/**
 * The overlap lock.
 *
 * Free-tier cron services double-fire — cron-job.org retries on a slow response, and
 * Render keeps the old instance alive for a moment during a deploy. Two runs scraping
 * the same product simultaneously produce two history rows for one moment in time and
 * race each other's `consecutive_failures` counter.
 *
 * The lock is a single row taken with `INSERT ... ON CONFLICT ... WHERE`, which is
 * atomic in Postgres: either you get the row back or somebody else holds it. See
 * `db/schema.sql` for why this is used instead of `pg_try_advisory_lock` (PostgREST
 * gives every call its own transaction on a pooled connection, so a session-level
 * advisory lock would be released before the run even starts).
 *
 * The lock is stale after 10 minutes, so a crashed run cannot wedge the scheduler
 * permanently — the next cron tick takes over.
 */
import { releaseLock, tryAcquireLock } from '../db/queries.js';
import { logger } from './logger.js';

export const LOCK_STALE_SECONDS = 600;

export interface LockHandle {
  runId: string;
  release(): Promise<void>;
}

export async function acquireScrapeLock(runId: string): Promise<LockHandle | null> {
  const got = await tryAcquireLock(runId, LOCK_STALE_SECONDS);
  if (!got) {
    logger.warn('scrape lock is held by another run', { runId });
    return null;
  }
  logger.debug('scrape lock acquired', { runId });
  return {
    runId,
    release: async () => {
      try {
        await releaseLock(runId);
        logger.debug('scrape lock released', { runId });
      } catch (err) {
        // A lock we cannot release expires on its own in LOCK_STALE_SECONDS.
        logger.warn('failed to release scrape lock; it will expire', { runId, err: String(err) });
      }
    },
  };
}
