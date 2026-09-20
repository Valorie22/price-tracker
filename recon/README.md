# recon/ — the Phase 1 evidence

Everything in [`STORE_NOTES.md`](../STORE_NOTES.md) was measured, not assumed. This directory
holds the measurements and the scripts that took them, so any claim in that document can be
re-run rather than taken on trust.

```
fixtures/     real store responses, also used as test fixtures
tools/        the probes that produced every number in STORE_NOTES.md
latency.json  38 full price cycles, raw
latency-report.txt   the percentile summary of the above
raw/          gitignored — the store's minified bundle and unprocessed responses
```

## fixtures/

Loaded by `backend/tests/`. Twelve are genuine captures; seven are that same real capture
transformed in one specific way each so a hostile case can be tested deterministically.
`backend/tests/fixtures.ts` labels every one as `real` or `derived` and says what was changed.

| | |
|---|---|
| `served-shell.html` | what the server actually returns: 459 bytes, empty root |
| `rendered-idle.html` | price hidden, reveal button **disabled** |
| `rendered-loading.html` | mid-flight: "Loading current price…" |
| `rendered-success.html` | settled, `lakh` format, both decoys present |
| `rendered-success-2.html` | same product minutes later: plain format, new random class |
| `rendered-error-503.html` | the store's own "Couldn't load the price after 6 attempts" |
| `api-*.json` | catalog, product, layout, challenge, and the 404 / 401 bodies |
| `rendered-structure-changed.html` | *derived:* class family `-z6` → `-q1`, euro price shape |
| `rendered-price-split.html` | *derived:* one `<span>` per character with zero-width joiners |
| `rendered-absurd-price.html` | *derived:* ₹9,99,99,999, for the delta guard |
| `rendered-unknown-stock.html` | *derived:* stock wording outside the known vocabulary |
| `rendered-out-of-stock.html` | *derived:* "Out of stock" |
| `ssr-jsonld.html`, `ssr-next-data.html` | *derived:* hypothetical server-rendered pages, for the embedded-JSON strategy |

## tools/

Plain Node, no dependencies except `playwright` for the two that drive a browser. Run from
the repository root.

| Script | What it answers | Where it appears |
|---|---|---|
| `deob.js` | What are the obfuscated endpoint names? Prints the bundle's whole string table | §2 |
| `probe-price.mjs` | Can the full price handshake be completed from Node? | §6 |
| `probe-att.mjs`, `probe-att2.mjs` | Which parts of the interaction record does the server actually enforce? | §6 |
| `probe-rate.mjs`, `probe-rate2.mjs` | What sustained request rate does the store tolerate? | §8 |
| `probe-faults.mjs` | How often does it return 429/5xx under load? | §7, §8 |
| `sample.mjs` | 38 full cycles: latency percentiles, price variance, the stale-quote rate | §7 |
| `network-capture.mjs` | Headed Playwright with a network listener; writes `../network.json` | §2 |
| `capture-fixtures.mjs` | Regenerates everything in `fixtures/` | — |
| `recapture-loading.mjs` | Re-captures the loading-state fixture, retrying the store's dropped clicks | — |

```bash
node recon/tools/probe-price.mjs normal 15     # one full handshake, timed
node recon/tools/probe-att2.mjs                # the enforcement matrix (~2 min, rate-limited)
node recon/tools/probe-rate2.mjs               # the sustained-rate ladder (~3 min)
node recon/tools/sample.mjs 38 15              # the latency table (~2 min)
node recon/tools/capture-fixtures.mjs          # regenerate the test fixtures
```

`probe-att2.mjs` and `probe-rate2.mjs` deliberately take minutes: they pace themselves against
the limiter they are measuring. The first version of `probe-att2.mjs` did not, and reported a
matrix in which twelve of nineteen rows were silently measuring nothing —
[`AI_ERRORS.md`](../AI_ERRORS.md) §2.

## raw/

Gitignored: it holds the store's own minified bundle and unprocessed response bodies, which
are theirs, not ours. `deob.js` needs `raw/index.js`. To regenerate:

```bash
mkdir -p recon/raw
curl -s https://demo.inelabteamdev.com/ -o recon/raw/root.html
BUNDLE=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' recon/raw/root.html | head -1)
curl -s "https://demo.inelabteamdev.com${BUNDLE}" -o recon/raw/index.js
node recon/tools/deob.js | head -c 400
```

The bundle hash changes when the store is redeployed, which is why it is read out of the HTML
rather than hard-coded.

## A note on scope

Every script here targets `demo.inelabteamdev.com` and nothing else, which is what the brief
permits. The application enforces the same constraint at runtime: `fetcher.ts` refuses any URL
outside `STORE_BASE_URL` before a request is made.
