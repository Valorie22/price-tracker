# STORE_NOTES

Everything measured about `https://demo.inelabteamdev.com` before any application code was
written. Every claim here has evidence behind it — a captured response, a status code, or a
timing distribution. Nothing was assumed from what a price tracker "usually" needs.

Measurements taken 2026-09-20. Raw captures in `recon/fixtures/`, timing data in
`recon/latency.json`, probe scripts in `recon/tools/`.

---

## 1. Is the product data in the initial HTML?

No. The server returns a 459-byte Vite shell with an empty root node.

```
$ curl -s -D - https://demo.inelabteamdev.com/product/15
HTTP/1.1 200 OK
Server: nginx/1.30.4
Content-Type: text/html
Content-Length: 459

<!doctype html><html lang="en"><head>
  <title>INE Store</title>
  <script type="module" crossorigin src="/assets/index-B9UiQq4X.js"></script>
</head><body><div id="root"></div></body></html>
```

There is no price, no name, no markup to select. A cheerio-first plan would have had nothing
to parse — see `AI_ERRORS.md` §1.

**A second consequence, and a nasty one:** nginx serves that same shell with **HTTP 200** for
*every* unmatched path, including `/robots.txt` and `/product/99999`. A scraper that decides
"is this product gone?" from the HTML response can never detect a dead product. Only the API
answers 404 truthfully (§7). There is therefore no usable `robots.txt`; the brief's own
instruction — scrape this mock store and nothing else — is the operative rule, and
`fetcher.ts` enforces it with an origin check on every request.

## 2. Is there a JSON API behind it?

Yes. Four endpoints, found by reading the shipped bundle rather than by guessing:

```
$ grep -oE 'fetch\([^)]{0,80}' recon/raw/index.js
fetch(`/api/catalog?page=${e}&pageSize=${t}`
fetch(`/api/product/${e}`
fetch(`/api/layout`
fetch(n(566)+n(536)+`ge`)        ← string-obfuscated
```

The obfuscated ones resolve to `/api/challenge`, `/api/session` and
`/api/products/:id/price`. The bundle's string table is a standard base64 array; extracting
`pr()` and `vr()` and running them in Node printed all 120 entries in about a minute
(`recon/tools/deob.js`). That one step gave up the entire API surface, the price state
machine, the decoy nodes and the layout rotation — facts that would have taken dozens of
reloads to infer from a network trace alone.

| Endpoint | Method | Returns |
|---|---|---|
| `/api/catalog?page&pageSize` | GET | a **random sample** of the catalogue (§3) |
| `/api/product/:id` | GET | name, brand, category, sku, slug, description, specs, reviews — **no price** |
| `/api/layout` | GET | the store's own description of its current DOM shape (§4) |
| `/api/challenge` | GET | `{ salt, ts, difficulty, csig, wasm }` (§6) |
| `/api/session` | POST | `{ token }`, if the challenge is solved correctly |
| `/api/products/:id/price` | GET | the quote, XOR-ciphered, bearer token required (§6) |

No `__NEXT_DATA__`, no `__NUXT__`, no JSON-LD, no inline state blob. Confirmed empirically:

```
$ node -e "…collectJsonBlobs(servedShell)…"
0 blobs
```

## 3. How does search work? Can the whole catalogue be listed?

**There is no search endpoint.** The store's own UI has no search field; its browse page
says "Prices are shown on each product's page" and paginates a grid.

Worse for enumeration: **`/api/catalog` ignores its `page` parameter and returns a fresh
random sample on every call.**

```
$ for i in 1 2 3; do curl -s '…/api/catalog?page=1&pageSize=8' | jq -c '[.items[].id]'; done
[386,539,364,723,46,176,951,755]
[335,586,703,434,797,17,307,742]
[963,145,198,459,561,883,3,319]

$ for p in 1 2 199 200 201; do curl -s "…/api/catalog?page=$p&pageSize=5" | jq -c '.page, [.items[].id]'; done
1   [567,249,686,241,797]
2   [588,841,599,91,608]
199 [697,565,523,120,349]
200 [509,104,179,207,27]
200 [111,639,747,145,554]     ← page=201 clamps to 200, and returns different items again
```

`pageSize` is honoured up to about 60 and then capped. `total` is reported as **1000**, and
ids are contiguous **1–1000**:

```
id=1     HTTP 200      id=1000  HTTP 200
id=0     HTTP 404      id=1001  HTTP 404
```

**Consequence for the app.** "Search by partial or full product name" cannot be served from
the store at request time. It requires our own copy of the catalogue, which
`scripts/seed-catalog.ts` builds: draw random samples of 60 until new ids stop arriving
(coupon collector — about 125 draws for full coverage, each carrying complete metadata),
then fill any remainder by id. Search then runs as one ranked trigram query in Postgres.

## 4. Product detail: canonical URL and stable identifier

```
https://demo.inelabteamdev.com/product/<id>
```

`id` is the join key: contiguous, numeric, present in the URL and in every API path.
`slug` (`nordkraft-slimbook-pro`) and `sku` (`NOR-10015`) are stable too and are persisted
as metadata and used for the identity check, but `id` is what `store_product_id` holds.

`/api/product/15` also carries specs and reviews, which the dashboard surfaces — the brief
invites extra product information and this costs nothing extra to collect:

```json
{ "id": 15, "slug": "nordkraft-slimbook-pro", "name": "Nordkraft Slimbook Pro",
  "brand": "Nordkraft", "category": "Laptops", "sku": "NOR-10015",
  "specs": { "warranty": "5 years limited warranty", "countryOfOrigin": "Thailand",
             "weightGrams": 1400, "material": "Carbon-fibre composite lid", … },
  "reviews": [ { "rating": 2, "title": "Poor finish", "verifiedPurchase": true, … }, … ] }
```

## 5. Price: where it lives and every way it is rendered

### It is not in the DOM until you ask for it

The price block starts in an `idle` phase showing "Price hidden" behind a **disabled**
button. The button only enables after the pointer has been over the price area for at least
eight samples and 600 ms — a gate the store implements client-side *and* enforces server-side
(§6).

### The five numbers in one block

This is the captured markup of a settled price (`recon/fixtures/rendered-success.html`),
reformatted for reading:

```html
<div class="price-block price-success pw-z6">
 <div class="price-main">
  <span class="price-value" aria-hidden="true" style="display:none">₹97,111</span>      ← DECOY
  <span class="mr-z6" style="text-decoration:line-through">₹1,57,621</span>             ← MRP
  <span class="sl-z6">Deal price ₹1,43,435</span>                                       ← sale line
  <span class="vcla9xn pv-z6" style="font-family:var(--serif);font-size:2.4rem">
        Rs.&nbsp;1,29,249.00</span>                                                     ← THE PRICE
  <span class="bd-z6">23% off</span>
  <span class="amount" data-price="true" aria-hidden="true" style="display:none">₹1,14,234</span>  ← DECOY
 </div>
```

**`.price-value` and `[data-price]` are traps.** They are the two selectors a scraper reaches
for first, they are both `display:none` and `aria-hidden`, and both contain fabricated
numbers. Together with the MRP and the sale line there are four wrong answers sitting beside
the right one. The real figure is in an element whose classes are a **per-render random
token** (`vcla9xn`, `vkru3i3`, …) plus the layout's published `priceValue` class (`pv-z6`).

`dom.ts` therefore runs every candidate through `isDecoy()` — hidden, aria-hidden,
struck-through, "Deal price", "% off" — before believing its text, and the prioritised
selector list starts from the class `/api/layout` publishes rather than from anything
hard-coded.

### Six renderings of the same number

The store picks a format at random per quote. All six were observed:

| `format` | Rendering |
|---|---|
| *(default)* | `₹1,29,249` |
| `spaced` | `₹1 29 249` |
| `euro` | `₹1.29.249,00` — dots group, comma decimates |
| `trailing` | `₹1,29,249/- (incl. of all taxes)` |
| `unicode` | `₹１,２９,２４９` — full-width digits |
| `nbsp` | NBSP + zero-width space between **every** character |
| `lakh` | `Rs.&nbsp;1,29,249.00` |

Independently, `priceCarrier: "split"` wraps each character in its own `<span>`.

Currency is **INR**, not USD — the brief's draft schema defaulted to USD and storing that
would have been silently wrong data. `parse.ts` handles all seven shapes; `parse.test.ts`
asserts each one.

## 6. The price handshake, and exactly what the server enforces

`GET /api/products/:id/price` requires a bearer token from `POST /api/session`, which is only
issued for a correctly solved challenge:

```
GET /api/challenge → { "salt":"7e336ad5…", "ts":1789867204181, "difficulty":3,
                       "csig":"232bcb5e…", "wasm":"AGFzbQEAAAAB…" }   (~600 bytes of WASM)
```

The client must then supply, in one POST:

1. **proof of work** — smallest `n` where `sha256(salt + ":" + n)` starts with `difficulty`
   zeros. Difficulty was 3 in every challenge observed: **p50 4 ms, p95 13 ms**.
2. **a WebAssembly result** — instantiate the module shipped in the challenge and call its
   export `f(seed)`, where the seed derives from the salt and a hash of item 4. Node runs
   this natively; no dependency and no browser.
3. **a derived proof** — `sha256(sharedKey|derive|salt|wasmOut|sha256(record))`, which binds
   the record to the token so the server can recompute it.
4. **an interaction record** — a description of how the price area was used.

The response body is then XOR-ciphered under `sha256(sharedKey|enc|token)`.

### What item 4 actually has to contain

Measured one variable at a time, with the rate limiter respected
(`recon/tools/probe-att2.mjs`). Everything else held at a passing baseline:

```
baseline               200 OK
moves=0                401 {"error":"unauthorized"}
moves=4                401
moves=7                401
moves=8                200 OK        ← threshold
moves=41               200 OK
dwell=0                401
dwell=400              401
dwell=600              200 OK        ← threshold
frames=0               401
frames=3               401
frames=7               200 OK
canvas=empty           401
gl=empty               401
hc=0                   401
scr=[0,0,0]            401
untrusted              401           ← ix.trusted must be true
```

A first, buggy version of this matrix reported `moves=8 → 401`, which would have forced the
whole project onto Playwright. The difference turned out to be that the generator emitted
mouse moves exactly 60 ms apart and frame times of exactly `16.67`; **the server rejects
perfectly uniform timings.** Jitter every synthetic value. That cost an hour and is written
up in `AI_ERRORS.md` §2.

### The judgement this settles

The whole pipeline runs in Node with `node:crypto` + `WebAssembly` + `fetch`:

```
$ node recon/tools/probe-price.mjs normal 15
{ "ok": true, "ms": 617,
  "quote": { "p":165813, "m":197396, "s":93, "c":"INR", "v":"triple", "g":0, … } }
```

**617 ms and a few kB per product, versus ~1.5 s and ~300 MB of resident Chromium for the
same answer.** On Render's free tier that difference is a cron run that fits its window
against one that does not. Lightweight HTTP is the primary strategy; the browser is the
fallback and the engine behind the observable run. Both paths were verified to return the
same figure for the same product (`129249`, §9).

## 7. The awkward bits

### Latency — the store is fast, and that is not where the difficulty is

38 full cycles against product 15 (`recon/latency.json`):

| stage | n | p50 | p95 | max | statuses |
|---|---|---|---|---|---|
| `/api/challenge` | 38 | 74 ms | 96 ms | 287 ms | 38× 200 |
| proof of work (local CPU) | 38 | 4 ms | 13 ms | 15 ms | — |
| `POST /api/session` | 38 | 75 ms | 102 ms | 109 ms | 32× 200, 6× 429 |
| `/api/products/:id/price` | 32 | 74 ms | 122 ms | 196 ms | 29× 200, 1× 429, 1× 500, 1× 503 |
| `/api/product/:id` | 38 | 70 ms | 125 ms | 148 ms | 28× 200, 10× 429 |
| `/api/layout` | 38 | 69 ms | 100 ms | 145 ms | 22× 200, 16× 429 |

Nothing is slow at the network layer. The difficulty is entirely in **status codes, the
reveal gate, and the content of a 200.** Slowness, where it exists, is injected client-side:
the store's own tile click handler discards 17.5% of clicks and delays another 17.5% by
900 ms (`Xn` in its bundle), which is why `browser.ts` verifies a click by its effect and
re-issues it rather than assuming it landed.

### Error responses

| What | Status | Body |
|---|---|---|
| transient upstream failure | 500 / 503 | `{"error":"upstream_error"}` |
| rate limited | 429 | `{"error":"rate_limited","scope":"gate","retryAfter":2}` |
| rate limited (other endpoints) | 429 | `{"error":"rate_limited","scope":"general","retryAfter":1}` |
| product does not exist | 404 | `{"error":"not_found"}` |
| missing/invalid token | 401 | `{"error":"unauthorized"}` |
| any unmatched path | **200** | the SPA shell (§1) |

`retryAfter` arrives **in the body, not in a `Retry-After` header** — `fetcher.ts` reads both.

### A 200 that is not a reading

The most expensive trap in the store. Roughly one quote in ten comes back with
`"v":"stale","g":1`:

```
price | stock | pending | variant
165813   93      0        clean
165813   93      0        triple
128644   93      1        stale     ← 22% below the real price
165813   93      0        malformed
128644   93      1        stale
```

`g:1` is the store's own "not settled yet" flag; its UI renders these at 45% opacity with an
"Updating…" label. Stored, it becomes a phantom 22% price drop that never happened — and it
is *inside* any sane delta threshold, so a continuity check will not catch it.
`validate.ts` treats `pending` as a miss and the engine retries rather than asking a
different strategy, because a different messenger reads the same unsettled figure.

### Does the DOM shape vary between loads?

Yes, and the store publishes the variation itself:

```
$ curl -s https://demo.inelabteamdev.com/api/layout
{"revision":627000,"variant":4,"validUntil":1789882933952,
 "classes":{"priceWrap":"pw-z6","priceValue":"pv-z6","mrp":"mr-z6","sale":"sl-z6",
            "badge":"bd-z6","rating":"rt-z6","seller":"sr-z6","delivery":"dl-z6","stock":"st-z6"},
 "order":["rating","seller","delivery","stock"],
 "priceTag":"span","priceCarrier":"text","ratingAria":true,"sellerTitle":false}
```

The class family suffix, the facet order, the price element's tag and whether the price is
split per character all rotate on `validUntil`. On top of that the price node carries a fresh
random class on **every render** — `vcla9xn` in one capture, `vkru3i3` in the next, same
product, minutes apart.

`fingerprint.ts` hashes the parts that mean something (variant, carrier, tag, facet order,
class-family suffix, which selectors matched, the price node's ancestor path) and explicitly
strips the per-render token — otherwise every single page load would look like a breaking
change. `extract.test.ts` asserts both halves: stable across two real captures, changed when
the layout changes.

## 8. Rate limiting

Real, shared across `/api/*`, and easy to trip. Sustained-rate probe
(`recon/tools/probe-rate2.mjs`, 25 requests per row, 10 s idle between rows):

```
gap=2000ms  ok=25/25  429=0   → 0.48 req/s
gap=1400ms  ok=25/25  429=0   → 0.67 req/s
gap=1000ms  ok=25/25  429=0   → 0.92 req/s
gap= 700ms  ok=25/25  429=0   → 1.29 req/s
gap= 400ms  ok=25/25  429=0   → 2.10 req/s
```

and then, unpaced (`recon/tools/probe-faults.mjs`):

```
/api/product/15  ×80 @150ms   53× 200, 27× 429   (34% rejected, ≈4.6 req/s)
/api/layout      ×60 @120ms   14× 200, 46× 429   (77% rejected, ≈5.4 req/s)
```

The ceiling sits between 2.1 and 4.6 req/s. **Operating rule: ~1.3 req/s
(`STORE_MIN_REQUEST_GAP_MS = 700`), honour `retryAfter`, treat 429 as retryable.** That is
comfortably inside the proven-safe band with room for jitter.

Everything that talks to the store goes through one pacer — including Chromium, whose
requests are routed through it by `page.route('**/api/**')`. Skipping that step once cost a
whole run to self-inflicted 429s (`AI_ERRORS.md` §3).

No cookies are required. No `Retry-After` header, no `X-RateLimit-*` headers. A realistic
`User-Agent` and `Accept-Language` are sent as ordinary good manners; nothing observed
suggests the store checks them.

## 9. What this means for the scraper

| Decision | Because |
|---|---|
| `api` is strategy #1 | 617 ms vs ~1.5 s + 300 MB, and it bypasses the entire display layer |
| `embedded_json` is #2 | costs nothing (the document is already fetched); today it honestly reports `PARSE_MISS` |
| `dom` is #3 | today it misses on a plain fetch; it is the insurance if the private API disappears |
| `browser` is #4 | the only strategy that needs a browser process; also the engine behind the headed run |
| one pacer for everything | the rate limiter is a property of the store, not of a client |
| `pending` is a miss | the store says the figure is not final; believing it anyway invents a 22% drop |
| decoys are excluded by rule | four wrong numbers sit beside the right one in the same block |
| fingerprint ignores the random class | otherwise every page load is a false "structure changed" |
| 404 is terminal | `{"error":"not_found"}` will not change on the next attempt |
| identity is checked per reading | the store can shift pages under a scraper; the name must still match |

**Cross-check.** Both paths were run against product 15 within a minute of each other:

```
api      → 129249 INR, stock 151, validated
browser  → 129249 INR, "Only 151 left", validated
```

Same number, read two completely different ways. That agreement is what makes the fallback
chain worth having.
