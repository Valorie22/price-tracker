/**
 * Playwright session management.
 *
 * The browser is the last strategy in the chain and the star of the headed run. It is
 * imported dynamically so a deployment without browsers installed boots fine and simply
 * reports the strategy as unavailable, rather than crashing at import time.
 *
 * One browser instance is shared across a whole run and closed in a `finally`. Chromium
 * costs roughly 1.5 s and ~300 MB on Render's free tier; paying that per product would
 * be the difference between a run that fits in the cron window and one that does not.
 */
import type { Browser, BrowserContext, chromium as Chromium, Page, Route } from 'playwright';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { ScrapeError } from './errors.js';
import { reserveSlot } from './fetcher.js';

export type SimulationMode = 'slow' | 'error' | 'late' | 'all';

export interface BrowserOptions {
  headless?: boolean;
  slowMo?: number;
  /** Force a degraded response against the real store, for the observable run. */
  simulate?: SimulationMode | null;
  /** Called on every simulated fault so the overlay and stdout can narrate it. */
  onSimulatedFault?: (what: string, detail: Record<string, unknown>) => void;
  /** Called with each new page, so the headed runner can inject its overlay. */
  onPage?: (page: Page) => Promise<void> | void;
}

let shared: { browser: Browser; context: BrowserContext; opts: BrowserOptions } | null = null;

function optionsMatch(a: BrowserOptions, b: BrowserOptions): boolean {
  return (a.headless ?? true) === (b.headless ?? true) && (a.slowMo ?? 0) === (b.slowMo ?? 0) && (a.simulate ?? null) === (b.simulate ?? null);
}

export async function isBrowserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return typeof chromium?.launch === 'function';
  } catch {
    return false;
  }
}

export async function getBrowserContext(opts: BrowserOptions = {}): Promise<BrowserContext> {
  if (shared && optionsMatch(shared.opts, opts)) return shared.context;
  if (shared) await closeBrowser();

  let chromium: typeof Chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    throw new ScrapeError('BROWSER_UNAVAILABLE', 'Playwright is not installed in this environment', { cause: err });
  }

  const headless = opts.headless ?? true;
  const browser = await chromium.launch({
    headless,
    slowMo: opts.slowMo ?? 0,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 940 },
    locale: 'en-IN',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });

  shared = { browser, context, opts };
  logger.info('browser launched', { headless, slowMo: opts.slowMo ?? 0, simulate: opts.simulate ?? null });
  return context;
}

export async function closeBrowser(): Promise<void> {
  if (!shared) return;
  const { browser } = shared;
  shared = null;
  await browser.close().catch(() => undefined);
}

// --- fault simulation --------------------------------------------------------

/**
 * Force a degraded response, against the real store.
 *
 * The brief asks the recording to show a slow or failing response. Pointing the
 * scraper at a local mock would prove nothing, so these intercept the live request
 * instead: the store really is asked for the price, the answer really is delayed or
 * broken, and everything downstream — the retry, the backoff, the recovery, the log
 * rows — is the production code path, not a rehearsal.
 *
 * The counts are chosen against a fact read out of the store's own bundle: its
 * front-end retries the quote six times internally before it gives up and renders
 * "Couldn't load the price after 6 attempts". A smaller number of failures is
 * absorbed silently by the page and our engine never sees a problem, so the fault
 * plan spends exactly that budget and then stops — which pushes the page into its
 * visible error state and makes our retry and backoff the thing that recovers it.
 *
 *   slow   hold the first quote request 9 s — the page sits on "Loading current price…"
 *   late   hold it 4 s — the price lands well after the rest of the page
 *   error  answer 503 six times, then let the real request through
 *   all    one slow response, then the 503 run, then recovery — the full narrative
 */
interface SimulationStep {
  kind: 'delay' | 'fail';
  ms?: number;
  status?: number;
}

/**
 * The store's front-end retries a failed quote six times before it gives up and
 * renders "Couldn't load the price after 6 attempts". Anything short of that is
 * absorbed silently and our engine never learns a thing — see AI_ERRORS.md §4.
 */
const STORE_INTERNAL_RETRIES = 6;

function planFor(mode: SimulationMode): SimulationStep[] {
  const fail = (n: number): SimulationStep[] => Array.from({ length: n }, () => ({ kind: 'fail' as const, status: 503 }));
  switch (mode) {
    case 'slow': return [{ kind: 'delay', ms: 9_000 }];
    case 'late': return [{ kind: 'delay', ms: 4_000 }];
    case 'error': return fail(STORE_INTERNAL_RETRIES);
    case 'all': return [{ kind: 'delay', ms: 9_000 }, ...fail(STORE_INTERNAL_RETRIES)];
  }
}

/**
 * Simulation state lives at session scope, not page scope.
 *
 * Each engine attempt opens a fresh page. When the counter lived on the page, every
 * attempt re-armed the full fault plan and the run could never recover — four
 * attempts, four failures, nothing to show. At session scope the plan is spent once
 * and the next attempt meets a healthy store, which is the recovery the recording
 * is supposed to capture.
 */
let simulationStep = 0;
export function resetSimulation(): void {
  simulationStep = 0;
}

/**
 * Route every store request Chromium makes through the same pacer the HTTP client
 * uses, and apply the fault plan on the way past.
 *
 * Both halves matter. The pacing is not optional: one "Reveal price" click can be
 * eighteen requests once the store's own retry loop gets going, and unpaced that
 * rate-limits the whole engine — including the API strategy, which was behaving
 * perfectly (AI_ERRORS.md §3). Assets are left alone; only `/api/*` is metered.
 */
export async function installStoreRouting(page: Page, opts: BrowserOptions): Promise<void> {
  const plan = opts.simulate ? planFor(opts.simulate) : [];

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const isQuote = /\/api\/products\/[^/]+\/price/.test(url);

    // Wait our turn in the same global queue as the HTTP client.
    await reserveSlot();

    if (!isQuote || plan.length === 0) {
      await route.continue();
      return;
    }

    // Snapshot the index before incrementing: `notify` is a closure, and reading the
    // counter at call time reported every fault one step ahead of where it was.
    const index = simulationStep;
    simulationStep++;
    const notify = (what: string, detail: Record<string, unknown> = {}): void =>
      opts.onSimulatedFault?.(what, { url, step: Math.min(index + 1, plan.length), of: plan.length, ...detail });

    const current = plan[index];
    if (!current) {
      notify('fault window over — the real store answers this one');
      await route.continue();
      return;
    }

    if (current.kind === 'fail') {
      notify(`forced HTTP ${current.status} upstream_error`);
      await route.fulfill({
        status: current.status ?? 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream_error' }),
      });
      return;
    }

    notify(`holding the quote request for ${current.ms} ms`);
    await new Promise((r) => setTimeout(r, current.ms ?? 4_000));
    await route.continue();
  });
}

// --- the interaction the store requires --------------------------------------

/**
 * Satisfy the store's reveal gate and read the settled price.
 *
 * The store guards the price behind a pointer trail (>= 8 samples) and a dwell
 * (>= 600 ms), disables the button until both are met, and then — in `Xn` in its own
 * bundle — drops 17.5% of clicks entirely and delays another 17.5% by 900 ms. So the
 * click is verified by its effect, not assumed, and re-issued if the state machine
 * never leaves `idle`.
 *
 * Every wait here is a wait on a *condition*. There is no `waitForTimeout` in the
 * success path: a fixed sleep is a guess that is either too short on a slow response
 * or wasted on a fast one.
 */
export async function revealPrice(
  page: Page,
  hooks?: { onStage?: (stage: string, detail?: Record<string, unknown>) => void },
): Promise<void> {
  const stage = (s: string, d?: Record<string, unknown>): void => hooks?.onStage?.(s, d);

  stage('browser:waiting-for-price-block');
  await page.waitForSelector('.price-block', { timeout: 20_000 });

  const box = await page.locator('.price-block').first().boundingBox();
  if (!box) throw new ScrapeError('PARSE_MISS', 'Price block has no layout box');

  stage('browser:satisfying-interaction-gate', { requires: '>=8 pointer samples, >=600ms dwell' });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(
      box.x + 24 + ((i * 17) % Math.max(40, box.width - 48)),
      box.y + 16 + ((i * 11) % Math.max(20, box.height - 32)),
      { steps: 2 },
    );
    await page.waitForTimeout(55 + Math.round(Math.random() * 35));
  }

  // The button stays disabled until the gate is satisfied; wait for that, not a timer.
  const button = page.getByRole('button', { name: /reveal price|try again/i });
  await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /reveal price|try again/i.test(b.textContent ?? ''));
      return !!btn && !(btn as HTMLButtonElement).disabled;
    },
    undefined,
    { timeout: 20_000 },
  );

  const settled = (): Promise<unknown> =>
    page.waitForFunction(
      () => {
        const el = document.querySelector('.price-block');
        if (!el) return false;
        if (el.classList.contains('price-error')) return true;
        if (!el.classList.contains('price-success')) return false;
        // Settled means: a real figure, not the "Updating…" placeholder the store
        // renders at 45% opacity while it is still deciding.
        const main = el.querySelector('.price-main');
        if (!main) return false;
        const text = (main.textContent ?? '').replace(/[\u200B-\u200D\uFEFF]/g, '');
        if (/updating/i.test(text)) return false;
        return /[0-9０-９]{2,}/.test(text);
      },
      undefined,
      { timeout: 45_000 },
    );

  // Up to three click issues: the store discards some clicks on purpose.
  for (let click = 1; click <= 3; click++) {
    stage('browser:clicking-reveal', { click });
    await button.click({ timeout: 10_000 }).catch(() => undefined);

    const leftIdle = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.price-block');
          return !!el && !el.classList.contains('price-idle');
        },
        undefined,
        { timeout: 2_500 },
      )
      .then(() => true)
      .catch(() => false);

    if (!leftIdle) {
      stage('browser:click-was-swallowed', { click, note: 'store drops ~1 in 6 clicks by design' });
      continue;
    }

    stage('browser:waiting-for-settled-price');
    await settled();
    return;
  }

  throw new ScrapeError('PARSE_MISS', 'Reveal button was clicked three times and the price never left the idle state');
}

export const browserEnabled = (): boolean => env.browserFallbackEnabled;
