# AI_ERRORS

Real mistakes made while building this, in the order they happened, with the evidence that
caught them. Appended the moment something broke. Nothing here is reconstructed after the fact.

---

### 1 · Assumed the store was a server-rendered HTML shop and started reaching for cheerio

**When:** first five minutes of Phase 1, before any code was written.
**What I assumed:** a price tracker assignment implies a product page with a `<span class="price">`
in the HTML, so the plan was "undici + cheerio, pick good selectors".
**What actually happened:**

```
$ curl -s https://demo.inelabteamdev.com/ | head -c 400
<!doctype html><html lang="en"><head>… <title>INE Store</title>
<script type="module" crossorigin src="/assets/index-B9UiQq4X.js"></script>
</head><body><div id="root"></div></body></html>
```

459 bytes. No products, no prices, no markup to select at all.
**Correction:** stopped, read the JS bundle instead of the HTML, and found the real surface
(`/api/catalog`, `/api/product/:id`, `/api/layout`, and a gated price endpoint). The DOM
strategy survives in the chain as a fallback, but it was never going to be strategy #1.
**Cost:** ~5 minutes. **Lesson that shaped the build:** the strategy chain is ordered by what
Phase 1 measured, not by what a price tracker "usually" needs.

### 2 · Wrote `recon/tools/probe-att2.mjs` with perfectly uniform timings and misread the result

**When:** probing which parts of the store's interaction fingerprint are actually enforced.
**What happened:** the first matrix run reported `moves=8 → 401` and `moves=40 → 401`, which
would have meant the gate was un-passable and forced the whole project onto Playwright. But an
earlier one-off probe with 14 moves had returned `200 OK`, so the two results contradicted each
other. The difference was that the matrix generator emitted mouse moves exactly 60 ms apart and
frame times of exactly `16.67`:

```
moves=8   401 {"error":"unauthorized"}     ← uniform 60ms deltas, frames all 16.67
moves=8   200 OK                            ← after adding jitter, same move count
```

The run had also silently started failing for a second reason — `429 rate_limited` on
`/api/challenge` cascading into `ch.wasm === undefined`:

```
dwell=300 ERR The first argument must be of type string or an instance of Buffer … Received undefined
```

so twelve of the nineteen rows were not measuring anything at all.
**Correction:** rewrote the probe to (a) jitter every synthetic timing, (b) honour the
`retryAfter` in the 429 body and retry the whole cycle, and (c) never report a row it could not
actually complete. The corrected matrix is the one quoted in `STORE_NOTES.md` §6.
**Lesson that shaped the build:** a failed request that returns a *parse error further down the
pipeline* is the most dangerous kind, because it looks like a data problem rather than a
transport problem. This is why `scrape_logs.error_code` distinguishes `HTTP_429` from
`PARSE_MISS`, and why the engine classifies the failure at the layer where it occurred.

### 3 · The browser strategy bypassed the rate pacer and rate-limited the whole engine

**When:** first end-to-end run of `--simulate=error` against the live store.
**What I built:** a global request pacer in `fetcher.ts` that keeps our outbound requests
about 700 ms apart, measured in Phase 1 as comfortably inside what the store tolerates.
I then wrote the Playwright strategy and did not connect it to that pacer at all —
Chromium makes its own requests, and nothing I had written was in that path.

**What it cost:** the store's *own* front-end retries a failed quote six times internally
(`jr = 6` in its bundle), and each of those is three requests — challenge, session, price.
So one "Reveal price" click can be eighteen requests in a few seconds. Combined across
four engine attempts it tripped the store's limiter, and then the *API* strategy — which
was pacing itself perfectly — started failing too:

```
01:37:56.999 WARN attempt failed; backing off  attempt=2 code=HTTP_429
             msg=Store rate-limited us (retry after 1000 ms) waitMs=2633
01:38:09.927 WARN attempt failed; backing off  attempt=3 code=HTTP_429 waitMs=7038
01:38:30.274 WARN attempt failed with no retries left attempt=4 code=HTTP_429

  FAILED  after 4 attempts in 60.4s
  error   HTTP_429 — Store rate-limited us (retry after 1000 ms)
```

Four attempts, sixty seconds, nothing stored. The scraper had rate-limited itself.

**Correction:** `page.route('**/api/**')` now takes a slot from the same pacer before
letting any request through, so browser traffic and HTTP traffic share one budget. The
simulation counter also moved to session scope — it had been resetting on every new page,
so `--simulate=error` re-armed itself each attempt and could never recover, which is why
the run above had no successful ending to show.

**Lesson that shaped the build:** a rate limit is a property of the *target*, so the thing
that enforces politeness has to sit at the boundary, not inside one client. Two code paths
to the same host need one budget between them.

### 4 · `--simulate=error` served a fault count that the store absorbed silently

**When:** immediately after, tuning the observable run.
**What happened:** the first version answered the quote request `503` twice. Watching it,
nothing happened — the page showed a brief spinner and then the correct price. The store's
front-end had swallowed both failures inside its own six-attempt retry loop, so our engine
never saw a problem and the recording had nothing to show.
**Correction:** the fault plan now serves exactly the page's own retry budget (six, read
out of its bundle rather than guessed), which pushes it into its visible "Couldn't load the
price after 6 attempts" state — and *that* is what our engine reacts to. The constant is
named `STORE_INTERNAL_RETRIES` with a comment saying where the number comes from, so nobody
tunes it by trial and error again.
**Lesson:** when you inject a fault into a system that already retries, you are not testing
your retry logic until you have exhausted theirs.
