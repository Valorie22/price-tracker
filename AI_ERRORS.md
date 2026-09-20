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
