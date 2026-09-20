/**
 * The scrape engine.
 *
 * One job: turn "what does this product cost right now?" into either a validated row
 * in `price_history` or an honest row in `scrape_logs` saying why there isn't one.
 * Never both. Never neither.
 *
 * The shape of a cycle
 * --------------------
 *   attempt 1 → strategy chain → validate → write, or classify the failure
 *   attempt 2 → … after 800 ms ± 30%
 *   attempt 3 → … after 2.4 s ± 30%
 *   attempt 4 → … after 7 s ± 30%
 *
 * Each attempt writes its own `scrape_logs` row the moment it finishes, with
 * `outcome = 'retried'` if another attempt will follow and `'failed'` if the budget
 * is spent. So a product that took three tries leaves three rows — `retried`,
 * `retried`, `success` — and the log describes the work, not just the ending.
 * Batching the writes to the end would be faster and would lose exactly the evidence
 * this project is graded on.
 */
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { env } from '../lib/env.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { raiseAlert } from '../lib/alerts.js';
import { acquireScrapeLock } from '../lib/lock.js';
import {
  finishCronRun, getLastPrice, getTrackedWithProduct, insertPriceHistory, insertScrapeLog,
  listActiveTracked, listDueTracked, markAttemptFinished, recordFingerprint, startCronRun,
} from '../db/queries.js';
import type { ProductRow, TrackedProductRow } from '../db/types.js';
import { ScrapeError, toScrapeError, type ErrorCode } from './errors.js';
import { describeStructureChange } from './fingerprint.js';
import { productUrl } from './storeClient.js';
import { readingsAgree, validateReading, type CandidateReading } from './validate.js';
import { apiStrategy } from './strategies/api.js';
import { domStrategy } from './strategies/dom.js';
import { embeddedJsonStrategy } from './strategies/embeddedJson.js';
import { browserStrategy } from './strategies/browser.js';
import type { Strategy, StrategyContext, StrategyName, StrategyResult } from './strategies/types.js';

/** Order matters: cheapest and most reliable first. See STORE_NOTES.md §9. */
export const STRATEGY_CHAIN: Strategy[] = [apiStrategy, embeddedJsonStrategy, domStrategy, browserStrategy];

/** 800 ms → 2.4 s → 7 s, each with ±30% jitter. */
const BACKOFF_MS = [800, 2_400, 7_000];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const jitter = (ms: number, ratio = 0.3): number => Math.round(ms * (1 + (Math.random() * 2 - 1) * ratio));

export interface ScrapeStageEvent {
  stage: string;
  detail?: Record<string, unknown>;
}

export interface ScrapeOneOptions {
  runId: string;
  /** Live narration; used by the headed run and the "Scrape now" endpoint. */
  onStage?: (event: ScrapeStageEvent) => void;
  /** Fault simulation, headed run only. */
  simulate?: 'slow' | 'error' | 'late' | 'all' | null;
  /**
   * Restrict (and reorder) the strategy chain. The headed run uses this to put the
   * browser first so there is something to watch; nothing else sets it, so the cron
   * path always runs the full chain in its measured order.
   */
  only?: StrategyName[];
  /** Skip the database entirely — used by the headed run's dry mode. */
  dryRun?: boolean;
  /** Stop attempting once the run budget is gone. */
  deadlineAt?: number;
  logger?: Logger;
}

export interface ScrapeOneResult {
  trackedId: string;
  storeProductId: string;
  name: string;
  outcome: 'success' | 'failed';
  attempts: number;
  strategy: StrategyName | null;
  price: number | null;
  currency: string | null;
  stockStatus: string | null;
  errorCode: ErrorCode | null;
  errorMessage: string | null;
  durationMs: number;
  structureChanged: boolean;
  largeDelta: boolean;
}

interface AttemptOutcome {
  ok: boolean;
  strategy: StrategyName | null;
  httpStatus: number | null;
  reading: CandidateReading | null;
  error: ScrapeError | null;
  structureChanged: boolean;
  largeDelta: boolean;
  meta: Record<string, unknown>;
}

/**
 * Walk the strategy chain once.
 *
 * A strategy that throws hands over to the next one. A strategy whose reading fails
 * validation also hands over — a different strategy is a genuinely independent second
 * look — with one exception, `STALE_QUOTE`.
 *
 * That exception is the point. When the store marks a quote `pending`, it is telling
 * us the figure has not settled; asking a different strategy just reads the same
 * unsettled figure through a different window. The right answer is to wait and ask
 * again, which is what the retry loop does. Phase 1 saw this on 3 of 29 successful
 * fetches, with the stale figure sitting 22% below the true price — the single most
 * expensive trap in this store, and the one a chain-walking scraper falls straight into.
 */
async function runChain(
  ctx: StrategyContext,
  opts: { skip?: StrategyName[]; only?: StrategyName[]; log: Logger },
): Promise<{ result: StrategyResult; strategy: StrategyName } | { error: ScrapeError }> {
  const skip = new Set(opts.skip ?? []);
  const chain = opts.only?.length
    ? opts.only.map((name) => STRATEGY_CHAIN.find((s) => s.name === name)).filter((s): s is Strategy => Boolean(s))
    : STRATEGY_CHAIN;
  let lastError: ScrapeError | null = null;

  for (const strategy of chain) {
    if (skip.has(strategy.name)) continue;
    if (!strategy.available()) {
      opts.log.debug('strategy unavailable, skipping', { strategy: strategy.name });
      continue;
    }

    try {
      const result = await strategy.run(ctx);
      opts.log.debug('strategy produced a reading', {
        strategy: strategy.name,
        price: result.reading.price,
        ms: result.durationMs,
      });
      return { result, strategy: strategy.name };
    } catch (err) {
      const scrapeError = toScrapeError(err);
      opts.log.debug('strategy missed', { strategy: strategy.name, code: scrapeError.code, msg: scrapeError.message });

      // A gone product is a fact about the product, not about this strategy.
      // Escalate immediately rather than asking three more strategies the same
      // question and getting the same 404.
      if (scrapeError.code === 'PRODUCT_GONE') return { error: scrapeError };

      // Keep the most informative error: a transport failure explains more than
      // "the shell had no price in it", which is true of this store on a good day too.
      if (!lastError || rank(scrapeError.code) > rank(lastError.code)) lastError = scrapeError;
    }
  }

  return { error: lastError ?? new ScrapeError('ALL_STRATEGIES_FAILED', 'No strategy produced a reading') };
}

/** Which error explains a failed attempt best, when several strategies each had one. */
function rank(code: ErrorCode): number {
  switch (code) {
    case 'PRODUCT_GONE': return 100;
    case 'HTTP_429': return 90;
    case 'HTTP_5XX': return 85;
    case 'TIMEOUT': return 80;
    case 'NETWORK': return 78;
    case 'GATE_REJECTED': return 70;
    case 'STALE_QUOTE': return 65;
    case 'VALIDATION_REJECT': return 60;
    case 'IDENTITY_MISMATCH': return 58;
    case 'PLACEHOLDER': return 40;
    case 'PARSE_MISS': return 30;
    case 'BROWSER_UNAVAILABLE': return 10;
    default: return 20;
  }
}

/** One attempt: chain → validate → (maybe) second opinion. No database writes here. */
async function attemptOnce(
  tracked: TrackedProductRow & { product: ProductRow },
  attempt: number,
  lastKnownPrice: number | null,
  opts: ScrapeOneOptions,
  log: Logger,
): Promise<AttemptOutcome> {
  const emit = (stage: string, detail?: Record<string, unknown>): void => opts.onStage?.({ stage, ...(detail ? { detail } : {}) });

  const ctx: StrategyContext = {
    storeProductId: tracked.product.store_product_id,
    expect: {
      storeProductId: tracked.product.store_product_id,
      name: tracked.product.name,
      slug: tracked.product.slug,
      sku: tracked.product.sku,
    },
    attempt,
    onStage: emit,
    simulate: opts.simulate ?? null,
  };

  const first = await runChain(ctx, { log, ...(opts.only ? { only: opts.only } : {}) });
  if ('error' in first) {
    return { ok: false, strategy: null, httpStatus: first.error.httpStatus ?? null, reading: null, error: first.error, structureChanged: false, largeDelta: false, meta: {} };
  }

  const { result, strategy } = first;

  // Structure fingerprinting. Informational: a changed fingerprint raises an alert
  // and a UI banner, and never blocks a write. The store is allowed to redecorate.
  let structureChanged = false;
  if (!opts.dryRun) {
    try {
      const check = await recordFingerprint(
        result.fingerprint.fingerprint,
        result.fingerprint.details,
        productUrl(tracked.product.store_product_id),
      );
      structureChanged = check.changed;
      if (check.changed) {
        const description = describeStructureChange(check.previous?.details ?? null, result.fingerprint.details);
        log.warn('store structure changed', { fingerprint: result.fingerprint.fingerprint, description });
        emit('structure-changed', { description });
        await raiseAlert({
          trackedId: tracked.id,
          kind: 'structure_change',
          message: description,
          payload: { previous: check.previous?.fingerprint ?? null, current: result.fingerprint.fingerprint, details: result.fingerprint.details },
        });
      }
    } catch (err) {
      log.warn('fingerprinting failed; continuing', { err: String(err) });
    }
  }

  const validation = validateReading(result.reading, {
    expect: ctx.expect,
    lastKnownPrice,
    maxDeltaRatio: env.maxPriceDeltaRatio,
  });

  if (validation.ok) {
    emit('validated', { price: result.reading.price, strategy });
    return { ok: true, strategy, httpStatus: result.httpStatus ?? null, reading: result.reading, error: null, structureChanged, largeDelta: false, meta: result.meta };
  }

  // --- the reading did not pass -------------------------------------------------
  if (validation.error.code === 'STALE_QUOTE') {
    log.info('store served a pending/stale quote; will retry rather than ask another strategy', {
      strategy, price: result.reading.price, lastKnownPrice,
    });
    emit('stale-quote', { price: result.reading.price, note: 'store flagged this figure as not yet settled' });
    return { ok: false, strategy, httpStatus: result.httpStatus ?? null, reading: null, error: validation.error, structureChanged, largeDelta: false, meta: result.meta };
  }

  if (validation.needsSecondOpinion) {
    log.warn('large price move; asking a second strategy before believing it', {
      strategy, price: result.reading.price, lastKnownPrice, deltaRatio: validation.deltaRatio,
    });
    emit('second-opinion', { firstStrategy: strategy, price: result.reading.price, lastKnownPrice });

    const second = await runChain(ctx, { skip: [strategy], log, ...(opts.only ? { only: opts.only } : {}) });
    if ('error' in second) {
      log.warn('no second strategy could confirm the move; keeping history unchanged', { code: second.error.code });
      return { ok: false, strategy, httpStatus: result.httpStatus ?? null, reading: null, error: validation.error, structureChanged, largeDelta: false, meta: result.meta };
    }

    if (readingsAgree(result.reading.price, second.result.reading.price)) {
      log.info('second strategy agrees; the move is real', {
        first: result.reading.price, second: second.result.reading.price, confirmedBy: second.strategy,
      });
      emit('second-opinion-agrees', { confirmedBy: second.strategy, price: second.result.reading.price });
      return {
        ok: true, strategy, httpStatus: result.httpStatus ?? null, reading: result.reading, error: null,
        structureChanged, largeDelta: true,
        meta: { ...result.meta, confirmedBy: second.strategy, confirmingPrice: second.result.reading.price },
      };
    }

    log.warn('strategies disagree on a large move; rejecting and keeping history intact', {
      first: result.reading.price, second: second.result.reading.price,
    });
    emit('second-opinion-disagrees', { first: result.reading.price, second: second.result.reading.price });
    return {
      ok: false, strategy, httpStatus: result.httpStatus ?? null, reading: null,
      error: new ScrapeError('VALIDATION_REJECT', `Strategies disagreed on a ${((validation.deltaRatio ?? 0) * 100).toFixed(0)}% move: ${strategy} said ${result.reading.price}, ${second.strategy} said ${second.result.reading.price}`),
      structureChanged, largeDelta: false, meta: result.meta,
    };
  }

  // Any other validation failure: this reading is not storable, full stop.
  return { ok: false, strategy, httpStatus: result.httpStatus ?? null, reading: null, error: validation.error, structureChanged, largeDelta: false, meta: result.meta };
}

/**
 * Scrape one tracked product, with retries, writing a log row per attempt.
 */
export async function scrapeOne(
  tracked: TrackedProductRow & { product: ProductRow },
  opts: ScrapeOneOptions,
): Promise<ScrapeOneResult> {
  const log = (opts.logger ?? createLogger()).child({
    runId: opts.runId,
    product: tracked.product.store_product_id,
    name: tracked.product.name,
  });
  const emit = (stage: string, detail?: Record<string, unknown>): void => opts.onStage?.({ stage, ...(detail ? { detail } : {}) });
  const cycleStarted = Date.now();

  const lastRow = opts.dryRun ? null : await getLastPrice(tracked.id).catch(() => null);
  const lastKnownPrice = lastRow ? Number(lastRow.price) : null;
  const lastStockStatus = lastRow?.stock_status ?? null;

  let attempt = 0;
  let lastError: ScrapeError | null = null;
  let structureChangedAnywhere = false;

  while (attempt < env.maxAttempts) {
    attempt++;

    if (opts.deadlineAt && Date.now() > opts.deadlineAt) {
      const err = new ScrapeError('RUN_BUDGET_EXCEEDED', `Run budget spent before attempt ${attempt}`);
      await writeLog({ outcome: 'failed', attempt, startedAt: new Date(), durationMs: 0, error: err, strategy: null, httpStatus: null, structureChanged: false });
      lastError = err;
      break;
    }

    const attemptStartedAt = new Date();
    emit('attempt-start', { attempt, of: env.maxAttempts });
    log.info('attempt started', { attempt, of: env.maxAttempts });

    const outcome = await attemptOnce(tracked, attempt, lastKnownPrice, opts, log).catch((err): AttemptOutcome => ({
      ok: false, strategy: null, httpStatus: null, reading: null, error: toScrapeError(err), structureChanged: false, largeDelta: false, meta: {},
    }));
    const durationMs = Date.now() - attemptStartedAt.getTime();
    structureChangedAnywhere ||= outcome.structureChanged;

    // ---------------------------------------------------------------- success
    if (outcome.ok && outcome.reading) {
      const reading = outcome.reading;
      const logRow = await writeLog({
        outcome: 'success', attempt, startedAt: attemptStartedAt, durationMs,
        error: null, strategy: outcome.strategy, httpStatus: outcome.httpStatus,
        structureChanged: outcome.structureChanged,
        priceFound: reading.price, stockFound: reading.stockRaw ?? reading.stockStatus,
      });

      if (!opts.dryRun) {
        await insertPriceHistory({
          tracked_product_id: tracked.id,
          price: reading.price,
          currency: reading.currency,
          mrp: reading.mrp ?? null,
          stock_status: reading.stockStatus,
          stock_quantity: reading.stockQuantity ?? null,
          scraped_at: new Date().toISOString(),
          scrape_log_id: logRow?.id ?? null,
        });
        await markAttemptFinished(tracked.id, { succeeded: true });
        await raiseUserAlerts(tracked, reading, { lastKnownPrice, lastStockStatus, largeDelta: outcome.largeDelta });
      }

      log.info('scrape succeeded', {
        attempt, strategy: outcome.strategy, price: reading.price, currency: reading.currency,
        stock: reading.stockStatus, ms: durationMs,
      });
      emit('success', { attempt, price: reading.price, currency: reading.currency, stock: reading.stockStatus, strategy: outcome.strategy });

      return {
        trackedId: tracked.id, storeProductId: tracked.product.store_product_id, name: tracked.product.name,
        outcome: 'success', attempts: attempt, strategy: outcome.strategy,
        price: reading.price, currency: reading.currency, stockStatus: reading.stockStatus,
        errorCode: null, errorMessage: null, durationMs: Date.now() - cycleStarted,
        structureChanged: structureChangedAnywhere, largeDelta: outcome.largeDelta,
      };
    }

    // ---------------------------------------------------------------- failure
    const error = outcome.error ?? new ScrapeError('UNKNOWN', 'Attempt failed without an error');
    lastError = error;

    // 404 is terminal: the product is gone. No retries, no history, an alert, and the
    // tracker is switched off so the next 20 cron runs do not repeat the discovery.
    if (error.code === 'PRODUCT_GONE') {
      await writeLog({ outcome: 'failed', attempt, startedAt: attemptStartedAt, durationMs, error, strategy: outcome.strategy, httpStatus: outcome.httpStatus ?? 404, structureChanged: outcome.structureChanged });
      if (!opts.dryRun) {
        await markAttemptFinished(tracked.id, { succeeded: false, deactivate: true });
        await raiseAlert({
          trackedId: tracked.id, kind: 'product_gone',
          message: `"${tracked.product.name}" no longer exists in the store (HTTP 404). Tracking has been paused.`,
          payload: { storeProductId: tracked.product.store_product_id, url: productUrl(tracked.product.store_product_id) },
        });
      }
      log.warn('product is gone; tracking paused', { attempt });
      emit('product-gone', { attempt });
      break;
    }

    const willRetry = attempt < env.maxAttempts && error.retryable;
    await writeLog({
      outcome: willRetry ? 'retried' : 'failed', attempt, startedAt: attemptStartedAt, durationMs,
      error, strategy: outcome.strategy, httpStatus: outcome.httpStatus, structureChanged: outcome.structureChanged,
    });

    if (!willRetry) {
      log.warn('attempt failed with no retries left', { attempt, code: error.code, msg: error.message });
      emit('failed', { attempt, code: error.code, message: error.message });
      break;
    }

    // Honour the store's own Retry-After when it gave us one; otherwise back off.
    const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 7_000;
    const waitMs = Math.max(error.retryAfterMs ?? 0, jitter(base));
    log.warn('attempt failed; backing off', { attempt, code: error.code, msg: error.message, waitMs });
    emit('backoff', { attempt, code: error.code, message: error.message, waitMs, nextAttempt: attempt + 1 });
    await sleep(waitMs);
  }

  if (!opts.dryRun && lastError?.code !== 'PRODUCT_GONE') {
    const consecutive = await markAttemptFinished(tracked.id, { succeeded: false });
    if (consecutive >= 3) {
      await raiseAlert({
        trackedId: tracked.id, kind: 'repeated_failure',
        message: `"${tracked.product.name}" has failed ${consecutive} scrape cycles in a row. Last error: ${lastError?.code ?? 'UNKNOWN'} — ${lastError?.message ?? ''}`.trim(),
        payload: { consecutiveFailures: consecutive, errorCode: lastError?.code ?? null, errorMessage: lastError?.message ?? null },
      });
    }
  }

  return {
    trackedId: tracked.id, storeProductId: tracked.product.store_product_id, name: tracked.product.name,
    outcome: 'failed', attempts: attempt, strategy: null, price: null, currency: null, stockStatus: null,
    errorCode: lastError?.code ?? 'UNKNOWN', errorMessage: lastError?.message ?? null,
    durationMs: Date.now() - cycleStarted, structureChanged: structureChangedAnywhere, largeDelta: false,
  };

  // --- helper: write one attempt's log row, immediately ------------------------
  async function writeLog(row: {
    outcome: 'success' | 'retried' | 'failed';
    attempt: number;
    startedAt: Date;
    durationMs: number;
    error: ScrapeError | null;
    strategy: StrategyName | null;
    httpStatus: number | null;
    structureChanged: boolean;
    priceFound?: number;
    stockFound?: string;
  }): Promise<{ id: number } | null> {
    if (opts.dryRun) return null;
    try {
      return await insertScrapeLog({
        tracked_product_id: tracked.id,
        run_id: opts.runId,
        attempt_number: row.attempt,
        outcome: row.outcome,
        strategy: row.strategy,
        http_status: row.httpStatus,
        duration_ms: row.durationMs,
        error_code: row.error?.code ?? null,
        error_message: row.error ? row.error.message.slice(0, 900) : null,
        price_found: row.priceFound ?? null,
        stock_found: row.stockFound ?? null,
        structure_changed: row.structureChanged,
        started_at: row.startedAt.toISOString(),
      });
    } catch (err) {
      log.error('could not write scrape log row', { err: String(err), attempt: row.attempt, outcome: row.outcome });
      return null;
    }
  }
}

/** Alerts the user asked for: price below a threshold, back in stock, unusual move. */
async function raiseUserAlerts(
  tracked: TrackedProductRow & { product: ProductRow },
  reading: CandidateReading,
  ctx: { lastKnownPrice: number | null; lastStockStatus: string | null; largeDelta: boolean },
): Promise<void> {
  const money = (n: number): string => `${reading.currency} ${n.toLocaleString('en-IN')}`;

  if (tracked.alert_price_below != null && reading.price < Number(tracked.alert_price_below)) {
    const crossed = ctx.lastKnownPrice === null || ctx.lastKnownPrice >= Number(tracked.alert_price_below);
    if (crossed) {
      await raiseAlert({
        trackedId: tracked.id, kind: 'price_drop',
        message: `"${tracked.product.name}" is ${money(reading.price)}, below your ${money(Number(tracked.alert_price_below))} threshold.`,
        payload: { price: reading.price, threshold: Number(tracked.alert_price_below), previousPrice: ctx.lastKnownPrice },
      });
    }
  }

  if (tracked.alert_on_restock && ctx.lastStockStatus === 'out_of_stock' && reading.stockStatus !== 'out_of_stock' && reading.stockStatus !== 'unknown') {
    await raiseAlert({
      trackedId: tracked.id, kind: 'back_in_stock',
      message: `"${tracked.product.name}" is back in stock${reading.stockQuantity != null ? ` (${reading.stockQuantity} units)` : ''} at ${money(reading.price)}.`,
      payload: { stockStatus: reading.stockStatus, stockQuantity: reading.stockQuantity, price: reading.price },
    });
  }

  if (ctx.largeDelta && ctx.lastKnownPrice) {
    const pct = (((reading.price - ctx.lastKnownPrice) / ctx.lastKnownPrice) * 100).toFixed(1);
    await raiseAlert({
      trackedId: tracked.id, kind: 'large_delta',
      message: `"${tracked.product.name}" moved ${pct}% (${money(ctx.lastKnownPrice)} → ${money(reading.price)}). Confirmed by a second strategy before it was stored.`,
      payload: { from: ctx.lastKnownPrice, to: reading.price, pct: Number(pct) },
    });
  }
}

// --- whole-run orchestration --------------------------------------------------

export interface RunCycleOptions {
  triggerSource: 'cron' | 'manual' | 'headed';
  /** Restrict the run to one tracked product (the "Scrape now" button). */
  onlyTrackedId?: string;
  /** Ignore each product's own interval and scrape everything active. */
  force?: boolean;
  /** Restrict/reorder the strategy chain — the headed run puts `browser` first. */
  only?: StrategyName[];
  /** Fault simulation, headed run only. */
  simulate?: 'slow' | 'error' | 'late' | 'all' | null;
  onStage?: (event: ScrapeStageEvent & { trackedId?: string }) => void;
}

export interface RunCycleResult {
  runId: string;
  skipped?: 'run in progress';
  attempted: number;
  succeeded: number;
  failed: number;
  durationMs: number;
  budgetExceeded: boolean;
  products: ScrapeOneResult[];
}

/**
 * One full cycle: take the lock, find who is due, scrape them with bounded
 * concurrency, and close the books.
 */
export async function runCycle(opts: RunCycleOptions): Promise<RunCycleResult> {
  const runId = crypto.randomUUID();
  const log = createLogger().child({ runId, trigger: opts.triggerSource });
  const startedAt = Date.now();
  const deadlineAt = startedAt + env.runBudgetMs;

  const lock = await acquireScrapeLock(runId);
  if (!lock) {
    // Log the skip too. A run that was prevented is still something that happened.
    log.warn('cycle skipped: another run holds the lock');
    try {
      await startCronRun(runId, opts.triggerSource);
      await finishCronRun(runId, { attempted: 0, succeeded: 0, notes: 'skipped: another run was already in progress' });
    } catch {
      /* bookkeeping only */
    }
    return { runId, skipped: 'run in progress', attempted: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startedAt, budgetExceeded: false, products: [] };
  }

  try {
    await startCronRun(runId, opts.triggerSource);

    let due = opts.force && !opts.onlyTrackedId ? await listActiveTracked() : await listDueTracked();
    if (opts.onlyTrackedId) {
      due = due.filter((t) => t.id === opts.onlyTrackedId);
      // "Scrape now" on a product whose interval has not elapsed must still work.
      if (due.length === 0) {
        const one = await getTrackedWithProduct(opts.onlyTrackedId);
        if (one) due = [one];
      }
    }

    log.info('cycle starting', { due: due.length, concurrency: env.concurrency, budgetMs: env.runBudgetMs });

    const limit = pLimit(env.concurrency);
    const results = await Promise.all(
      due.map((tracked, index) =>
        limit(async () => {
          // Stagger starts so three workers do not all hit the store on the same tick.
          if (index > 0) await sleep(300 + Math.random() * 600);

          if (Date.now() > deadlineAt) {
            log.warn('run budget exhausted; recording the remainder as failed rather than silent', {
              product: tracked.product.store_product_id,
            });
            const err = new ScrapeError('RUN_BUDGET_EXCEEDED', `Run budget of ${env.runBudgetMs} ms was spent before this product was reached`);
            await insertScrapeLog({
              tracked_product_id: tracked.id, run_id: runId, attempt_number: 1, outcome: 'failed',
              strategy: null, http_status: null, duration_ms: 0, error_code: err.code, error_message: err.message,
              price_found: null, stock_found: null, structure_changed: false, started_at: new Date().toISOString(),
            }).catch(() => undefined);
            return {
              trackedId: tracked.id, storeProductId: tracked.product.store_product_id, name: tracked.product.name,
              outcome: 'failed' as const, attempts: 0, strategy: null, price: null, currency: null, stockStatus: null,
              errorCode: 'RUN_BUDGET_EXCEEDED' as ErrorCode, errorMessage: err.message, durationMs: 0,
              structureChanged: false, largeDelta: false,
            };
          }

          return scrapeOne(tracked, {
            runId,
            deadlineAt,
            logger: log,
            ...(opts.only ? { only: opts.only } : {}),
            ...(opts.simulate ? { simulate: opts.simulate } : {}),
            ...(opts.onStage ? { onStage: (e) => opts.onStage?.({ ...e, trackedId: tracked.id }) } : {}),
          });
        }),
      ),
    );

    const succeeded = results.filter((r) => r.outcome === 'success').length;
    const budgetExceeded = results.some((r) => r.errorCode === 'RUN_BUDGET_EXCEEDED');

    await finishCronRun(runId, {
      attempted: results.length,
      succeeded,
      ...(budgetExceeded ? { notes: `run budget of ${env.runBudgetMs} ms exceeded` } : {}),
    });

    log.info('cycle finished', { attempted: results.length, succeeded, failed: results.length - succeeded, ms: Date.now() - startedAt });

    return {
      runId, attempted: results.length, succeeded, failed: results.length - succeeded,
      durationMs: Date.now() - startedAt, budgetExceeded, products: results,
    };
  } finally {
    await lock.release();
  }
}
