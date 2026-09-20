# INE Price Tracker

Tracks prices and stock on [INE's mock storefront](https://demo.inelabteamdev.com) on a
schedule, and reports honestly when a scrape fails.

| | |
|---|---|
| **Live app** | _see `HANDOFF.md` — filled in at deploy time_ |
| **API** | _see `HANDOFF.md`_ |
| **Schedule** | every 2 hours (`0 */2 * * *`), with a per-product override |
| **Stack** | React 18 + Vite + TS on Vercel · Node 22 + Express + TS on Render · Supabase Postgres |

---

## What makes this store hard, and what this does about it

The scraping is the assignment; everything else is packaging. Phase 1 measured the store
before a line of application code was written — all of it is in
**[`STORE_NOTES.md`](STORE_NOTES.md)** with captured responses and timings. The short version:

| The store does this | This does that |
|---|---|
| Serves a 459-byte empty shell; everything renders client-side | Reads the store's own JSON API, found by de-obfuscating the shipped bundle |
| Guards every price behind a proof of work, a WebAssembly challenge and an interaction record | Completes the same handshake in Node with `node:crypto` + `WebAssembly` — ~600 ms, no browser |
| Returns the quote XOR-ciphered under the session token | Decrypts it; the price is read as an integer, not as text |
| Hides **two decoy prices** in `.price-value` and `[data-price]`, plus an MRP and a "Deal price" line | Every DOM candidate is filtered through `isDecoy()` before its text is believed |
| Renders the same price seven different ways (full-width digits, zero-width joiners, euro separators…) | `parse.ts` normalises all seven; each has a test |
| Rotates its class names and element order, and publishes the rotation at `/api/layout` | Fingerprints the structure, alerts on change, and never blocks a write because of one |
| Serves a **stale price ~22% low**, flagged `pending`, roughly 1 time in 10 | Treated as a miss. Retried, never stored. This is the single most expensive trap in the store |
| Returns 429/500/503 at random, with `retryAfter` in the body rather than a header | Classified, backed off, retried — and every attempt lands in the log |
| Rate-limits above ~2 req/s across all endpoints | One pacer in front of everything, including Chromium's own requests |
| Answers **200 with the SPA shell** for any unknown path | Product existence is decided by the API's 404, never by the HTML |
| Drops 17.5% of clicks on purpose | The headed run verifies a click by its effect and re-issues it |

**The one rule everything else serves:** a reading is written to `price_history` only after
it passes every guardrail. A gap in the chart is a correct description of a scrape that did
not work. A wrong point is a lie that survives forever.

---

## Architecture

```
                                  ┌──────────────────────────┐
   cron-job.org                   │  demo.inelabteamdev.com  │
   ├─ every 2h  POST /api/cron/scrape   (the mock store)     │
   └─ every 10m GET  /api/cron/keepalive └──────────┬────────┘
            │                                       │  1 request / 700 ms,
            ▼                                       │  one pacer for every client
   ┌────────────────────── Render (Node 22 + Express) ────────────────────┐
   │                                                                     │
   │  routes/      health · store · tracked · cron · alerts               │
   │       │                                                             │
   │  engine.ts    ┌─ 4 attempts, backoff 800ms → 2.4s → 7s ± 30%         │
   │               ├─ strategy chain, first validated result wins:        │
   │               │    api → embedded_json → dom → browser               │
   │               ├─ validate.ts — nothing wrong is ever stored          │
   │               ├─ fingerprint.ts — did the store change shape?        │
   │               └─ one scrape_logs row per attempt, written as it ends │
   │                                                                     │
   └──────────────────────────────┬──────────────────────────────────────┘
                                  │  service-role key (RLS on, no policies)
                                  ▼
             ┌───────────── Supabase Postgres ──────────────┐
             │ products · tracked_products · price_history  │
             │ scrape_logs · structure_fingerprints         │
             │ alerts · cron_runs · cron_locks              │
             └──────────────────────┬──────────────────────┘
                                    │  every read goes through the API
                                    ▼
                  ┌──── Vercel (React 18 + Vite + TS) ────┐
                  │  dashboard · strip chart · scrape log │
                  │  command palette · alerts             │
                  └───────────────────────────────────────┘
```

**Why the API strategy leads.** Phase 1 timed the full handshake at 617 ms and a few kB per
product. Chromium costs ~1.5 s and ~300 MB of Render's 512 MB free tier, plus ~90 s of build
time to install. The browser is strategy #4 and the engine behind the observable run — it is
insurance and a demonstration, not the default. This is the judgement the brief asks for, and
both paths were verified to return the same figure for the same product.

---

## Setup

### Prerequisites

Node 22+, npm 10+, a Supabase project, a Render account, a Vercel account.

### 1 · Database

Supabase → **SQL Editor** → **New query** → paste all of
[`db/schema.sql`](db/schema.sql) → **Run**. It is idempotent, so re-running is safe.

That creates eight tables, the `tracked_overview` view the dashboard reads, the
`search_products` ranking function, and the two advisory-lock functions. Row Level Security
is enabled on every table with **no policies**, so the anon key can read and write nothing —
the backend holds the service-role key and is the only thing that touches the database.

> The schema is exercised by the test suite: `backend/tests/schema.test.ts` runs this exact
> file against Postgres-in-WebAssembly and asserts the constraints, the cascades, the lock
> and the search ranking. It is the one file with no compiler in front of it, so it gets one.

### 2 · Backend, locally

```bash
npm ci
cp .env.example backend/.env      # then fill in the Supabase values
npm run dev:backend               # http://localhost:8080
```

Generate a cron secret of your own:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Build the catalogue index — the store has no search endpoint and `/api/catalog` returns a
random sample on every call, so search only works against a copy we hold (STORE_NOTES.md §3):

```bash
npm run seed:catalog -w backend
```

About two minutes for all 1,000 products, paced at the measured-safe request rate.
It is idempotent; re-run it any time to pick up changes.

### 3 · Frontend, locally

```bash
echo "VITE_API_BASE_URL=http://localhost:8080" > frontend/.env.local
npm run dev:frontend              # http://localhost:5173
```

### 4 · Deploy

Exact, runnable commands are in **[`HANDOFF.md`](HANDOFF.md)**. In outline:

- **Render** — New → Blueprint → this repository. [`render.yaml`](render.yaml) defines the
  service, the health check and every environment variable; Render prompts for the three
  secrets.
- **Vercel** — New Project → this repository. [`vercel.json`](vercel.json) sets the build,
  the output directory and the SPA rewrite. Add `VITE_API_BASE_URL` = your Render URL.
- **CORS** — set `CORS_ORIGINS` on Render to your Vercel origin and redeploy.

---

## Scraping schedule

**Every 2 hours**, triggered externally. Render's free tier sleeps after 15 minutes idle, so
an in-process timer would simply stop running — the brief's free-tier constraint is the
reason this is an external trigger rather than a `setInterval`.

Two jobs at [cron-job.org](https://cron-job.org):

| | Job 1 — scrape | Job 2 — keepalive |
|---|---|---|
| **Title** | `INE tracker — scrape` | `INE tracker — keepalive` |
| **URL** | `https://<render-url>/api/cron/scrape` | `https://<render-url>/api/cron/keepalive` |
| **Method** | `POST` | `GET` |
| **Schedule** | `0 */2 * * *` (every 2 hours) | every 10 minutes |
| **Header** | `x-cron-secret: <your CRON_SECRET>` | — |
| **Timeout** | 30 s | 10 s |
| **Notify on failure** | on | on |

Setting them up:

1. Create an account at cron-job.org and open **Cronjobs → Create cronjob**.
2. Paste the URL, choose **Custom** schedule, enter the expression above.
3. **Advanced** → request method `POST`; **Headers** → add `x-cron-secret` with your secret.
4. Set the timeout to 30 seconds and enable failure notifications.
5. **Save**, then **Test run** — a healthy response is `202 {"accepted":true,…}`.

**Why 202 rather than 200.** cron-job.org gives up after 30 seconds and a run with retries
can take longer. The endpoint races for the overlap lock first, so a double-fire still gets a
truthful `409`, then acknowledges and finishes the work in the background. The durable record
of what happened is `cron_runs` and `scrape_logs`, not the HTTP response. Add `?wait=1` to
force the synchronous form.

**Per-product frequency.** The cron fires every two hours; `listDueTracked` decides who is
actually due. A product set to 30 minutes is picked up by the first run after its interval
elapses. One schedule, N intervals — change it per product on its detail page.

---

## Environment variables

### Backend (Render, or `backend/.env`)

| Variable | Required | Default | What it does |
|---|---|---|---|
| `SUPABASE_URL` | **yes** | — | Supabase → Settings → Data API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | — | `service_role` secret. Backend only — never ship it to a browser |
| `CRON_SECRET` | **yes** | — | Shared secret for `POST /api/cron/scrape`, compared in constant time |
| `CORS_ORIGINS` | in production | `*` | Comma-separated allowed origins. Set to your Vercel URL |
| `STORE_BASE_URL` | no | `https://demo.inelabteamdev.com` | The only origin the fetcher will talk to; enforced on every request |
| `PORT` | no | `8080` | Render sets this |
| `LOG_LEVEL` | no | `info` | `debug` traces every strategy attempt |
| `LOG_FORMAT` | no | JSON | `pretty` for aligned human output |
| `SCRAPE_MAX_ATTEMPTS` | no | `4` | Attempts per product per cycle |
| `SCRAPE_CONCURRENCY` | no | `3` | Products in flight at once |
| `SCRAPE_RUN_BUDGET_MS` | no | `240000` | Whole-run budget; the remainder is logged `RUN_BUDGET_EXCEEDED`, never left silent |
| `SCRAPE_HEADERS_TIMEOUT_MS` | no | `12000` | Per-request headers timeout |
| `SCRAPE_BODY_TIMEOUT_MS` | no | `20000` | Per-request body timeout |
| `STORE_MIN_REQUEST_GAP_MS` | no | `700` | Minimum spacing between store requests, all clients (STORE_NOTES.md §8) |
| `MAX_PRICE_DELTA_RATIO` | no | `0.7` | A larger move needs a second strategy to agree before it is stored |
| `BROWSER_FALLBACK_ENABLED` | no | `false` | Allows the Playwright strategy. Needs browsers installed |
| `SENDGRID_API_KEY` | no | — | Optional: email alerts |
| `ALERT_TO_EMAIL` | no | — | Optional: where alerts go |
| `ALERT_FROM_EMAIL` | no | — | Optional: a SendGrid-verified sender |
| `APP_VERSION` | no | `1.0.0` | Reported by `/api/health` |

### Frontend (Vercel, or `frontend/.env.local`)

| Variable | Required | What it does |
|---|---|---|
| `VITE_API_BASE_URL` | **yes** | The Render backend URL, no trailing slash |

`.env.example` at the repository root has both blocks, ready to copy.

---

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/health` | `{ ok, version, database, lastRunAt }` |
| `GET` | `/api/store/search?q=` | Partial-name search across the indexed catalogue |
| `GET` | `/api/store/index-status` | How much of the store's 1,000 products is indexed |
| `GET` | `/api/tracked` | Every tracked product with its latest reading, 24h/7d deltas and a sparkline |
| `POST` | `/api/tracked` | `{ storeProductId }` — starts tracking and fires a first scrape |
| `GET` | `/api/tracked/:id` | One tracked product |
| `PATCH` | `/api/tracked/:id` | `isActive`, `scrapeIntervalMinutes`, `alertPriceBelow`, `alertOnRestock` |
| `DELETE` | `/api/tracked/:id` | Untrack and delete its history |
| `GET` | `/api/tracked/:id/history?range=24h\|7d\|30d\|all` | Readings **and** every attempt, sharing one time axis |
| `GET` | `/api/tracked/:id/logs?limit=&offset=&outcome=` | Paginated scrape log |
| `POST` | `/api/tracked/:id/scrape-now` | Runs the real engine for one product, synchronously |
| `GET` | `/api/alerts` · `POST /api/alerts/:id/read` | Alerts |
| `GET` | `/api/structure` | Every distinct store shape observed, newest first |
| `POST` | `/api/cron/scrape` | Header `x-cron-secret`. `202` accepted · `409` a run is in progress · `401` bad secret |
| `GET` | `/api/cron/runs` | Recent run summaries |
| `GET` | `/api/cron/keepalive` | Cheap 200, for the warm-up ping |

---

## Running the scraper in headed mode

```bash
npm run scrape:headed -w backend -- --product=15
npm run scrape:headed -w backend -- --product=15 --simulate=all
npm run scrape:headed -w backend -- --product=nordkraft-slimbook-pro --simulate=error --keep-open
```

A visible Chromium, a live overlay pinned to the page showing attempt number, strategy,
elapsed time, what it is waiting on and the backoff countdown, and the same narration on
stdout with timestamps.

What you are watching is `scrapeOne` from `src/scraper/engine.ts` — the production engine,
the same retries, the same validation, the same rows written to `scrape_logs` — with the
strategy chain reordered to put the browser first so there is something on screen. A demo
that runs different code from production demonstrates nothing.

| Flag | |
|---|---|
| `--product=<id\|slug\|name>` | Which product to watch. Default `15` |
| `--simulate=slow` | Hold the live quote request 9 s — the page sits on "Loading current price…" |
| `--simulate=late` | Hold it 4 s so the price lands well after the rest of the page |
| `--simulate=error` | Answer 503 six times, then let the real request through |
| `--simulate=all` | Slow response, then the 503 run, then recovery — the full narrative |
| `--no-db` | Dry run: narrate everything, write nothing |
| `--keep-open` | Leave the browser open when the run finishes |
| `--headless` | No window (for CI smoke checks) |

`--simulate` intercepts the **live** request and degrades the answer; the store is genuinely
asked. Six failures is not arbitrary: the store's own front-end retries a quote six times
internally, so anything less is absorbed silently and our engine never sees a problem.

Requires Chromium: `npx playwright install chromium`.

[`RECORDING.md`](RECORDING.md) is the shot list for the submitted screen recording.

---

## Tests

```bash
npm test                    # 98 tests, entirely offline
npx vitest --root backend   # watch mode
```

No credentials, no Docker, no network. Extraction runs against **real responses captured
from the store** in `recon/fixtures/` — the served shell, the idle/loading/success/error
render states, the 404 and 401 bodies — plus seven derived variants that transform that real
capture in one specific way each. `db/schema.sql` is executed against Postgres compiled to
WebAssembly.

The load-bearing cases:

- the decoy nodes are never read as the price, and neither is the MRP or the "Deal price" line
- all seven price renderings parse to the same number
- stock wording outside the known vocabulary maps to `unknown`, never to `in_stock`
- **a failed scrape writes log rows and zero history rows**
- a recovered scrape leaves `retried`, `retried`, `success` — not just `success`
- a 404 is not retried; tracking is paused and an alert is raised
- a `pending` quote is refused and retried, and the phantom −22% never reaches the chart
- the overlap lock admits one run and refuses the second, and a stale lock cannot wedge the scheduler

---

## Repository

```
backend/
  src/
    index.ts                 express app, CORS, graceful shutdown
    routes/                  health · store · tracked · cron · alerts
    scraper/
      engine.ts              retries, orchestration, the one place history is written
      fetcher.ts             undici pool behind the global pacer
      storeClient.ts         the store's price handshake, performed from Node
      browser.ts             Playwright session, fault injection, the reveal gate
      strategies/            api · embeddedJson · dom · browser
      parse.ts               price and stock normalisation
      validate.ts            the guardrails
      fingerprint.ts         structure-change detection
      errors.ts              the vocabulary the scrape log speaks
    db/                      typed Supabase queries
    lib/                     env · logger · lock · alerts
  scripts/
    headed-run.ts            the observable run
    seed-catalog.ts          builds the searchable catalogue index
    smoke.ts                 one-shot strategy check against the live store
  tests/                     98 tests against captured fixtures + pglite
frontend/
  src/
    components/StripChart.tsx  the hero graphic
    components/CommandPalette.tsx
    pages/                     Dashboard · ProductDetail · Alerts
    lib/                       api · format · gaps
db/schema.sql                run once in Supabase
recon/                       Phase 1 evidence and fixtures
```

### The written record

| | |
|---|---|
| [`STORE_NOTES.md`](STORE_NOTES.md) | Everything measured about the store, with evidence |
| [`DESIGN_NOTE.md`](DESIGN_NOTE.md) | How reliability was achieved, the trade-offs, and what the AI got wrong |
| [`DECISIONS.md`](DECISIONS.md) | Every judgement call, one line of reasoning each |
| [`AI_ERRORS.md`](AI_ERRORS.md) | Real mistakes, with the error text that caught them |
| [`HANDOFF.md`](HANDOFF.md) | Deploy runbook and verification evidence |
| [`RECORDING.md`](RECORDING.md) | Shot list for the headed-run recording |
