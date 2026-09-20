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

### 5 · A guardrail that would have rejected correct data

**When:** first run of the validation test suite.
**What happened:** two tests failed with "expected 'failed' to be 'success'". The reading
was clean — right product, right currency, a 28% move well inside the delta threshold — and
the engine threw it away. The culprit was a rule I had written into `validate.ts` without
thinking about where its inputs come from:

```
if (reading.mrp != null && reading.price > reading.mrp * 1.02) reject(...)
```

The intent was sound: the store's price block holds five numbers — two hidden decoys, a
struck-through MRP, a "Deal price" line and the real figure — and a selector that drifts one
element comes back with them inverted. A price above its own list price is the signature of
that mistake.

But the API strategy reads price and MRP out of **one decrypted payload**. They cannot be
mismatched, so the rule has nothing to catch there — while a genuine price rise past a stale
list price would silently stop the tracker from ever recording anything again. A guardrail
that can only produce false negatives on its most-used path is worse than no guardrail.

**Correction:** `CandidateReading` now carries `atomic`. The API strategy sets it and the
check is skipped; anything reading a rendered page does not, and the check applies in full.
Both branches are now tested explicitly.

**Lesson that shaped the build:** a validation rule needs to know which failure it is
defending against and which code path can actually produce that failure. Applied
indiscriminately, the same rule that catches a parsing error becomes a source of silent
data loss.

### 6 · The build emitted to a path the deploy config did not point at

**When:** first time the compiled output was actually run, rather than typechecked.
**What happened:**

```
$ npm run build -w backend && node backend/dist/index.js
Error: Cannot find module 'C:\…\backend\dist\index.js'
$ ls backend/dist
scripts/  src/  tests/
```

`tsconfig.json` had `rootDir: "."` and included `src`, `scripts` and `tests`, so TypeScript
preserved that structure and emitted `dist/src/index.js`. Meanwhile `render.yaml` said
`startCommand: node backend/dist/index.js`. Typecheck passed. The tests passed. The build
"succeeded". The deployment would have crash-looped on boot with a module-not-found, and the
only clue would have been a Render log.

**Correction:** `tsconfig.build.json` compiles `src` alone with `rootDir: "src"`, so `dist`
mirrors `src` and the start command resolves. `tsconfig.json` still covers scripts and tests
for `typecheck`, which is what it is for — those run through `tsx` and `vitest` and are never
compiled. CI now runs `npm run build` and the Render start path is the one that gets built.

**Lesson that shaped the build:** "it compiles" is not "it runs". Every verification step in
`HANDOFF.md` is an execution against a real URL, not a reading of configuration — this is the
class of bug that only appears when you run the artifact you are about to ship.

### 7 · `--simulate=all` had its two faults in an order that produced no failure at all

**When:** final verification of the observable run, one command before calling it done.
**What happened:** `--simulate=all` was supposed to show the whole arc — a slow response, then
a run of 503s, then recovery. Run against the live store, it produced this:

```
02:04:41.421  ⚡ simulated fault   holding the quote request for 9000 ms (1/7)
02:04:50.576  figure read from the page   price=129165 stock=Out of stock
  SUCCESS  after 1 attempt in 12.7s
```

One attempt, no retry, no backoff. The six queued 503s were never served.

The reason is a distinction I had not made: **a slow response is not a failed response.** The
store's front-end retries only on failure, so holding its first quote request for nine seconds
just made it wait — it then succeeded on that same attempt, consumed the delay step, and never
reached the failures behind it. The demo of failure handling contained no failure.

**Correction, in two steps.** Reordering it — failures first, delay second — produced a real
failure, but the run then took *four* attempts, because the failures leaked across attempt
boundaries in a way that varied with timing. One run recovered on attempt 2; the next used the
entire retry budget and would have reported FAILED if the store had had one genuine bad moment.
That is not something to build a recording around.

So the fault plan is now scoped to an **engine attempt** rather than to the session: attempt 1
meets the 503 run, attempt 2 meets the slow response, and everything after meets a healthy
store. The narrative is the same every time — fail, back off, wait, recover, in 34 seconds:

```
02:07:36  ⚡ forced HTTP 503 upstream_error (1/8) … (6/8)
02:07:50  attempt failed — backing off   code=PARSE_MISS waitMs=676
02:07:57  ⚡ holding the quote request for 9000 ms (1/1)
02:08:06  figure read from the page  price=129165
  SUCCESS  after 2 attempts in 34.2s
```

**Lesson:** "the demo ran without errors" is not the same as "the demo showed what it was
built to show". The only way to know was to watch the output, which is also the argument for
`RECORDING.md` being a shot list of things to *see* rather than commands to run.

### 8 · A view that silently bypassed every RLS policy in the database

**When:** minutes after applying the schema to the real Supabase project, running the
security advisor on it.

**What I had built:** RLS enabled on all eight tables with no policies, so the public anon
key can read and write nothing. Everything goes through the backend with the service-role
key. That design is sound, it is documented in `DESIGN_NOTE.md`, and the test suite asserted
it — against pglite, where `anon` does not exist.

**What the advisor found:**

```
ERROR  security_definer_view
       View `public.tracked_overview` is defined with the SECURITY DEFINER property
```

Postgres creates views as SECURITY DEFINER unless told otherwise, so `tracked_overview` ran
with its *owner's* rights and did not apply RLS to the tables underneath it. And Supabase
grants `anon` SELECT on new objects by default:

```sql
select has_table_privilege('anon','public.tracked_overview','SELECT');  -- true
```

That view joins `products`, `tracked_products`, `price_history` and `scrape_logs`. The entire
catalogue, every price, and the whole scrape log were readable with the publishable key —
through the single object that conveniently joins all of them. RLS on the tables was doing
nothing to stop it.

**Correction:** `security_invoker = on` on the view, so RLS applies; `search_path` pinned on
all three functions; `pg_trgm` moved out of `public`; and every grant to `anon` and
`authenticated` revoked, since nothing outside the backend needs one. ERROR and both WARNs
cleared.

**Then I got the second half wrong.** Checking the fix, `anon` could still execute
`search_products`. I diagnosed it as an ordering bug — "`create or replace function` re-grants
EXECUTE to PUBLIC, so my revoke above the definitions was undone" — wrote that into the schema
comments, and moved on. It was wrong. Four lines of Postgres settled it:

```
1. freshly created                             proacl = null
2. after REVOKE ... FROM anon                  {=X/postgres,postgres=X/postgres}
3. after create-or-replace                     {=X/postgres,postgres=X/postgres}   ← unchanged
4. after REVOKE ... FROM PUBLIC                {postgres=X/postgres}
```

`create or replace` does not re-grant anything. The real cause is that a new function's
`proacl` is **NULL**, and NULL does not mean "no grants" — it means *default* privileges,
which for a function is EXECUTE to PUBLIC. Revoking from `anon` never removes that, because
anon holds it through PUBLIC; all the revoke does is materialise the ACL so PUBLIC's entry
finally becomes visible. The revoke has to target PUBLIC.

**What it changed:** the fix, the comments in `db/schema.sql`, and the test. The first version
of the test asserted "the ACL string contains no PUBLIC entry" — which passes vacuously on a
NULL ACL, i.e. on precisely the vulnerable state. It now asserts the ACL is non-NULL *and*
carries no PUBLIC entry.

**Lesson that shaped the build:** two of them, and the second is the sharper one. A guarantee
that holds in the test environment can be absent in production — `anon`, `authenticated` and
`service_role` do not exist in pglite, so no local test could ever have caught this; it took
running the advisor against the real project. And in a permission system, *absence of a
visible grant is not absence of a grant*. A NULL ACL and a locked-down ACL look equally empty
and mean opposite things.

---

### 9 · Shipped a `render.yaml` whose build command could never have worked

**When:** the first Render deploy, minutes after the repository was finally pushed.
**What I assumed:** `render.yaml` had been written in Phase 4 and reviewed twice, and
`npm ci && npm run build -w backend` is the same command that passes locally and in CI. I
treated it as verified because the *string* was correct.
**What actually happened:** the build failed 18 seconds in.

```
==> Running build command 'npm ci && npm run build -w backend'...
added 131 packages, and audited 134 packages in 2s
> backend@1.0.0 build
> tsc -p tsconfig.build.json
error TS2688: Cannot find type definition file for 'node'.
  The file is in the program because:
    Entry point of type library 'node' specified in compilerOptions
npm error Lifecycle script `build` failed with error: code 2
==> Build failed 😞
```

`131 packages` is the tell. Locally the same install brings in an order of magnitude more.
`render.yaml` itself sets `NODE_ENV=production`, and under that value `npm ci` omits
`devDependencies` — where this project keeps `typescript`, `@types/node`, `tsx`, `vitest` and
`playwright`. The build command asked `tsc` to run in a tree that deliberately had no `tsc`
and no Node type definitions in it.

**Correction:** `npm ci --include=dev && npm run build -w backend`. `include` beats the
`omit` that `NODE_ENV` implies regardless of ordering, so it is the right lever rather than
deleting `NODE_ENV=production`, which the app reads at runtime. The running service was
already created from the API, where the build command is not editable through the connector,
so it was fixed there with `NPM_CONFIG_INCLUDE=dev` — npm reads `NPM_CONFIG_*` as config, and
it reaches the same state from the environment side.

**What it changed:** `render.yaml`, and the live service's environment.

**Lesson that shaped the build:** a deploy config is not verified by reading it, only by
running it — the same rule BUILD_SPEC.md §0.4 sets for every other phase, which I had quietly
exempted the deployment files from because they were "just YAML". Nothing local could have
caught this: the failure needs `NODE_ENV=production` at install time, and no local run, no
test and no CI job sets it. This is the second deploy-config error in this log (§6 was the
build output path) and both have the same shape — a file that describes an environment I had
not yet executed in.
