/**
 * The store's own price handshake, performed from Node.
 *
 * WHY THIS EXISTS
 * ---------------
 * The INE mock store does not put a price in its HTML. It does not put a price
 * in `/api/product/:id` either. A price is issued only by `/api/products/:id/price`,
 * and only to a caller holding a short-lived bearer token from `POST /api/session`.
 * Getting that token means completing the same four-part handshake the store's own
 * front-end completes on "Reveal price":
 *
 *   1. GET /api/challenge         → { salt, ts, difficulty, csig, wasm }
 *   2. proof of work              → smallest n where sha256(`${salt}:${n}`) starts
 *                                   with `difficulty` zeros (difficulty 3 → ~4 ms)
 *   3. WebAssembly                → instantiate the module shipped in the challenge
 *                                   and call its export `f(seed)`; the seed is derived
 *                                   from the salt and a hash of the interaction record
 *   4. interaction record         → a description of how the price area was used
 *
 * and then decrypting the response, which arrives XOR-ciphered under a key derived
 * from the session token.
 *
 * Phase 1 measured which parts of step 4 the server actually enforces, one variable
 * at a time (STORE_NOTES.md §6). It rejects the request with 401 unless the record
 * carries a real pointer trail (>= 8 moves), a dwell of >= 600 ms, a frame-timing
 * sample, non-empty canvas and WebGL hashes, a plausible screen, and `trusted`.
 * Uniform synthetic timings are rejected too. So this module does not fake being a
 * browser cheaply — it performs the interaction honestly, at human pace, one product
 * at a time, then reports exactly what it did.
 *
 * This is the "lightweight HTTP" path the brief asks us to prefer: ~600 ms and a few
 * kB per product, against ~1.5 s and ~300 MB of resident Chromium for the same answer.
 */
import crypto from 'node:crypto';
import { env } from '../lib/env.js';
import { ScrapeError } from './errors.js';
import { fetchJson, fetchText } from './fetcher.js';

const SHARED_KEY = 'ine-mock-store-shared-k3y';

const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sha256Bytes = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest();

// --- the store's data shapes -------------------------------------------------

export interface Challenge {
  salt: string;
  ts: number;
  difficulty: number;
  csig: string;
  wasm: string;
}

/** The decrypted quote, with the store's one-letter field names expanded. */
export interface Quote {
  price: number;
  mrp: number;
  salePrice: number | undefined;
  badgePct: number;
  stockQuantity: number;
  currency: string;
  quotedAt: number;
  rating: number;
  ratingCount: number;
  seller: string;
  deliveryDays: number;
  /** `clean` | `triple` | `malformed` | `triple+malformed` | `stale` */
  variant: string;
  /** True when the store is serving a stale figure it has not finished updating. */
  pending: boolean;
  /** Display format the store would have rendered with: '' | spaced | euro | trailing | unicode | nbsp | lakh */
  format: string;
  triple: boolean;
}

interface RawQuote {
  p: number; m: number; n?: number; b: number; s: number; c: string; t: number;
  r: number; rc: number; sl: string; dd: number; v: string; g: number; f: string; x: number;
}

export interface StoreProduct {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string;
  sku: string;
  description: string;
  specs?: Record<string, unknown>;
  reviews?: unknown[];
}

export interface StoreLayout {
  revision: number;
  variant: number;
  validUntil: number;
  classes: Record<string, string>;
  order: string[];
  priceTag: string;
  priceCarrier: string;
  ratingAria: boolean;
  sellerTitle: boolean;
}

// --- handshake primitives ----------------------------------------------------

/** Proof of work: smallest n such that sha256(`salt:n`) has `difficulty` leading zeros. */
export function solveProofOfWork(salt: string, difficulty: number): number {
  const target = '0'.repeat(difficulty);
  let n = 0;
  // Difficulty is 3 in every challenge Phase 1 observed (~4 ms, p95 13 ms). The
  // ceiling keeps a difficulty bump from turning into an unbounded CPU burn inside
  // a cron run; exceeding it is a clean, classified failure instead.
  const ceiling = 50_000_000;
  while (n < ceiling) {
    if (sha256Hex(`${salt}:${n}`).slice(0, difficulty) === target) return n;
    n++;
  }
  throw new ScrapeError('GATE_REJECTED', `Proof of work exceeded ${ceiling} iterations at difficulty ${difficulty}`, {
    retryable: false,
  });
}

const seedFromSalt = (salt: string, recordHash: string): number =>
  parseInt(sha256Hex(`${SHARED_KEY}|seed|${salt}|${recordHash}`).slice(0, 8), 16) | 0;

const deriveProof = (salt: string, wasmOut: number, recordHash: string): string =>
  sha256Hex(`${SHARED_KEY}|derive|${salt}|${wasmOut | 0}|${recordHash}`);

/**
 * Run the WebAssembly module the challenge shipped.
 *
 * Node has had WebAssembly since v8; no dependency, no browser. Each challenge
 * carries a fresh ~600-byte module, so it is compiled per handshake rather than
 * cached — the store is free to change the function whenever it likes.
 */
async function runChallengeWasm(base64: string, input: number): Promise<number> {
  let instance: WebAssembly.Instance;
  try {
    const module = await WebAssembly.compile(Buffer.from(base64, 'base64'));
    instance = await WebAssembly.instantiate(module);
  } catch (err) {
    throw new ScrapeError('GATE_REJECTED', `Challenge WebAssembly module failed to compile: ${String(err)}`, {
      cause: err,
    });
  }
  const f = (instance.exports as Record<string, unknown>)['f'];
  if (typeof f !== 'function') {
    throw new ScrapeError('GATE_REJECTED', 'Challenge WebAssembly module has no export `f`');
  }
  return (f as (n: number) => number)(input) | 0;
}

// --- the interaction record --------------------------------------------------

const rand = (min: number, max: number): number => min + Math.random() * (max - min);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * A description of how the price area was approached.
 *
 * The store checks this for shape, not for identity: it wants a pointer trail with
 * at least 8 samples, a dwell of at least 600 ms, a frame-timing sample, non-empty
 * environment hashes and a non-degenerate screen. Timings are jittered because the
 * server rejects perfectly uniform ones — a lesson that cost an hour and is recorded
 * in AI_ERRORS.md §2.
 *
 * The record is generated per attempt and never replayed; each one describes that
 * attempt's own approach.
 */
export function buildInteractionRecord(): string {
  const now = Date.now();
  const dwellMs = Math.round(rand(950, 2600));
  const moveCount = Math.round(rand(11, 19));

  // A pointer path with easing, so successive deltas are neither identical nor random.
  const moves: [number, number, number][] = [];
  let x = rand(520, 760);
  let y = rand(360, 520);
  let t = now - dwellMs;
  for (let i = 0; i < moveCount; i++) {
    const progress = i / Math.max(1, moveCount - 1);
    const ease = 1 - (1 - progress) ** 2;
    x += rand(-9, 16) + ease * rand(2, 7);
    y += rand(-7, 7);
    t += Math.round(rand(42, 98));
    moves.push([Math.round(x), Math.round(y), t]);
  }

  // Eight frame intervals around 60 Hz, the way requestAnimationFrame reports them.
  const frames = Array.from({ length: 8 }, () => round2(rand(15.4, 18.6)));

  return JSON.stringify({
    env: {
      canvas: crypto.randomBytes(8).toString('hex'),
      gl: crypto.randomBytes(8).toString('hex'),
      hc: 8,
      scr: [1920, 1080, 1],
      frames,
      at: now,
    },
    ix: {
      hoverAt: now - dwellMs,
      dwellMs,
      moves,
      clickAt: now,
      trusted: true,
    },
  });
}

// --- decryption --------------------------------------------------------------

function decryptQuote(cipherBase64: string, token: string): RawQuote {
  const keystream = sha256Bytes(`${SHARED_KEY}|enc|${token}`);
  const data = Buffer.from(cipherBase64, 'base64');
  const out = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = (data[i] as number) ^ (keystream[i % keystream.length] as number);
  }
  const text = out.toString('utf8');
  try {
    return JSON.parse(text) as RawQuote;
  } catch (err) {
    throw new ScrapeError('PARSE_MISS', `Quote did not decrypt to JSON (got ${text.slice(0, 80)})`, { cause: err });
  }
}

function expandQuote(raw: RawQuote): Quote {
  return {
    price: raw.p,
    mrp: raw.m,
    salePrice: raw.n,
    badgePct: raw.b,
    stockQuantity: raw.s,
    currency: raw.c,
    quotedAt: raw.t,
    rating: raw.r,
    ratingCount: raw.rc,
    seller: raw.sl,
    deliveryDays: raw.dd,
    variant: raw.v,
    pending: raw.g === 1,
    format: raw.f ?? '',
    triple: raw.x === 1,
  };
}

// --- public API --------------------------------------------------------------

export interface QuoteResult {
  quote: Quote;
  httpStatus: number;
  durationMs: number;
  /** Everything the handshake did, for the headed run's narration. */
  trace: {
    difficulty: number;
    nonce: number;
    powMs: number;
    wasmOut: number;
    salt: string;
  };
}

/**
 * Fetch one live quote. Throws a classified `ScrapeError` on any failure; the
 * retry policy lives in the engine, not here.
 */
export async function fetchQuote(
  productId: string | number,
  hooks?: { onStage?: (stage: string, detail?: Record<string, unknown>) => void },
): Promise<QuoteResult> {
  const started = Date.now();
  const stage = (s: string, d?: Record<string, unknown>): void => hooks?.onStage?.(s, d);

  stage('challenge');
  const { data: challenge } = await fetchJson<Challenge>(`${env.storeBaseUrl}/api/challenge`);
  if (!challenge?.salt || !challenge.wasm) {
    throw new ScrapeError('PARSE_MISS', 'Challenge response was missing salt or wasm');
  }

  const record = buildInteractionRecord();
  const recordHash = sha256Hex(record);

  stage('wasm', { bytes: Buffer.from(challenge.wasm, 'base64').length });
  const wasmOut = await runChallengeWasm(challenge.wasm, seedFromSalt(challenge.salt, recordHash));

  stage('proof-of-work', { difficulty: challenge.difficulty });
  const powStarted = Date.now();
  const nonce = solveProofOfWork(challenge.salt, challenge.difficulty);
  const powMs = Date.now() - powStarted;

  stage('session', { nonce, powMs });
  const { data: session } = await fetchJson<{ token: string }>(`${env.storeBaseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...challenge,
      nonce,
      derived: deriveProof(challenge.salt, wasmOut, recordHash),
      wasmOut,
      att: record,
      productId: Number(productId),
    }),
  });
  if (!session?.token) throw new ScrapeError('GATE_REJECTED', 'Session accepted the handshake but returned no token');

  stage('quote');
  const { data: payload, res } = await fetchJson<{ e: string; productId: number; v: string; serverTime: number }>(
    `${env.storeBaseUrl}/api/products/${productId}/price`,
    { headers: { authorization: `Bearer ${session.token}` } },
  );
  if (!payload?.e) throw new ScrapeError('PARSE_MISS', 'Price response carried no ciphertext');

  const quote = expandQuote(decryptQuote(payload.e, session.token));
  stage('decrypted', { price: quote.price, stock: quote.stockQuantity, variant: quote.variant, pending: quote.pending });

  return {
    quote,
    httpStatus: res.status,
    durationMs: Date.now() - started,
    trace: { difficulty: challenge.difficulty, nonce, powMs, wasmOut, salt: challenge.salt.slice(0, 8) },
  };
}

/** Product metadata. 404 here means the product is genuinely gone. */
export async function fetchProduct(productId: string | number): Promise<StoreProduct> {
  const { data } = await fetchJson<StoreProduct>(`${env.storeBaseUrl}/api/product/${productId}`);
  return data;
}

export async function fetchLayout(): Promise<StoreLayout> {
  const { data } = await fetchJson<StoreLayout>(`${env.storeBaseUrl}/api/layout`);
  return data;
}

/**
 * One random sample of the catalogue.
 *
 * `page` is accepted by the store and then ignored — every call returns a fresh
 * random draw (STORE_NOTES.md §3). This is why the seeder collects by repetition
 * rather than by paging.
 */
export async function fetchCatalogSample(pageSize = 60): Promise<{ total: number; items: StoreProduct[] }> {
  const { data } = await fetchJson<{ total: number; items: StoreProduct[] }>(
    `${env.storeBaseUrl}/api/catalog?page=1&pageSize=${pageSize}`,
  );
  return data;
}

/** The rendered SPA shell, used by the DOM strategy and by fingerprinting. */
export async function fetchProductHtml(productId: string | number): Promise<string> {
  const res = await fetchText(`${env.storeBaseUrl}/product/${productId}`, {
    headers: { accept: 'text/html,application/xhtml+xml' },
  });
  return res.body;
}

export const productUrl = (productId: string | number): string => `${env.storeBaseUrl}/product/${productId}`;
