/**
 * The vocabulary the scrape log speaks.
 *
 * Every failure is classified at the layer where it happened. That matters: a
 * `429` that later shows up as "the price was undefined" looks like a data bug
 * and sends you selector-hunting, when the real problem was transport. This
 * enum is the fix for that class of wasted afternoon.
 */
export type ErrorCode =
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_429'
  | 'HTTP_5XX'
  | 'HTTP_4XX'
  | 'PRODUCT_GONE'
  | 'GATE_REJECTED'
  | 'PARSE_MISS'
  | 'PLACEHOLDER'
  | 'STALE_QUOTE'
  | 'VALIDATION_REJECT'
  | 'IDENTITY_MISMATCH'
  | 'ALL_STRATEGIES_FAILED'
  | 'RUN_BUDGET_EXCEEDED'
  | 'BROWSER_UNAVAILABLE'
  | 'UNKNOWN';

export class ScrapeError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | undefined;
  /** Retryable failures get another attempt; terminal ones do not. */
  readonly retryable: boolean;
  /** Server-supplied `Retry-After`, in milliseconds, when it gave us one. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { httpStatus?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ScrapeError';
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * Retry policy, as data.
 *
 * 404 is the interesting one: it is NOT retried. The store answers
 * `{"error":"not_found"}` for a product that no longer exists, and hammering it
 * three more times only delays finding out. The product is marked inactive and
 * an alert is raised instead.
 */
const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  TIMEOUT: true,
  NETWORK: true,
  HTTP_429: true,
  HTTP_5XX: true,
  HTTP_4XX: false,
  PRODUCT_GONE: false,
  GATE_REJECTED: true,
  PARSE_MISS: true,
  PLACEHOLDER: true,
  STALE_QUOTE: true,
  VALIDATION_REJECT: true,
  IDENTITY_MISMATCH: true,
  ALL_STRATEGIES_FAILED: true,
  RUN_BUDGET_EXCEEDED: false,
  BROWSER_UNAVAILABLE: false,
  UNKNOWN: true,
};

export function classifyHttp(status: number): ErrorCode {
  if (status === 404) return 'PRODUCT_GONE';
  if (status === 429) return 'HTTP_429';
  if (status === 401 || status === 403) return 'GATE_REJECTED';
  if (status >= 500) return 'HTTP_5XX';
  if (status >= 400) return 'HTTP_4XX';
  return 'UNKNOWN';
}

export function toScrapeError(err: unknown): ScrapeError {
  if (err instanceof ScrapeError) return err;
  if (err instanceof Error) {
    const name = (err as NodeJS.ErrnoException).code ?? err.name;
    if (
      name === 'UND_ERR_HEADERS_TIMEOUT' ||
      name === 'UND_ERR_BODY_TIMEOUT' ||
      name === 'UND_ERR_CONNECT_TIMEOUT' ||
      name === 'AbortError' ||
      name === 'TimeoutError'
    ) {
      return new ScrapeError('TIMEOUT', err.message, { cause: err });
    }
    if (name === 'ENOTFOUND' || name === 'ECONNRESET' || name === 'ECONNREFUSED' || name === 'EAI_AGAIN') {
      return new ScrapeError('NETWORK', err.message, { cause: err });
    }
    return new ScrapeError('UNKNOWN', err.message, { cause: err });
  }
  return new ScrapeError('UNKNOWN', String(err));
}
