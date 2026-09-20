# DESIGN NOTE

Two things are designed here: a scraper that has to keep working unattended, and an
interface whose job is to tell the truth about it. Sections 1–3 are the reliability
engineering. Section 4 is the interface.

---

## 1. How the scraping was made reliable

Phase 1 came first: the store was measured before a line of application code existed, and
everything below is a response to something that was actually observed. The evidence is in
[`STORE_NOTES.md`](STORE_NOTES.md).

### 1.1 The strategy chain

Four strategies, tried in order, first *validated* result wins, and the winner is recorded on
the row it produced:

| # | Strategy | What it does | Against this store, today |
|---|---|---|---|
| 1 | `api` | Completes the store's price handshake in Node and decrypts the quote | **Wins every time.** ~600 ms |
| 2 | `embedded_json` | `__NEXT_DATA__`, JSON-LD, inline state blobs | Honest `PARSE_MISS` — the shell is 459 bytes |
| 3 | `dom` | cheerio, prioritised selectors, decoy filtering | Honest `PARSE_MISS` on a plain fetch |
| 4 | `browser` | Playwright: render, satisfy the reveal gate, read the page | Works; costs a browser process |

Strategies 2 and 3 currently miss. They are in the chain anyway, and that is a deliberate
choice rather than dead weight: strategy 1 depends on a **private API** — exactly the kind of
thing that disappears without notice — and both fallbacks cost one already-fetched 459-byte
document between them. Strategy 3's extractor is the same code strategy 4 runs on rendered
HTML, so the selector work, the decoy filtering and the seven price formats are written once
and tested once.

### 1.2 Retries that know what they are retrying

Four attempts per product per cycle; backoff 800 ms → 2.4 s → 7 s, each with ±30% jitter; the
store's own `retryAfter` wins when it gives one. What makes this more than a loop is that
every failure is **classified at the layer where it happened**:

`TIMEOUT` · `NETWORK` · `HTTP_429` · `HTTP_5XX` · `GATE_REJECTED` · `PARSE_MISS` ·
`PLACEHOLDER` · `STALE_QUOTE` · `VALIDATION_REJECT` · `IDENTITY_MISMATCH` · `PRODUCT_GONE` ·
`RUN_BUDGET_EXCEEDED`

and retryability is a property of the code, not a guess at the call site. The one that earns
its keep most often is **`PRODUCT_GONE`**: a 404 is *not* retried. The store answers
`{"error":"not_found"}` for a product that no longer exists, and hammering it three more
times only delays finding out. The tracker is paused, an alert is raised, and the cycle moves
on. Against that, `STALE_QUOTE` *is* retried — and retried rather than handed to a different
strategy, because a different messenger reads the same unsettled figure.

### 1.3 One pacer in front of everything

Phase 1 measured the store's limiter: 25/25 requests succeed at 400 ms spacing; 34% are
rejected at 150 ms and 77% at 120 ms. The ceiling is somewhere between 2.1 and 4.6 req/s.

So every outbound request — from the HTTP client *and* from Chromium, routed through
`page.route('**/api/**')` — takes a slot from one global queue at 700 ms ± jitter. Concurrency
is 3, but the pacer is what actually governs throughput: raising concurrency here would not
make a run faster, it would convert successful scrapes into 429s. That is not a theory; it is
what happened before the pacer covered the browser path (`AI_ERRORS.md` §3).

### 1.4 The overlap lock

Free-tier cron double-fires, and Render keeps the old instance alive during a deploy. Two runs
scraping the same product simultaneously write two history rows for one moment in time and
race each other's failure counter.

The textbook answer, `pg_try_advisory_lock`, does not work here: the backend reaches Postgres
through PostgREST, where every call is its own transaction on a pooled connection, so a
session-level lock would be released before the run started. The lock is therefore a **row**,
taken with `INSERT … ON CONFLICT … WHERE`, which is atomic — either you get the row back or
somebody else holds it. It goes stale after 10 minutes so a crashed run cannot wedge the
scheduler. Both behaviours are asserted in `backend/tests/schema.test.ts`.

### 1.5 Never writing on failure

This is the part everything else serves. A reading reaches `price_history` only after:

- the price parses to a finite number, `> 0` and `< 1,000,000`
- the currency is one we recognise
- the store has **not** flagged the quote `pending`
- the stock maps to a known enum, or to `unknown` with the raw wording kept — never coerced
  to `in_stock`
- for page-derived readings, the price does not exceed its own list price (the signature of a
  selector that drifted onto the struck-through MRP)
- the page still identifies as the product we are tracking
- the move from the last known price is under 70%, **or** a second, independent strategy
  returns the same number

On any rejection: a `scrape_logs` row explaining why, and **no history row**. The engine has
exactly one call site for `insertPriceHistory`, and it is unreachable without a passing
validation result. The database backs this up with `check (price > 0 and price < 1000000)`
and a stock-status enum, so even a bug upstream cannot write nonsense.

The trap this exists for is specific. Roughly one quote in ten comes back marked
`"v":"stale","g":1` with a price about 22% below the real one — and the store's own UI renders
those greyed out with an "Updating…" label, because it knows they have not settled.
Twenty-two percent is *inside* any sane continuity threshold, so a delta check will not catch
it. Stored, it becomes a price drop that never happened, in a chart nobody will ever
re-derive. It is treated as a miss.

### 1.6 Logging that describes the work, not the ending

One `scrape_logs` row per attempt, written **as that attempt finishes** rather than batched at
the end, so a run that crashes still leaves evidence of what it had done.

- `retried` — this attempt failed and another followed
- `failed` — this attempt failed and the budget is spent
- `success` — extracted, validated, written

A product that took three tries leaves `retried`, `retried`, `success`. Every row carries the
strategy, HTTP status, duration, classified error code, the raw error message, and whether the
store's structure had changed. `price_history.scrape_log_id` points back at the attempt that
produced the row, so any point on the chart can be traced to the request that made it.

### 1.7 Noticing when the store moves

Per fetch, a fingerprint: the layout variant, price element tag, price carrier, facet order
and class-family suffix the store publishes at `/api/layout`, plus which selectors matched and
the price node's ancestor path. Changed fingerprint → `structure_changed=true` on the row, an
alert, and a banner in the UI.

It never blocks a write. The store is allowed to redecorate; we are allowed to notice. The one
subtlety that matters: the price node carries a **fresh random class on every render**
(`vcla9xn`, then `vkru3i3`, same product, minutes apart), so that token is stripped before
hashing. Without it, every single page load would look like a breaking change and the signal
would be worthless.

### 1.8 Failing loudly rather than quietly

- Whole-run budget of 240 s. Products not reached are logged `failed` with
  `RUN_BUDGET_EXCEEDED` rather than left silent.
- `consecutive_failures` is tracked; at 3 an alert fires. Tracking is **never** auto-disabled
  for failures alone — the store having a bad hour is not a reason to stop watching.
- A skipped run is still recorded in `cron_runs`. A run that was prevented is something that
  happened.
- The UI shows "may be stale" beside the price once `consecutive_failures >= 3`, because a
  number that looks fine and is six hours old is the most dangerous thing this app could
  display.

---

## 2. Trade-offs

**HTTP client vs headless browser — the decision the brief asks for.**
Phase 1 proved the price is reachable with `fetch` + `node:crypto` + `WebAssembly` in 617 ms
and a few kB. Chromium costs ~1.5 s and ~300 MB of Render's 512 MB free tier, plus ~90 s of
build time to install. The API strategy leads; the browser is strategy 4 and the engine behind
the observable run. *What this gives up:* the API path depends on a private endpoint, and if
the store changed its handshake the primary path would break. That is why the chain exists,
why `BROWSER_FALLBACK_ENABLED` is one environment variable, and why both paths were verified
to return the same figure for the same product.

**Concurrency vs politeness.** Concurrency 3, but a 700 ms global pacer in front of it, so
effective throughput is ~1.3 req/s no matter what concurrency says. *What this gives up:* a
run of 50 products takes minutes rather than seconds. That is the correct trade — the
measurements show the alternative is not "faster", it is "the same work, plus retries".

**Retry budget vs cron window.** Four attempts with a worst case around 10 s of backoff, inside
a 240 s run budget, against cron-job.org's 30 s timeout. Resolved by acknowledging the trigger
with `202` and finishing in the background; `cron_runs` and `scrape_logs` are the durable
record. *What this gives up:* the HTTP response cannot report the final outcome. The lock is
still raced for before acknowledging, so a double-fire gets a truthful `409` rather than a
cheerful "accepted" that quietly does nothing.

**Gaps vs interpolation.** Gaps, always, drawn and labelled. *What this gives up:* a chart
that looks less tidy. It buys a chart that is true — and since the whole validation layer
exists to produce those gaps, smoothing them away would erase the evidence that it works.

**One catalogue index vs live search.** The store has no search endpoint and `/api/catalog`
returns a random sample with `page` ignored, so partial-name search requires our own copy.
*What this gives up:* a seeding step, and an index that can drift. Mitigated by a cold-index
fallback that samples the live store and says so in the response, and by a seeder that is
idempotent and takes two minutes.

**Reads through the API vs Supabase from the browser.** Everything goes through the backend;
RLS is on with no policies, so the anon key can read and write nothing. *What this gives up:*
one network hop and some latency. It buys exactly one place that owns correctness, and one
door for a future auth layer to guard instead of seven.

**Per-product intervals in the query vs multiple cron jobs.** One schedule; `listDueTracked`
decides who is due. *What this gives up:* a product on a 30-minute interval is only picked up
on a two-hourly boundary unless the cron runs more often. It buys one schedule for N intervals,
with no scheduler state to keep in sync.

**A browser-first headed run.** The observable run reorders the chain to put `browser` first,
because a terminal printing "617 ms, done" demonstrates nothing. *What this gives up:* the
recording does not show the strategy production actually uses first. Stated plainly in
`RECORDING.md` — and the engine, retries, validation and log rows are identical, because it
calls `scrapeOne`, not a copy of it.

---

## 3. What the AI got wrong, and how it was corrected

Six real mistakes, with the output that caught each one. The full text, including the error
messages, is in [`AI_ERRORS.md`](AI_ERRORS.md).

**1 · It assumed the store was a server-rendered shop.** The plan for the first five minutes
was "undici + cheerio, pick good selectors" — because that is what a price tracker usually
needs. `curl` returned 459 bytes and an empty `<div id="root">`. *Correction:* stop, read the
shipped JS bundle instead of the HTML, and find the real surface. *What it changed:* the
strategy chain is ordered by what Phase 1 measured, not by what the problem sounds like.

**2 · It generated perfectly uniform synthetic timings and misread the result.** The probe that
maps which parts of the store's interaction gate are enforced reported `moves=8 → 401`, which
would have forced the whole project onto Playwright. An earlier one-off probe with 14 moves had
returned `200 OK`. The difference was that the matrix emitted mouse moves exactly 60 ms apart
and frame times of exactly `16.67` — the server rejects uniform timings. Twelve of nineteen
rows were also silently invalid, because a `429` on the previous call had cascaded into
`ch.wasm === undefined`. *Correction:* jitter every synthetic value, honour `retryAfter`, and
never report a row the probe could not actually complete. *What it changed:* this is why
`scrape_logs.error_code` distinguishes `HTTP_429` from `PARSE_MISS` — a transport failure that
resurfaces as a parse error downstream is the most expensive kind to debug.

**3 · The browser strategy bypassed the rate pacer and rate-limited the whole engine.** The
pacer was built into the HTTP client; Chromium makes its own requests and nothing in that path
went through it. The store's front-end retries a failed quote six times internally, each of
which is three requests, so one click could be eighteen requests in seconds. The run ended:
four attempts, sixty seconds, `HTTP_429`, nothing stored — and the *API* strategy, which was
pacing itself perfectly, failed too. *Correction:* `page.route('**/api/**')` takes a slot from
the same pacer. *What it changed:* politeness is enforced at the boundary, because a rate limit
is a property of the target, not of one client.

**4 · `--simulate=error` served a fault count the store absorbed silently.** Two forced 503s
produced no visible effect at all: the page swallowed both inside its own six-attempt retry
loop and our engine never saw a problem. *Correction:* spend exactly the page's own retry
budget — six, read out of its bundle rather than guessed — which pushes it into its visible
error state, and *that* is what our engine reacts to. *What it changed:* when you inject a
fault into a system that already retries, you are not testing your retry logic until you have
exhausted theirs.

**5 · A guardrail that could only produce false negatives.** `price > mrp → reject` was written
to catch a selector that had drifted onto the struck-through list price. Applied
indiscriminately, it also rejected perfectly good API readings, where price and MRP arrive in
one decrypted payload and cannot be mismatched — and a genuine price rise past a stale list
price would have silently stopped the tracker recording anything ever again. Two tests failed
with "expected 'failed' to be 'success'". *Correction:* `CandidateReading.atomic`; the check
applies only to readings assembled from a page. *What it changed:* a validation rule has to
know which code path can actually produce the failure it defends against.

**6 · The build emitted to a path the deploy config did not point at.** `tsconfig.json` had
`rootDir: "."` and included `scripts` and `tests`, so the compiler produced
`dist/src/index.js` while `render.yaml` started `dist/index.js`. Typecheck passed, 98 tests
passed, the build "succeeded", and the deployment would have crash-looped on boot with a
module-not-found. Caught by running the built artefact. *Correction:* a separate
`tsconfig.build.json` that compiles `src` alone. *What it changed:* every verification step in
`HANDOFF.md` is an execution against a real URL rather than a reading of configuration.

**The pattern across all six.** Every one was caught by *running something* — curl, a probe, a
headed run, the test suite, the built binary — and none would have been caught by reading the
code. Four produced output that looked like a data problem and was actually a transport,
timing or packaging problem. That is why this project's failure taxonomy is as detailed as it
is, and why the scrape log records the classified cause of every attempt rather than just its
outcome.

---

## 4. The interface

### 4.1 What this thing is

It is an **instrument**. It watches something that moves and reports what it saw, including
when it failed to see anything. That is the whole design brief, and it settles a surprising
number of small decisions:

- A gap in the price line is **drawn as a gap**. Never interpolated, never smoothed. An
  interpolated line is a claim about a measurement that was never taken.
- Failures are **not muted, collapsed or filtered out by default**. On this dashboard,
  showing them is the feature.
- Every reading carries its provenance — which strategy read it, how long it took, which
  attempt it was. A number with no origin is a rumour.

The visual vernacular that fits is measurement equipment: strip charts, tick marks, hairline
rules, tabular figures, a large calm primary reading and quiet everything-else.

### 4.2 Tokens

```
paper     #E9EBEE   cool grey-blue ground — the instrument's body
panel     #FDFDFD   the card faces
ink       #131A22   text
rule      #C6CBD1   hairlines, chart grid
drop      #0F7B5A   price fell
rise      #B4442C   price rose
degraded  #8A6A1F   retried, stale, structure changed
idle      #6B7580   no data, inactive
```

Kept as given. The palette already does the one hard thing a price tracker's palette has to
do: green means *cheaper*, not *good*, and red means *dearer*, not *broken* — so the failure
state needs its own colour, which is what `degraded` is for. Three additional greys derived
for surfaces (`#F4F5F7` sunken, `#DDE1E6` hover, `#8892A0` secondary text) and one focus
blue (`#2A6FB5`) that appears **only** on keyboard focus rings, where a distinct hue is an
accessibility requirement rather than decoration.

### 4.3 Type

| Role | Face | Size / weight |
|---|---|---|
| Display reading (current price) | Instrument Serif | 56px / 400, tabular |
| Product name | Instrument Serif | 28px / 400 |
| Section headings | IBM Plex Sans | 15px / 600 |
| Body, labels, controls | IBM Plex Sans | 14px / 400–500 |
| Small print | IBM Plex Sans | 12.5px / 400 |
| **Numerals and timestamps in columns** | IBM Plex Mono | 12.5–13px / 400, `tabular-nums` |

Mono is for aligned figures only — log timestamps, durations, price columns — never for
labels. Labels in mono are a costume; columns in mono are legibility.

Scale: 12.5 / 14 / 15 / 17 / 20 / 28 / 56. The jump from 28 to 56 is deliberate: the current
price is the one thing the eye should land on first, and everything else stays quiet so it can.

### 4.4 Layout

A fixed left rail (216px) holding the destinations and an unread-alert count; content in a
single column, max 1180px. Below `lg` the rail becomes a top bar and the wordmark drops to the
mark alone, because the wordmark costs 120px a phone header does not have. Below `md` the
dashboard table becomes a list of cards — a table that scrolls sideways on a phone hides
exactly the columns that matter here, since the outcome and the deltas live at the right-hand
end.

Surfaces are **panels with a 1px rule, not cards with a shadow**. Three shadows exist in the
whole application (command palette, toast, chart readout) and each is for something that
genuinely floats above the page.

### 4.5 The strip chart

The characteristic object. One graphic that answers "what has the price done?" and "did the
scraper actually work?" at the same time.

```
 ₹1,65,813 ┤                                    ╭──────
           │                          ╭─────────╯
 ₹1,29,249 ┤────────────╮    (gap)    ╱
           │            ╰────╴  ╶────╯
           ├─────────────────────────────────────────── stock band
           │▌▌▌ ▌▌  ▌▌▌▌  ▌ ▌▌▌ ▌ ▌▌▌▌▌▌▌▌ ▌▌▌ ▌▌▌▌▌▌▌▌  attempt ticks
             ▲ filled = success   ▲ half = retried→ok   ▲ hollow+cross = failed
```

- **Price line** — 1.5px, `ink`. Broken wherever a reading sits meaningfully further from its
  neighbour than this series normally does. The plan said "1.6× the configured interval";
  driving it in a browser showed that shatters an entire chart the first time someone changes
  a product's interval, so the threshold is now 1.8× the *median observed* spacing
  (`frontend/src/lib/gaps.ts`). The break is drawn as a real gap with a dotted connector and a
  label saying how long it lasted.
- **Attempt ticks** — one per row in `scrape_logs`, on the baseline. Filled = success,
  half-height = this attempt was retried and a later one succeeded, hollow with a cross =
  failed. This is the honest-logging requirement rendered as a picture.
- **Stock band** — a 7px strip beneath the line: `drop` in stock, `degraded` low stock,
  `rise` out of stock, hatched for unknown. A thin band, not a second axis.
- **Crosshair** — follows the pointer, snaps to the nearest reading, and shows price, stock,
  strategy, duration and attempt number in a readout that flips sides rather than covering
  the line.
- **Range** — 24h / 7d / 30d / all, as a segmented control.

Built as hand-written SVG rather than with a charting library. Three of its five features —
per-attempt baseline glyphs in three styles, genuinely broken paths, and a state band — are
things a general-purpose chart component makes harder rather than easier, and this graphic is
where the brief says to spend the effort.

Its empty state is worth a line of its own. "No data" when four attempts failed is a lie of
omission, so with no readings but some attempts it says so: *"12 attempts so far, 4 of which
did not produce a storable reading. Nothing was written, which is the correct outcome — the
scrape log below says why."*

### 4.6 Motion and states

Motion happens for exactly two reasons: the user did something, or a state changed that they
should notice — a new reading landing on the chart gets a single 240 ms mark. Everything sits
inside `@media (prefers-reduced-motion: no-preference)`.

Loading uses **skeletons shaped like the content**, not spinners; a spinner tells you nothing
about what is coming. Errors say what happened and what to do next with the real error code
visible, and every engine error code has a plain-English sentence behind it
(`ERROR_COPY` in `lib/format.ts`) — this is a tool for someone who wants to know.

### 4.7 Quality floor — measured, not asserted

Driven in a real browser at 360, 414, 768, 1024 and 1440 px, on all three pages:

- **no horizontal overflow at any width** (`scrollWidth === clientWidth` everywhere)
- no unlabelled interactive control and no `svg[role="img"]` without an accessible name
- every hit target at least 24×24 px after the sweep found seven that were not
- one focus treatment, visible on every surface, never removed
- colour is never the only carrier: outcome dots differ in shape, the stock band hatches for
  `unknown`, deltas carry an explicit `+` or `−`
