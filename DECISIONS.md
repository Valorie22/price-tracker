# DECISIONS

Every judgement call made while building this project, with one line of reasoning.
Newest entries are appended at the bottom of each phase.

---

## Phase 1 — Reconnaissance

**D1 · Measure the store before writing a line of app code.**
The brief says the store is deliberately awkward. Guessing selectors would have produced a
scraper built on fiction. Everything in `STORE_NOTES.md` is backed by a captured response.

**D2 · Read the shipped JS bundle rather than only watching the network.**
`https://demo.inelabteamdev.com/assets/index-*.js` is the whole client. Reading it revealed the
API surface, the price-reveal state machine, the decoy DOM nodes and the layout rotation in
minutes — facts that a network trace alone would have taken dozens of reloads to infer.

**D3 · Primary strategy = lightweight HTTP, not a headless browser.**
Phase 1 proved the price is reachable with `fetch` + `node:crypto` + `WebAssembly` in ~600 ms
per product. A browser costs ~1.5 s cold plus ~300 MB RAM on Render's free tier and adds a
cold-start penalty to every cron run. Browser is kept as strategy #4 (and for the headed run),
not as the default. This is the judgement the brief explicitly rewards.

**D4 · Treat the store's own anti-automation gate as part of the assignment, not an obstacle
to route around.** It is INE's own mock store, published for this exercise, and the brief says
to scrape it. The client replicates the same handshake the store's own front-end performs, at a
politer rate than a human clicking refresh.

**D5 · Build our own product index instead of relying on store search.**
The store has no search endpoint, `/api/catalog` returns a *fresh random sample* on every call,
and the `page` parameter is ignored. A user-facing "search by partial name" is therefore only
possible against a catalogue we ingest and persist ourselves. See `STORE_NOTES.md` §3.

**D6 · Identify products by the store's numeric `id`, stored as `store_product_id`.**
`id` is contiguous 1–1000, appears in the canonical URL (`/product/:id`) and in every API path.
`slug` and `sku` are stable too and are persisted as metadata, but `id` is the join key.

**D7 · Currency default is `INR`, not `USD`.**
The schema in the brief defaulted to USD; the store quotes `"c":"INR"` and renders with
`Intl.NumberFormat('en-IN')`. Storing USD would have been silently wrong data — exactly the
failure mode the brief grades hardest. Schema default changed.

**D8 · Store request pacing at 700 ms (≈1.3 req/s), enforced for every client.**
Measured: 25/25 succeed at 400 ms spacing; 34% are rejected at 150 ms and 77% at 120 ms. The
ceiling is between 2.1 and 4.6 req/s, so 1.3 req/s sits inside the proven-safe band with room
for jitter. Enforced at the boundary — Chromium's own requests route through the same queue.

**D9 · `pending: true` is a miss, not a reading, and triggers a retry rather than a
different strategy.** The store flags an unsettled quote and renders it greyed out; the
figure is ~22% low and *inside* any sane delta threshold, so continuity checks will not save
you. A different strategy reads the same unsettled figure, so the correct response is to wait.

**D10 · The MRP-consistency guard applies only to readings assembled from a page.**
See `AI_ERRORS.md` §5 — applied to the API path it could only ever produce false negatives.

**D11 · `--simulate` intercepts the live store rather than pointing at a mock.**
A recording of a scraper recovering from a fake server proves nothing about the scraper. The
request really goes to the store; only the answer is degraded. The fault count is read from
the store's own retry budget (6) so the page reaches its visible error state.

**D12 · The headed run drives the production engine, not a copy of it.**
`scrape:headed` calls `scrapeOne` with the strategy chain reordered to put `browser` first.
Same retries, same validation, same log rows. A demo that runs different code demonstrates
nothing. With `--simulate` the chain is browser-only, because route interception cannot reach
the HTTP client and leaving `api` in would rescue every injected fault.

## Phase 3 — Application

**D13 · All reads go through the backend; the frontend never queries Supabase.**
RLS is on with no policies, so the anon key can read and write nothing. One place owns
correctness, and a future auth layer has one door to guard instead of seven.

**D14 · The overlap lock is a row, not `pg_try_advisory_lock`.**
The backend reaches Postgres through PostgREST, where every call is its own transaction on a
pooled connection — a session-level advisory lock would be released before the run started.
`INSERT … ON CONFLICT … WHERE` is atomic and does the same job, with a 10-minute staleness
window so a crashed run cannot wedge the scheduler.

**D15 · `/api/cron/scrape` acknowledges in 202 and finishes in the background.**
cron-job.org gives up after 30 s; a run with retries can take longer. The durable record is
`cron_runs` + `scrape_logs`, not the HTTP response. `?wait=1` forces the synchronous form for
the verification steps in `HANDOFF.md`. The lock is still raced for first, so a double-fire
gets a truthful 409 rather than a cheerful acknowledgement that does nothing.

**D16 · Per-product interval is enforced in the query, not in the schedule.**
One cron job every two hours; `listDueTracked` decides who is actually due. A product set to
30 minutes is picked up by the next run after its interval elapses. One schedule, N intervals.

**D17 · Tracking a product fires an immediate scrape, out of band.**
A new tracker with an empty chart is a bad first impression, and the first reading is what
tells the user the pipeline works. The response does not wait for it.

**D18 · The strip chart is hand-written SVG; Recharts is dropped.**
The brief's stack named Recharts, and the brief's chart specification asks for per-attempt
baseline glyphs in three styles, genuinely broken paths where data was rejected, and a stock
state band — three things a general-purpose chart component makes harder rather than easier.
The chart is where the brief says to spend the effort, so it is built directly. Dependency
removed rather than left installed and unused.
