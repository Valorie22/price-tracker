/**
 * Environment configuration.
 *
 * Everything the process needs is read once, here, and validated. A missing
 * SUPABASE_URL should fail at boot with a sentence you can act on, not at 02:00
 * inside a cron run with `Cannot read properties of undefined`.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  return '';
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export const env = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: int('PORT', 8080),
  version: str('APP_VERSION', '1.0.0'),

  /** The one site this project is permitted to scrape. */
  storeBaseUrl: str('STORE_BASE_URL', 'https://demo.inelabteamdev.com').replace(/\/+$/, ''),

  supabaseUrl: str('SUPABASE_URL'),
  supabaseServiceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),

  cronSecret: str('CRON_SECRET'),

  /** Comma-separated list, or `*` in development. */
  corsOrigins: str('CORS_ORIGINS', '*'),

  // --- scraper tuning -------------------------------------------------------
  maxAttempts: int('SCRAPE_MAX_ATTEMPTS', 4),
  concurrency: int('SCRAPE_CONCURRENCY', 3),
  runBudgetMs: int('SCRAPE_RUN_BUDGET_MS', 240_000),
  headersTimeoutMs: int('SCRAPE_HEADERS_TIMEOUT_MS', 12_000),
  bodyTimeoutMs: int('SCRAPE_BODY_TIMEOUT_MS', 20_000),
  /** Minimum spacing between outbound store requests, store-wide. */
  minRequestGapMs: int('STORE_MIN_REQUEST_GAP_MS', 700),
  /** Reject a new price that moves more than this fraction from the last known. */
  maxPriceDeltaRatio: Number(str('MAX_PRICE_DELTA_RATIO', '0.7')),
  /** Allow the Playwright strategy at all (off on Render free tier by default). */
  browserFallbackEnabled: bool('BROWSER_FALLBACK_ENABLED', false),

  // --- alerts (optional) ----------------------------------------------------
  sendgridApiKey: str('SENDGRID_API_KEY'),
  alertToEmail: str('ALERT_TO_EMAIL'),
  alertFromEmail: str('ALERT_FROM_EMAIL'),
} as const;

export type Env = typeof env;

/** Fatal problems that should stop the process from pretending to work. */
export function assertEnv(): void {
  const missing: string[] = [];
  if (!env.supabaseUrl) missing.push('SUPABASE_URL');
  if (!env.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.cronSecret) missing.push('CRON_SECRET');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Copy .env.example to backend/.env and fill them in (see README.md § Environment variables).`,
    );
  }
}

export const isProd = env.nodeEnv === 'production';
