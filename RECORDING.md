# RECORDING.md — the observable run

A 2–4 minute screen recording of the scraper working against the live store, **including a
slow response and a failure**. The brief asks for the failure to be shown; hiding it would
defeat the point of the clip.

---

## Before you start

```bash
npx playwright install chromium          # once
cp .env.example backend/.env             # with real Supabase values, so rows are written
npm run seed:catalog -w backend          # so the UI has something to search
```

Have two things open:

1. A terminal, at least 100 columns wide, font large enough to read at 1080p.
2. The deployed app (or `npm run dev:frontend`) on the detail page for **Nordkraft Slimbook
   Pro** (store id 15).

Record at 1920×1080. Do not speed anything up — the waiting is the content.

---

## The shot list

### 0 · Set the scene — 15s

Terminal. Say what is about to happen and run:

```bash
npm run scrape:headed -w backend -- --product=15
```

Chromium opens, the store's product page loads, and a dark overlay panel pins itself to the
top-right. Point at the overlay: **attempt**, **strategy**, **status**, **waiting on**,
**simulation**.

### 1 · A clean run — 30s

Let it complete untouched. The panel narrates:

```
opening the product page   → waiting for the price block
satisfying the reveal gate → 8 pointer samples + 600ms dwell
clicking "Reveal price"    → state to leave idle
waiting for a settled figure
figure read from the page  → price=129249  stock=Only 151 left
validated                  → writing history
SUCCESS  after 1 attempt in 3.3s
```

Worth saying out loud: the store **disables** that button until the pointer has been over
the price area for eight samples and 600 ms, and enforces the same thing server-side. The
gate is part of the assignment, not an obstacle around it.

### 2 · A slow response, and the wait — 35s

```bash
npm run scrape:headed -w backend -- --product=15 --simulate=slow
```

The quote request is held for nine seconds — **against the real store**, by intercepting the
live request rather than pointing at a mock. The page sits on "Loading current price…"; the
overlay clock runs; `waiting on` reads `price-success, not "Updating…"`.

Let the whole nine seconds play. This is the shot that shows the scraper waits on a
**condition** rather than a fixed timer: a `waitForTimeout` would be either too short here or
wasted on a fast response.

### 3 · Failure, backoff, recovery — 60s

```bash
npm run scrape:headed -w backend -- --product=15 --simulate=error
```

Watch for, in order:

1. `⚡ simulated fault — forced HTTP 503 upstream_error (1/6) … (6/6)` — six failures, which
   is exactly the store's own internal retry budget. Fewer would be absorbed silently and our
   engine would never see a problem.
2. The store's page gives up and renders **"Couldn't load the price after 6 attempts."**
3. Our engine classifies it: `attempt failed — backing off  code=PARSE_MISS`.
4. **The overlay's backoff bar counts down** to the next attempt. Let it run.
5. Attempt 2 opens a fresh page, the fault window is over, the real store answers, and the
   figure is read and validated.

```
SUCCESS  after 2 attempts in 25.4s
reading  ₹1,29,249  ·  in_stock

scrape_logs rows written by this run (2)
time          #   outcome   strategy  ms      error
02:18:44.201  1   retried   browser   19270   PARSE_MISS
02:19:10.560  2   success   browser   5393
```

Read that table out. It is the honest-logging requirement in four lines: the failure is a
row, not a silence, and the run that recovered still says it had to.

### 4 · Cut to the UI — 45s

Switch to the browser, on the product's detail page. Reload.

- **The new point has landed** on the right-hand end of the strip chart.
- **The baseline ticks**: filled for the success, half-height for the retry that preceded it.
  Hover one — the tooltip gives timestamp, attempt number, outcome, strategy and duration.
- **Scroll to the scrape log.** The `retried` row is there, not muted, not collapsed, not
  filtered out by default. Expand it with **why** and read the classified error.
- If the chart has a gap, hover it: `no reading · 4.2h`. Say why it is drawn as a hole —
  something was attempted there and its result was refused, and joining the line across it
  would invent a measurement nobody took.

### 5 · Close — 15s

Back to the dashboard for one wide shot: the run-health strip, the rows with their
sparklines, the last-outcome dots, the countdown to the next scrape.

One sentence to end on: **nothing on this screen was guessed. Every point passed validation,
and every attempt that did not is still in the log.**

---

## If you want the whole arc in one take

```bash
npm run scrape:headed -w backend -- --product=15 --simulate=all
```

Slow response → 503 run → recovery, in a single ~40-second run. Shorter, but each phase gets
less room; the separate takes above read better.

---

## Notes

- `--keep-open` leaves the browser up at the end if you want a still frame to talk over.
- Prices move between takes. That is the store, not an error — say so if it happens.
- If a run finishes on attempt 1 when you wanted a retry, the store simply had a good
  moment. Run it again, or use `--simulate`.
- Recording without a database (`--no-db`) still narrates everything but writes nothing, so
  the log table in §3 will be empty. Use a real Supabase connection for the take.

## Checklist before submitting the clip

- [ ] 2–4 minutes
- [ ] A slow response, with the wait visible in real time
- [ ] A failing response, the backoff countdown, and the recovery
- [ ] The `scrape_logs` rows the run produced, on screen and readable
- [ ] The UI showing the new point **and** the retried row in the log
- [ ] Audio or captions explaining what is happening
