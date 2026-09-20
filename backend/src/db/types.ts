import type { StockStatus } from '../scraper/parse.js';
import type { ErrorCode } from '../scraper/errors.js';
import type { StrategyName } from '../scraper/strategies/types.js';

export type Outcome = 'success' | 'retried' | 'failed' | 'skipped';

export interface ProductRow {
  id: string;
  store_product_id: string;
  name: string;
  url: string;
  image_url: string | null;
  category: string | null;
  brand: string | null;
  sku: string | null;
  slug: string | null;
  description: string | null;
  specs: Record<string, unknown> | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface TrackedProductRow {
  id: string;
  product_id: string;
  is_active: boolean;
  scrape_interval_minutes: number;
  alert_price_below: number | null;
  alert_on_restock: boolean;
  created_at: string;
  last_scraped_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
}

export interface PriceHistoryRow {
  id: number;
  tracked_product_id: string;
  price: number;
  currency: string;
  mrp: number | null;
  stock_status: StockStatus;
  stock_quantity: number | null;
  scraped_at: string;
  scrape_log_id: number | null;
}

export interface ScrapeLogRow {
  id: number;
  tracked_product_id: string | null;
  run_id: string;
  attempt_number: number;
  outcome: Outcome;
  strategy: StrategyName | null;
  http_status: number | null;
  duration_ms: number;
  error_code: ErrorCode | null;
  error_message: string | null;
  price_found: number | null;
  stock_found: string | null;
  structure_changed: boolean;
  started_at: string;
  finished_at: string;
}

export type AlertKind =
  | 'price_drop'
  | 'back_in_stock'
  | 'structure_change'
  | 'repeated_failure'
  | 'product_gone'
  | 'large_delta';

export interface AlertRow {
  id: number;
  tracked_product_id: string | null;
  kind: AlertKind;
  message: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  read_at: string | null;
  email_sent_at: string | null;
}

export interface CronRunRow {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  products_attempted: number;
  products_succeeded: number;
  trigger_source: string | null;
  notes: string | null;
}

/** One row of the `tracked_overview` view — everything the dashboard needs. */
export interface TrackedOverviewRow {
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
  last_error_code: ErrorCode | null;
  last_strategy: StrategyName | null;
  last_attempt_at: string | null;
  last_duration_ms: number | null;
  last_structure_changed: boolean | null;
  history_points: number;
}
