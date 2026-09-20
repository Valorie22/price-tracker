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
