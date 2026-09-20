import type { Outcome, StockStatus, Strategy } from './api';

/**
 * Money.
 *
 * The store quotes INR and renders with `en-IN`, so lakh grouping (₹1,29,249) is what a
 * reader of this data expects to see. `maximumFractionDigits: 0` because every price the
 * store has ever returned has been a whole rupee, and ".00" on a six-figure number is noise.
 */
export function money(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('en-IN')}`;
  }
}

/** Compact money for tight columns: ₹1.29L, ₹12.4k. */
export function moneyCompact(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  if (currency === 'INR' && value >= 100_000) return `${symbol}${(value / 100_000).toFixed(2)}L`;
  if (value >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toFixed(0)}`;
}

export interface Delta {
  pct: number;
  abs: number;
  direction: 'up' | 'down' | 'flat';
  label: string;
}

export function delta(now: number | null | undefined, then: number | null | undefined): Delta | null {
  if (now === null || now === undefined || then === null || then === undefined || then === 0) return null;
  const abs = now - then;
  const pct = (abs / then) * 100;
  const direction = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down';
  // The sign is carried in the text, not only in the colour — colour must never be the
  // sole carrier of meaning.
  const label = direction === 'flat' ? '0.0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`;
  return { pct, abs, direction, label };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Counts down; returns null once it is due, so the caller can say "due now". */
export function timeUntil(iso: string | null | undefined, addMinutes: number): string | null {
  if (!iso) return null;
  const at = Date.parse(iso) + addMinutes * 60_000;
  const ms = at - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${clock(iso)}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const STOCK_LABEL: Record<StockStatus, string> = {
  in_stock: 'In stock',
  low_stock: 'Low stock',
  out_of_stock: 'Out of stock',
  unknown: 'Unknown',
};

/** `unknown` is deliberately `idle` grey, not a warning colour: it is an honest reading. */
export const STOCK_COLOR: Record<StockStatus, string> = {
  in_stock: '#0F7B5A',
  low_stock: '#8A6A1F',
  out_of_stock: '#B4442C',
  unknown: '#6B7580',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  success: 'Success',
  retried: 'Retried',
  failed: 'Failed',
  skipped: 'Skipped',
};

export const OUTCOME_COLOR: Record<Outcome, string> = {
  success: '#0F7B5A',
  retried: '#8A6A1F',
  failed: '#B4442C',
  skipped: '#6B7580',
};

export const STRATEGY_LABEL: Record<Strategy, string> = {
  api: 'JSON API',
  embedded_json: 'Embedded JSON',
  dom: 'HTML parse',
  browser: 'Browser',
};

/**
 * Plain-English explanations of the engine's error codes.
 *
 * The code is always shown too. This is a tool for someone who wants to know what happened,
 * and "an error occurred" is the least useful sentence it could offer.
 */
export const ERROR_COPY: Record<string, string> = {
  TIMEOUT: 'The store did not send headers or a body within the timeout.',
  NETWORK: 'The connection to the store failed before a response arrived.',
  HTTP_429: 'The store rate-limited the request. Backed off and tried again.',
  HTTP_5XX: 'The store returned a server error (it does this at random, by design).',
  HTTP_4XX: 'The store rejected the request.',
  PRODUCT_GONE: 'The store answered 404 — this product no longer exists. Tracking was paused.',
  GATE_REJECTED: 'The store refused the price handshake.',
  PARSE_MISS: 'A response arrived but carried no readable price.',
  PLACEHOLDER: 'The store showed a placeholder where a price should be. Treated as no reading.',
  STALE_QUOTE: 'The store served a figure it had flagged as not yet settled. Refused and retried.',
  VALIDATION_REJECT: 'The reading failed a sanity check, so nothing was stored.',
  IDENTITY_MISMATCH: 'The page did not identify as the tracked product.',
  ALL_STRATEGIES_FAILED: 'Every extraction strategy missed on this attempt.',
  RUN_BUDGET_EXCEEDED: 'The run ran out of time before reaching this product.',
  BROWSER_UNAVAILABLE: 'The browser fallback is not available in this deployment.',
  UNKNOWN: 'An unclassified failure.',
};

export function explainError(code: string | null | undefined): string {
  if (!code) return '';
  return ERROR_COPY[code] ?? 'An unclassified failure.';
}

export const INTERVAL_CHOICES = [
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Hourly' },
  { minutes: 120, label: 'Every 2 hours' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Daily' },
];

export function intervalLabel(minutes: number): string {
  return INTERVAL_CHOICES.find((c) => c.minutes === minutes)?.label ?? `Every ${minutes} minutes`;
}
