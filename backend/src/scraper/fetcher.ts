/**
 * The HTTP layer.
 *
 * One keep-alive pool for the whole process, one global pacer in front of it.
 *
 * The pacer is not politeness theatre. Phase 1 measured the store returning
 * `429 {"error":"rate_limited","scope":"general","retryAfter":1}` for 34% of an
 * 80-request run spaced 150 ms apart, and 77% of a 60-request run spaced 120 ms
 * apart — while the same endpoint served 46 consecutive 200s when the calls were
 * spread out. Concurrency without pacing does not make the run faster here; it
 * converts successful scrapes into retries. See STORE_NOTES.md §8.
 */
import { Agent, request } from 'undici';
import { env } from '../lib/env.js';
import { ScrapeError, classifyHttp, toScrapeError } from './errors.js';

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 8,
  headersTimeout: env.headersTimeoutMs,
  bodyTimeout: env.bodyTimeoutMs,
});

const DEFAULT_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br',
  referer: `${env.storeBaseUrl}/`,
  origin: env.storeBaseUrl,
};

// --- global pacer -----------------------------------------------------------
// A single promise chain. Every outbound store request waits its turn, so the
// store never sees two of our requests closer together than `minRequestGapMs`
// no matter how many products are being scraped concurrently.
let lastRequestAt = 0;
let queue: Promise<void> = Promise.resolve();
/** Set by a 429 with Retry-After: nothing goes out before this timestamp. */
let cooldownUntil = 0;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function jitter(ms: number, ratio = 0.25): number {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * ratio));
}

async function takeSlot(): Promise<void> {
  const mine = queue.then(async () => {
    const now = Date.now();
    const gapWait = lastRequestAt + jitter(env.minRequestGapMs, 0.2) - now;
    const coolWait = cooldownUntil - now;
    const wait = Math.max(gapWait, coolWait, 0);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  });
  queue = mine.catch(() => undefined);
  return mine;
}

/**
 * Take a turn in the global queue and resolve once it is safe to send.
 *
 * Exported so the Playwright strategy can route Chromium's own requests through the
 * same budget. Two code paths to one host need one pacer between them — see
 * AI_ERRORS.md §3 for what happens when they do not have one.
 */
export async function reserveSlot(): Promise<void> {
  await takeSlot();
}

/** Called when the store tells us to back off; applies process-wide. */
export function applyCooldown(ms: number): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
}

export interface FetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  durationMs: number;
  url: string;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Skip the pacer — only for the health/keepalive ping, never for scraping. */
  unpaced?: boolean;
  /** Throw a ScrapeError on a non-2xx instead of returning it. Default true. */
  throwOnHttpError?: boolean;
}

function parseRetryAfter(value: string | string[] | undefined, fallbackMs: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return fallbackMs;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(30_000, Math.max(0, secs * 1000));
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.min(30_000, Math.max(0, at - Date.now()));
  return fallbackMs;
}

/** Retry-After may also arrive in the JSON body: {"retryAfter": 2}. */
function retryAfterFromBody(body: string): number | undefined {
  if (!body.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(body) as { retryAfter?: unknown };
    const n = Number(parsed.retryAfter);
    return Number.isFinite(n) ? Math.min(30_000, Math.max(0, n * 1000)) : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  if (!url.startsWith(env.storeBaseUrl)) {
    // Hard guard. The brief says: scrape INE's mock store and nothing else.
    throw new ScrapeError('HTTP_4XX', `Refusing to fetch a URL outside the permitted store origin: ${url}`);
  }
  if (!opts.unpaced) await takeSlot();

  const started = Date.now();
  try {
    const res = await request(url, {
      method: opts.method ?? 'GET',
      headers: { ...DEFAULT_HEADERS, ...opts.headers },
      body: opts.body,
      dispatcher: agent,
      maxRedirections: 3,
      headersTimeout: env.headersTimeoutMs,
      bodyTimeout: env.bodyTimeoutMs,
    });

    const body = await res.body.text();
    const result: FetchResult = {
      status: res.statusCode,
      headers: res.headers as Record<string, string | string[] | undefined>,
      body,
      durationMs: Date.now() - started,
      url,
    };

    if (res.statusCode === 429) {
      const wait = retryAfterFromBody(body) ?? parseRetryAfter(res.headers['retry-after'], 1500);
      applyCooldown(wait + 250);
      if (opts.throwOnHttpError !== false) {
        throw new ScrapeError('HTTP_429', `Store rate-limited us (retry after ${wait} ms)`, {
          httpStatus: 429,
          retryAfterMs: wait,
        });
      }
    }

    if ((opts.throwOnHttpError ?? true) && (res.statusCode < 200 || res.statusCode >= 300)) {
      const code = classifyHttp(res.statusCode);
      throw new ScrapeError(code, `HTTP ${res.statusCode} from ${shortUrl(url)}: ${body.slice(0, 160)}`, {
        httpStatus: res.statusCode,
      });
    }

    return result;
  } catch (err) {
    throw toScrapeError(err);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<{ data: T; res: FetchResult }> {
  const res = await fetchText(url, opts);
  try {
    return { data: JSON.parse(res.body) as T, res };
  } catch (err) {
    throw new ScrapeError('PARSE_MISS', `Response from ${shortUrl(url)} was not JSON: ${res.body.slice(0, 120)}`, {
      httpStatus: res.status,
      cause: err,
    });
  }
}

export function shortUrl(url: string): string {
  return url.replace(env.storeBaseUrl, '');
}

export async function closeFetcher(): Promise<void> {
  await agent.close();
}
