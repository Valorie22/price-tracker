/**
 * The one place that talks to the backend.
 *
 * Errors carry the backend's own `error` code and message through to the UI. A price
 * tracker's audience wants to know *what* failed — "Something went wrong" is the least
 * useful sentence this application could show anyone.
 */
const RAW_BASE = (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? 'http://localhost:8080';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      0,
      'network',
      `Could not reach the API at ${API_BASE}. It may be starting up — Render's free tier sleeps after 15 minutes idle and takes about 50 seconds to wake.`,
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const parsed = body as { error?: string; message?: string; detail?: unknown } | null;
    throw new ApiError(
      res.status,
      parsed?.error ?? String(res.status),
      parsed?.message ?? parsed?.error ?? `Request to ${path} failed with HTTP ${res.status}`,
    );
  }

  return body as T;
}

// --- shapes ------------------------------------------------------------------

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock' | 'unknown';
export type Outcome = 'success' | 'retried' | 'failed' | 'skipped';
export type Strategy = 'api' | 'embedded_json' | 'dom' | 'browser';

export interface SparkPoint {
  t: string;
  price: number;
}

export interface TrackedRow {
  tracked_id: string;
  is_active: boolean;
  scrape_interval_minutes: number;
  alert_price_below: number | null;
  alert_on_restock: boolean;
  created_at: string;
  last_scraped_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  store_product_id: string;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
  slug: string | null;
  url: string;
  description: string | null;
  specs: Record<string, unknown> | null;
  latest_price: number | null;
  latest_currency: string | null;
  latest_mrp: number | null;
  latest_stock_status: StockStatus | null;
  latest_stock_quantity: number | null;
  latest_scraped_at: string | null;
  price_24h_ago: number | null;
  price_7d_ago: number | null;
  last_outcome: Outcome | null;
  last_error_code: string | null;
  last_strategy: Strategy | null;
  last_attempt_at: string | null;
  last_duration_ms: number | null;
  last_structure_changed: boolean | null;
  history_points: number;
  sparkline?: SparkPoint[];
}

export interface HistoryPoint {
  t: string;
  price: number;
  currency: string;
  mrp: number | null;
  stockStatus: StockStatus;
  stockQuantity: number | null;
  logId: number | null;
}

export interface AttemptMark {
  t: string;
  attempt: number;
  outcome: Outcome;
  strategy: Strategy | null;
  durationMs: number;
  httpStatus: number | null;
  errorCode: string | null;
  structureChanged: boolean;
}

export interface LogRow {
  id: number;
  runId: string;
  attempt: number;
  outcome: Outcome;
  strategy: Strategy | null;
  httpStatus: number | null;
  durationMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  priceFound: number | null;
  stockFound: string | null;
  structureChanged: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface AlertRow {
  id: number;
  tracked_product_id: string | null;
  kind: 'price_drop' | 'back_in_stock' | 'structure_change' | 'repeated_failure' | 'product_gone' | 'large_delta';
  message: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
  email_sent_at: string | null;
}

export interface SearchHit {
  storeProductId: string;
  name: string;
  brand: string | null;
  category: string | null;
  sku: string | null;
  slug: string | null;
  url: string;
  score: number;
}

export interface ScrapeNowResult {
  runId: string;
  result: {
    outcome: 'success' | 'failed';
    attempts: number;
    strategy: Strategy | null;
    price: number | null;
    currency: string | null;
    stockStatus: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number;
    structureChanged: boolean;
  } | null;
  stages: { stage: string; detail?: Record<string, unknown>; at: string }[];
}

export type HistoryRange = '24h' | '7d' | '30d' | 'all';

// --- calls -------------------------------------------------------------------

export const api = {
  health: () =>
    request<{ ok: boolean; version: string; database: string; lastRunAt: string | null; store: string }>('/api/health'),

  search: (q: string) =>
    request<{ query: string; source: string; indexed: number; note?: string; results: SearchHit[] }>(
      `/api/store/search?q=${encodeURIComponent(q)}`,
    ),

  indexStatus: () => request<{ indexed: number; expected: number }>('/api/store/index-status'),

  listTracked: () => request<{ tracked: TrackedRow[] }>('/api/tracked'),

  getTracked: (id: string) => request<{ tracked: TrackedRow }>(`/api/tracked/${id}`),

  track: (storeProductId: string) =>
    request<{ tracked: TrackedRow }>('/api/tracked', {
      method: 'POST',
      body: JSON.stringify({ storeProductId }),
    }),

  updateTracked: (
    id: string,
    patch: { isActive?: boolean; scrapeIntervalMinutes?: number; alertPriceBelow?: number | null; alertOnRestock?: boolean },
  ) => request<{ tracked: TrackedRow }>(`/api/tracked/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  untrack: (id: string) => request<void>(`/api/tracked/${id}`, { method: 'DELETE' }),

  history: (id: string, range: HistoryRange) =>
    request<{ range: HistoryRange; points: HistoryPoint[]; attempts: AttemptMark[] }>(
      `/api/tracked/${id}/history?range=${range}`,
    ),

  logs: (id: string, opts: { limit?: number; offset?: number; outcome?: Outcome | 'all' } = {}) =>
    request<{ total: number; limit: number; offset: number; logs: LogRow[] }>(
      `/api/tracked/${id}/logs?limit=${opts.limit ?? 50}&offset=${opts.offset ?? 0}&outcome=${opts.outcome ?? 'all'}`,
    ),

  scrapeNow: (id: string) => request<ScrapeNowResult>(`/api/tracked/${id}/scrape-now`, { method: 'POST' }),

  alerts: () => request<{ alerts: AlertRow[]; emailConfigured: boolean }>('/api/alerts'),

  readAlert: (id: number) => request<{ ok: true }>(`/api/alerts/${id}/read`, { method: 'POST' }),

  structure: () =>
    request<{
      current: { fingerprint: string; details: Record<string, unknown> | null; last_seen_at: string; occurrences: number } | null;
      changedRecently: boolean;
      fingerprints: { id: number; fingerprint: string; last_seen_at: string; occurrences: number }[];
    }>('/api/structure'),

  runs: () =>
    request<{
      runs: {
        run_id: string;
        started_at: string;
        finished_at: string | null;
        products_attempted: number;
        products_succeeded: number;
        trigger_source: string | null;
        notes: string | null;
      }[];
    }>('/api/cron/runs'),
};
