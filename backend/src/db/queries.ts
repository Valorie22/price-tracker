/**
 * Every query the app makes, in one place, typed.
 *
 * Two rules hold throughout:
 *   - `insertScrapeLog` is called as each attempt finishes, never batched. A run that
 *     crashes mid-flight must still leave evidence of what it had done.
 *   - `insertPriceHistory` is only ever called from the one place in engine.ts that
 *     has a passing validation result in hand.
 */
import { db, unwrap } from './client.js';
import type {
  AlertKind, AlertRow, CronRunRow, Outcome, PriceHistoryRow, ProductRow,
  ScrapeLogRow, TrackedOverviewRow, TrackedProductRow,
} from './types.js';
import type { ErrorCode } from '../scraper/errors.js';
import type { StockStatus } from '../scraper/parse.js';
import type { StrategyName } from '../scraper/strategies/types.js';

// --- products ----------------------------------------------------------------

export interface ProductUpsert {
  store_product_id: string;
  name: string;
  url: string;
  brand?: string | null;
  category?: string | null;
  sku?: string | null;
  slug?: string | null;
  description?: string | null;
  specs?: Record<string, unknown> | null;
  image_url?: string | null;
}

export async function upsertProducts(rows: ProductUpsert[]): Promise<ProductRow[]> {
  if (rows.length === 0) return [];
  const res = await db()
    .from('products')
    .upsert(
      rows.map((r) => ({ ...r, last_seen_at: new Date().toISOString() })),
      { onConflict: 'store_product_id' },
    )
    .select();
  return unwrap('upsertProducts', res) as ProductRow[];
}

export async function getProductByStoreId(storeProductId: string): Promise<ProductRow | null> {
  const res = await db().from('products').select('*').eq('store_product_id', storeProductId).maybeSingle();
  if (res.error) throw new Error(`getProductByStoreId: ${res.error.message}`);
  return (res.data as ProductRow | null) ?? null;
}

export async function countProducts(): Promise<number> {
  const res = await db().from('products').select('*', { count: 'exact', head: true });
  if (res.error) throw new Error(`countProducts: ${res.error.message}`);
  return res.count ?? 0;
}

/** Trigram + prefix search, ranked in Postgres. */
export async function searchProducts(query: string, limit = 12): Promise<(ProductRow & { score: number })[]> {
  const res = await db().rpc('search_products', { q: query, lim: limit });
  if (res.error) throw new Error(`searchProducts: ${res.error.message}`);
  return (res.data ?? []) as (ProductRow & { score: number })[];
}

export async function listAllStoreProductIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const res = await db().from('products').select('store_product_id').range(from, from + pageSize - 1);
    if (res.error) throw new Error(`listAllStoreProductIds: ${res.error.message}`);
    const batch = (res.data ?? []) as { store_product_id: string }[];
    for (const row of batch) ids.add(row.store_product_id);
    if (batch.length < pageSize) break;
  }
  return ids;
}

// --- tracked products --------------------------------------------------------

export async function listTracked(includeInactive = true): Promise<TrackedOverviewRow[]> {
  let q = db().from('tracked_overview').select('*').order('created_at', { ascending: false });
  if (!includeInactive) q = q.eq('is_active', true);
  const res = await q;
  return unwrap('listTracked', res) as TrackedOverviewRow[];
}

export async function getTracked(trackedId: string): Promise<TrackedOverviewRow | null> {
  const res = await db().from('tracked_overview').select('*').eq('tracked_id', trackedId).maybeSingle();
  if (res.error) throw new Error(`getTracked: ${res.error.message}`);
  return (res.data as TrackedOverviewRow | null) ?? null;
}

export async function trackProduct(productId: string, opts: { intervalMinutes?: number } = {}): Promise<TrackedProductRow> {
  const res = await db()
    .from('tracked_products')
    .upsert(
      { product_id: productId, is_active: true, scrape_interval_minutes: opts.intervalMinutes ?? 120 },
      { onConflict: 'product_id' },
    )
    .select()
    .single();
  return unwrap('trackProduct', res) as TrackedProductRow;
}

export interface TrackedPatch {
  is_active?: boolean;
  scrape_interval_minutes?: number;
  alert_price_below?: number | null;
  alert_on_restock?: boolean;
}

export async function updateTracked(trackedId: string, patch: TrackedPatch): Promise<TrackedProductRow> {
  const res = await db().from('tracked_products').update(patch).eq('id', trackedId).select().single();
  return unwrap('updateTracked', res) as TrackedProductRow;
}

export async function deleteTracked(trackedId: string): Promise<void> {
  const res = await db().from('tracked_products').delete().eq('id', trackedId);
  if (res.error) throw new Error(`deleteTracked: ${res.error.message}`);
}

/**
 * Tracked products whose own interval has elapsed.
 *
 * Per-product frequency is honoured here rather than in the cron schedule: the cron
 * fires every two hours and this decides who is actually due, so a product set to
 * 30 minutes is simply picked up by whichever run comes after its interval elapses.
 */
export async function listDueTracked(now = new Date()): Promise<(TrackedProductRow & { product: ProductRow })[]> {
  const res = await db()
    .from('tracked_products')
    .select('*, product:products(*)')
    .eq('is_active', true)
    .order('last_scraped_at', { ascending: true, nullsFirst: true });
  const rows = unwrap('listDueTracked', res) as (TrackedProductRow & { product: ProductRow })[];

  return rows.filter((row) => {
    if (!row.last_scraped_at) return true;
    const elapsedMin = (now.getTime() - Date.parse(row.last_scraped_at)) / 60_000;
    // 60 s of slack: cron never fires at exactly the same offset twice, and a product
    // on a 120-minute interval should not be skipped for a whole cycle because the
    // trigger arrived 400 ms early.
    return elapsedMin >= row.scrape_interval_minutes - 1;
  });
}

export async function getTrackedWithProduct(trackedId: string): Promise<(TrackedProductRow & { product: ProductRow }) | null> {
  const res = await db().from('tracked_products').select('*, product:products(*)').eq('id', trackedId).maybeSingle();
  if (res.error) throw new Error(`getTrackedWithProduct: ${res.error.message}`);
  return (res.data as (TrackedProductRow & { product: ProductRow }) | null) ?? null;
}

export async function markAttemptFinished(
  trackedId: string,
  update: { succeeded: boolean; at?: Date; deactivate?: boolean },
): Promise<number> {
  const at = (update.at ?? new Date()).toISOString();
  const current = await db().from('tracked_products').select('consecutive_failures').eq('id', trackedId).maybeSingle();
  const previousFailures = ((current.data as { consecutive_failures?: number } | null)?.consecutive_failures) ?? 0;
  const consecutive = update.succeeded ? 0 : previousFailures + 1;

  const patch: Record<string, unknown> = {
    last_scraped_at: at,
    consecutive_failures: consecutive,
    ...(update.succeeded ? { last_success_at: at } : {}),
    ...(update.deactivate ? { is_active: false } : {}),
  };
  const res = await db().from('tracked_products').update(patch).eq('id', trackedId);
  if (res.error) throw new Error(`markAttemptFinished: ${res.error.message}`);
  return consecutive;
}

// --- price history -----------------------------------------------------------

export interface PriceHistoryInsert {
  tracked_product_id: string;
  price: number;
  currency: string;
  mrp?: number | null;
  stock_status: StockStatus;
  stock_quantity?: number | null;
  scraped_at?: string;
  scrape_log_id?: number | null;
}

export async function insertPriceHistory(row: PriceHistoryInsert): Promise<PriceHistoryRow> {
  const res = await db().from('price_history').insert(row).select().single();
  return unwrap('insertPriceHistory', res) as PriceHistoryRow;
}

export async function getLastPrice(trackedId: string): Promise<PriceHistoryRow | null> {
  const res = await db()
    .from('price_history')
    .select('*')
    .eq('tracked_product_id', trackedId)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (res.error) throw new Error(`getLastPrice: ${res.error.message}`);
  return (res.data as PriceHistoryRow | null) ?? null;
}

export type HistoryRange = '24h' | '7d' | '30d' | 'all';

const RANGE_MS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 24 * 3600_000,
  '30d': 30 * 24 * 3600_000,
};

export async function getHistory(trackedId: string, range: HistoryRange = '7d'): Promise<PriceHistoryRow[]> {
  let q = db().from('price_history').select('*').eq('tracked_product_id', trackedId).order('scraped_at', { ascending: true });
  if (range !== 'all') q = q.gte('scraped_at', new Date(Date.now() - RANGE_MS[range]).toISOString());
  const res = await q.limit(5000);
  return unwrap('getHistory', res) as PriceHistoryRow[];
}

// --- scrape logs -------------------------------------------------------------

export interface ScrapeLogInsert {
  tracked_product_id: string | null;
  run_id: string;
  attempt_number: number;
  outcome: Outcome;
  strategy?: StrategyName | null;
  http_status?: number | null;
  duration_ms: number;
  error_code?: ErrorCode | null;
  error_message?: string | null;
  price_found?: number | null;
  stock_found?: string | null;
  structure_changed?: boolean;
  started_at: string;
}

export async function insertScrapeLog(row: ScrapeLogInsert): Promise<ScrapeLogRow> {
  const res = await db().from('scrape_logs').insert(row).select().single();
  return unwrap('insertScrapeLog', res) as ScrapeLogRow;
}

export async function getLogs(
  trackedId: string,
  opts: { limit?: number; offset?: number; outcome?: Outcome | 'all' } = {},
): Promise<{ rows: ScrapeLogRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = opts.offset ?? 0;

  let q = db()
    .from('scrape_logs')
    .select('*', { count: 'exact' })
    .eq('tracked_product_id', trackedId)
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.outcome && opts.outcome !== 'all') q = q.eq('outcome', opts.outcome);

  const res = await q;
  if (res.error) throw new Error(`getLogs: ${res.error.message}`);
  return { rows: (res.data ?? []) as ScrapeLogRow[], total: res.count ?? 0 };
}

/** All attempts in a range, for the strip chart's baseline ticks. */
export async function getAttemptsForChart(trackedId: string, range: HistoryRange = '7d'): Promise<ScrapeLogRow[]> {
  let q = db()
    .from('scrape_logs')
    .select('*')
    .eq('tracked_product_id', trackedId)
    .order('started_at', { ascending: true });
  if (range !== 'all') q = q.gte('started_at', new Date(Date.now() - RANGE_MS[range]).toISOString());
  const res = await q.limit(3000);
  return unwrap('getAttemptsForChart', res) as ScrapeLogRow[];
}

export async function getRecentLogs(limit = 100): Promise<ScrapeLogRow[]> {
  const res = await db().from('scrape_logs').select('*').order('started_at', { ascending: false }).limit(limit);
  return unwrap('getRecentLogs', res) as ScrapeLogRow[];
}

// --- fingerprints ------------------------------------------------------------

export interface FingerprintCheck {
  changed: boolean;
  previous: { fingerprint: string; details: Record<string, unknown> | null } | null;
}

/**
 * Record a fingerprint and say whether it differs from the most recent one.
 *
 * "Most recent" is by `last_seen_at`, so the store flipping back to a shape we have
 * seen before still registers as a change — which is what you want, because the
 * scraper's selectors just moved under it either way.
 */
export async function recordFingerprint(
  fingerprint: string,
  details: Record<string, unknown>,
  sampleUrl: string,
): Promise<FingerprintCheck> {
  const latest = await db()
    .from('structure_fingerprints')
    .select('fingerprint, details')
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw new Error(`recordFingerprint(read): ${latest.error.message}`);

  const previous = (latest.data as { fingerprint: string; details: Record<string, unknown> | null } | null) ?? null;
  const changed = previous !== null && previous.fingerprint !== fingerprint;

  const existing = await db()
    .from('structure_fingerprints')
    .select('id, occurrences')
    .eq('fingerprint', fingerprint)
    .maybeSingle();
  if (existing.error) throw new Error(`recordFingerprint(lookup): ${existing.error.message}`);

  const row = existing.data as { id: number; occurrences: number } | null;
  if (row) {
    const upd = await db()
      .from('structure_fingerprints')
      .update({ last_seen_at: new Date().toISOString(), occurrences: row.occurrences + 1, details, sample_url: sampleUrl })
      .eq('id', row.id);
    if (upd.error) throw new Error(`recordFingerprint(update): ${upd.error.message}`);
  } else {
    const ins = await db().from('structure_fingerprints').insert({ fingerprint, details, sample_url: sampleUrl });
    if (ins.error) throw new Error(`recordFingerprint(insert): ${ins.error.message}`);
  }

  return { changed, previous };
}

export async function listFingerprints(limit = 20): Promise<
  { id: number; fingerprint: string; details: Record<string, unknown> | null; first_seen_at: string; last_seen_at: string; occurrences: number }[]
> {
  const res = await db().from('structure_fingerprints').select('*').order('last_seen_at', { ascending: false }).limit(limit);
  return unwrap('listFingerprints', res) as never;
}

// --- alerts ------------------------------------------------------------------

export async function insertAlert(row: {
  tracked_product_id: string | null;
  kind: AlertKind;
  message: string;
  payload?: Record<string, unknown> | null;
}): Promise<AlertRow> {
  const res = await db().from('alerts').insert(row).select().single();
  return unwrap('insertAlert', res) as AlertRow;
}

export async function listAlerts(opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<AlertRow[]> {
  let q = db().from('alerts').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 100);
  if (opts.unreadOnly) q = q.is('read_at', null);
  const res = await q;
  return unwrap('listAlerts', res) as AlertRow[];
}

export async function markAlertRead(id: number): Promise<void> {
  const res = await db().from('alerts').update({ read_at: new Date().toISOString() }).eq('id', id);
  if (res.error) throw new Error(`markAlertRead: ${res.error.message}`);
}

export async function markAlertEmailed(id: number): Promise<void> {
  const res = await db().from('alerts').update({ email_sent_at: new Date().toISOString() }).eq('id', id);
  if (res.error) throw new Error(`markAlertEmailed: ${res.error.message}`);
}

/** Avoid re-alerting for a condition that is still the same condition. */
export async function hasRecentAlert(trackedId: string | null, kind: AlertKind, withinMinutes: number): Promise<boolean> {
  let q = db()
    .from('alerts')
    .select('id')
    .eq('kind', kind)
    .gte('created_at', new Date(Date.now() - withinMinutes * 60_000).toISOString())
    .limit(1);
  q = trackedId === null ? q.is('tracked_product_id', null) : q.eq('tracked_product_id', trackedId);
  const res = await q;
  if (res.error) throw new Error(`hasRecentAlert: ${res.error.message}`);
  return (res.data ?? []).length > 0;
}

// --- cron runs + lock --------------------------------------------------------

export async function tryAcquireLock(runId: string, staleSeconds = 600): Promise<boolean> {
  const res = await db().rpc('try_acquire_cron_lock', { p_run_id: runId, p_stale_seconds: staleSeconds });
  if (res.error) throw new Error(`tryAcquireLock: ${res.error.message}`);
  return res.data === true;
}

export async function releaseLock(runId: string): Promise<void> {
  const res = await db().rpc('release_cron_lock', { p_run_id: runId });
  if (res.error) throw new Error(`releaseLock: ${res.error.message}`);
}

export async function startCronRun(runId: string, triggerSource: string): Promise<void> {
  const res = await db().from('cron_runs').insert({ run_id: runId, trigger_source: triggerSource });
  if (res.error) throw new Error(`startCronRun: ${res.error.message}`);
}

export async function finishCronRun(
  runId: string,
  summary: { attempted: number; succeeded: number; notes?: string },
): Promise<void> {
  const res = await db()
    .from('cron_runs')
    .update({
      finished_at: new Date().toISOString(),
      products_attempted: summary.attempted,
      products_succeeded: summary.succeeded,
      ...(summary.notes ? { notes: summary.notes } : {}),
    })
    .eq('run_id', runId);
  if (res.error) throw new Error(`finishCronRun: ${res.error.message}`);
}

export async function getLastCronRun(): Promise<CronRunRow | null> {
  const res = await db().from('cron_runs').select('*').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (res.error) throw new Error(`getLastCronRun: ${res.error.message}`);
  return (res.data as CronRunRow | null) ?? null;
}

export async function listCronRuns(limit = 20): Promise<CronRunRow[]> {
  const res = await db().from('cron_runs').select('*').order('started_at', { ascending: false }).limit(limit);
  return unwrap('listCronRuns', res) as CronRunRow[];
}

/** Every active tracked product, ignoring its own interval. Used by `force` runs. */
export async function listActiveTracked(): Promise<(TrackedProductRow & { product: ProductRow })[]> {
  const res = await db()
    .from('tracked_products')
    .select('*, product:products(*)')
    .eq('is_active', true)
    .order('last_scraped_at', { ascending: true, nullsFirst: true });
  return unwrap('listActiveTracked', res) as (TrackedProductRow & { product: ProductRow })[];
}
