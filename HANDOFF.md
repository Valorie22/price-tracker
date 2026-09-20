# HANDOFF

Everything that does not need a credential is built, tested and committed. What is left
needs accounts only you can sign into. This file is the exact sequence — commands to paste,
values to copy, and the verification evidence to capture at the end.

**Time: about 25 minutes**, most of it waiting for Render's first build.

> ### RESUMING IN A NEW SESSION? START HERE.
>
> **Done and proven:** Supabase live and hardened, 1,000 products indexed, full scrape
> pipeline run end to end against the live store (§6 has the real output). 103 tests, lint,
> typecheck and build all green. 23 commits on `main`, nothing uncommitted, no secrets tracked.
> `backend/.env` exists (gitignored) with the Supabase URL, the service-role key and the cron
> secret — a new session can just use it.
>
> **Blocked on exactly one thing:** the GitHub repo
> https://github.com/Valorie22/price-tracker was created and is **empty**. The push was
> rejected because the personal access token had `repo` scope but not `workflow`, and the
> history contains `.github/workflows/ci.yml`. A token with **both `repo` and `workflow`**
> fixes it — nothing else is wrong.
>
> **Then, in order:** push → Render (§3, connector available) → Vercel (§4, connector already
> authenticated) → set `CORS_ORIGINS` to the Vercel origin → cron-job.org (§5, manual) →
> capture §6 evidence against the Render URL.
>
> **Housekeeping:** the Supabase service-role key and the GitHub token were both pasted into a
> chat. Rotate both once submitted.
>
> ---
>
> **Status, 2026-09-20.**
> **§2 Supabase — done and proven.** Project `ine-price-tracker`
> (ref `mpxqbtqwmtgakzintwev`, ap-southeast-1, free tier). Schema applied, security advisor
> findings fixed, all 1,000 products indexed, and the **full pipeline run end to end against
> the live store and live database** — see §6, which now contains real output rather than
> placeholders.
> **§1 GitHub, §3 Render, §5 cron-job.org — not done**, no credential available.
> **§4 Vercel** — connector authenticated, but the frontend needs a live Render URL first.

---

## 0 · Your generated cron secret

Already generated and written to `secrets/CREDENTIALS.md` (gitignored). You need the same
value in two places: Render's environment, and the cron-job.org request header.

```bash
grep CRON_SECRET secrets/CREDENTIALS.md
```

To generate a different one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 1 · GitHub — push the repository

### Already decided, reversible either way

Two files were removed from the repository and left on disk:

- **`Software_Engineer_Intern_Assignment.pdf`** — INE's own document. Not ours to republish.
- **`BUILD_SPEC.md`** — the build spec this was written against. AI use is disclosed properly and
  in detail in `DESIGN_NOTE.md` §3 and `AI_ERRORS.md`, both of which are graded deliverables,
  so this file adds nothing the brief asks for.

To put either back:

```bash
# remove its line from .gitignore first, then
git add -f BUILD_SPEC.md && git commit -m "chore: include the build spec"
```

The branch has also been renamed `master` → `main`.

### Push

The history is clean: no secrets tracked, `.env.example` committed, `secrets/` and `.env`
gitignored. Verify before pushing:

```bash
git ls-files | grep -E '(^|/)(\.env$|secrets/)' && echo "STOP — a secret is tracked" || echo "clean"
```

Then, with a **public** repository created on GitHub:

```bash
git remote add origin https://github.com/<you>/ine-price-tracker.git
git branch -M main
git push -u origin main
```

CI (`.github/workflows/ci.yml`) runs on that push: typecheck, lint, 103 tests, build. It needs
no secrets — the tests run entirely offline.

---

## 2 · Supabase — DONE

The project already exists and the schema is applied and verified:

| | |
|---|---|
| Project | `ine-price-tracker` |
| Ref | `mpxqbtqwmtgakzintwev` |
| URL | `https://mpxqbtqwmtgakzintwev.supabase.co` |
| Region | ap-southeast-1 (Singapore — colocated with the Render region in `render.yaml`) |
| Plan | Free, $0/month |
| Dashboard | https://supabase.com/dashboard/project/mpxqbtqwmtgakzintwev |

Verified against the live database, not assumed: 8 tables, the `tracked_overview` view, 3
functions, RLS enabled on every table, 0 policies, `pg_trgm` in the `extensions` schema. The
constraints, the cascades and the overlap lock were each exercised and cleaned up. The
security advisor reports only the intentional `rls_enabled_no_policy` notice — which is the
design: no policies means the publishable key can read and write nothing.

> The advisor also caught a genuine hole on the first pass: `tracked_overview` was created
> SECURITY DEFINER, so it bypassed RLS on all four tables it joins while `anon` held SELECT on
> it. Fixed, and written up in `AI_ERRORS.md` §8. `db/schema.sql` now produces the hardened
> state from scratch, and `backend/tests/schema.test.ts` asserts it.

The `service_role` key is in `backend/.env` (gitignored) along with the URL and the cron
secret, and the full pipeline has been run against it — see §6.

**Rotate that key before or shortly after submitting.** It bypasses RLS entirely and it was
pasted into a chat to get it here, so treat it as exposed:
https://supabase.com/dashboard/project/mpxqbtqwmtgakzintwev/settings/api-keys → roll
`service_role`, then update `backend/.env` and Render's environment. Nothing else needs to
change. It is server-only — never in a browser, never committed.

### Applying the schema elsewhere

If you ever need to rebuild it, either paste `db/schema.sql` into the SQL editor or:

Generate a personal access token at
[supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) and:

```bash
SUPABASE_ACCESS_TOKEN=sbp_xxx npm run db:apply -w backend -- --print-env
```

That applies `db/schema.sql`, **verifies** the result — eight tables, the `tracked_overview`
view, all three functions, and RLS on every table — and prints the two environment variables
you need for §3. If the account has more than one project it stops and lists them rather than
guessing.

The token is read from the environment, used, and never written anywhere.

Both routes are idempotent, so re-running is safe.

---

## 3 · Render — deploy the backend

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
2. Connect the repository. Render reads [`render.yaml`](render.yaml) and proposes
   **ine-price-tracker-api**.
3. It prompts for the variables marked `sync: false`. Fill in:

   | Key | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL from §2 |
   | `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key from §2 |
   | `CRON_SECRET` | the value from §0 |
   | `CORS_ORIGINS` | `*` for now — tightened in §4 |
   | `SENDGRID_API_KEY` / `ALERT_TO_EMAIL` / `ALERT_FROM_EMAIL` | leave blank unless you want email alerts |

4. **Apply**. First build takes ~4 minutes.
5. Copy the service URL, e.g. `https://ine-price-tracker-api.onrender.com`.

**Verify it is alive** (substitute your URL):

```bash
curl -s https://<render-url>/api/health | jq
```

Expected — note `database` must say `reachable`:

```json
{
  "ok": true,
  "version": "1.0.0",
  "database": "reachable",
  "store": "https://demo.inelabteamdev.com",
  "lastRunAt": null
}
```

If it says `unreachable`, the Supabase values are wrong. If it says `not configured`, they
were not saved. Both are visible in the Render log line printed at boot.

### Seed the catalogue index — already done

All 1,000 products are indexed and search is verified against them (`slimbook` returns 12
ranked hits). Nothing to do. To rebuild or refresh it later:

```bash
npm run seed:catalog -w backend
```

About two minutes, paced at the measured-safe request rate, and idempotent. The store has no
search endpoint and `/api/catalog` returns a random sample on every call, which is why this
index has to exist at all — STORE_NOTES.md §3.

---

## 4 · Vercel — deploy the frontend

1. [vercel.com/new](https://vercel.com/new) → import the repository.
2. Vercel reads [`vercel.json`](vercel.json): build `npm run build -w frontend`, output
   `frontend/dist`, SPA rewrite. Leave the detected settings alone.
3. **Environment Variables** → add:

   | Key | Value |
   |---|---|
   | `VITE_API_BASE_URL` | your Render URL, **no trailing slash** |

4. **Deploy**. ~90 seconds.
5. Copy the production URL, e.g. `https://ine-price-tracker.vercel.app`.

**Then tighten CORS.** Back in Render → **Environment** → set:

```
CORS_ORIGINS=https://<your-app>.vercel.app
```

Save; Render redeploys. Preview deployments on `*.vercel.app` are also allowed once one
`.vercel.app` origin is present, so branch previews keep working.

### Non-interactive alternative

If you would rather use tokens:

```bash
npm i -g vercel
vercel link --yes --token "$VERCEL_TOKEN"
vercel env add VITE_API_BASE_URL production --token "$VERCEL_TOKEN"   # paste the Render URL
vercel --prod --yes --token "$VERCEL_TOKEN"
```

Render's equivalent, given a `RENDER_API_KEY` and an existing service:

```bash
curl -s -X POST "https://api.render.com/v1/services/<service-id>/deploys" \
  -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{}'
```

---

## 5 · cron-job.org — the schedule

Two jobs. The first is the scrape; the second keeps Render awake so the first does not spend
a fifth of its budget on a cold start.

### Job 1 — scrape, every 2 hours

| Field | Value |
|---|---|
| Title | `INE tracker — scrape` |
| URL | `https://<render-url>/api/cron/scrape` |
| Schedule | **Custom** → `0 */2 * * *` |
| Request method | `POST` (under **Advanced**) |
| Header | `x-cron-secret` : `<your CRON_SECRET>` |
| Timeout | 30 s |
| Notify on failure | on |

### Job 2 — keepalive, every 10 minutes

| Field | Value |
|---|---|
| Title | `INE tracker — keepalive` |
| URL | `https://<render-url>/api/cron/keepalive` |
| Schedule | every 10 minutes (`*/10 * * * *`) |
| Request method | `GET` |
| Timeout | 10 s |

Use **Test run** on job 1. A healthy response is `202` with
`{"accepted":true,…}` — the endpoint races for the overlap lock, acknowledges, and finishes
the run in the background, because cron-job.org gives up after 30 seconds and a run with
retries can take longer.

---

## 6 · Verification — run these and paste the output below

All five are executions, not configuration reviews. Substitute your URLs and secret.

These were all executed on 2026-09-20 against the live Supabase project, with the backend
running locally. Re-run them against the Render URL once §3 is done; the outputs should
match in shape.

### 6.1 Health

```bash
curl -s http://localhost:8080/api/health
```

```json
{"ok":true,"version":"1.0.0","env":"development","uptimeSeconds":3,
 "database":"reachable","store":"https://demo.inelabteamdev.com","lastRunAt":null}
```

Boot line, which names anything missing rather than crash-looping:

```
INFO backend listening  port=8080 store=https://demo.inelabteamdev.com
     database=configured cronSecret=set browserFallback=disabled
```

### 6.2 A real cron-triggered scrape writes log rows

Track at least one product first (open the Vercel URL, press ⌘K, search, Enter). Then:

```bash
curl -s -X POST "https://<render-url>/api/cron/scrape?wait=1&force=1" \
  -H "x-cron-secret: <CRON_SECRET>" | jq
```

`?wait=1` forces the synchronous form so you can see the summary.

```
runId    : 0eeb8067-f1cb-42c4-88de-fc6f522eb8c1
attempted: 3 | succeeded: 3 | failed: 0 | ms: 19415

product                        outcome   att strategy      price stock
Helix Turntable Lite           success   2   api            1618 out_of_stock
Basecamp Sleep Tracker Two     success   1   api            7349 in_stock
Nordkraft Slimbook Pro         success   3   api          119783 out_of_stock
```

Three succeeded, on attempts 1, 2 and 3 — the retries are real, not simulated. The scrape log
for one product, straight out of the UI:

```
Time               #   Outcome   Strategy   Took   HTTP   Detail
20 Sept 19:38:08   3   Success   JSON API   2.2s   200    ₹1,19,783
20 Sept 19:38:03   2   Retried   JSON API   1.9s   200    STALE_QUOTE
20 Sept 19:37:56   1   Retried   —          6.8s   503    HTTP_5XX
20 Sept 19:37:37   3   Success   JSON API   1.8s   200    ₹1,19,783
20 Sept 19:37:31   2   Retried   —          3.9s   500    HTTP_5XX
20 Sept 19:37:22   1   Retried   —          8.3s   500    HTTP_5XX
20 Sept 19:36:46   2   Success   JSON API   2.0s   200    ₹1,19,783
20 Sept 19:36:40   1   Retried   —          4.3s   500    HTTP_5XX
```

Eight attempts, three stored readings, five honest non-success rows. The row at 19:38:03 is
the one worth reading twice: **HTTP 200**, a completely successful response, carrying a price
the validation layer refused because the store had flagged it `pending`. A status-code-only
retry policy stores that number.

### 6.3 Two concurrent runs — the second must be refused

```bash
curl -s -o /tmp/a.json -w "first  %{http_code}\n" -X POST \
  "https://<render-url>/api/cron/scrape?wait=1&force=1" -H "x-cron-secret: <CRON_SECRET>" &
curl -s -o /tmp/b.json -w "second %{http_code}\n" -X POST \
  "https://<render-url>/api/cron/scrape?wait=1&force=1" -H "x-cron-secret: <CRON_SECRET>" &
wait
cat /tmp/a.json /tmp/b.json
```

```
call A: HTTP 409     -> {"skipped":"run in progress"}
call B: HTTP 200     -> ran: attempted 3, succeeded 3
```

The lock also refused three runs during normal use — each `POST /api/tracked` fires an
immediate scrape, and tracking three products in quick succession produced one run and two
refusals, every one of them recorded rather than silent:

```
14:06:46 | manual | attempted 0 | succeeded 0 | skipped: another run was already in progress
14:06:44 | manual | attempted 0 | succeeded 0 | skipped: another run was already in progress
14:06:43 | manual | attempted 1 | succeeded 1 |
```

Integrity after all of it:

```
duplicate history rows for one instant      0
history rows total                          7
scrape_logs rows total                     13
  of which NOT success                      6
rows todays validation would reject         0     <- the definition of done
history rows with no originating log row    0
cron runs recorded                          6
  of which skipped by the lock              3
```

### 6.4 End to end in the browser

Open the Vercel URL and:

1. Press **⌘K** (or **Ctrl-K**), type a partial name — `slimbook`, `nord`, `sleep tracker` —
   and press Enter on a result.
2. You land on its detail page and the first scrape is already running.
3. Press **Scrape now**. Within a few seconds a new point appears on the strip chart and new
   rows appear in the scrape log below it.
4. Check the log shows the strategy (`JSON API`), the duration and the HTTP status.

Confirmed working against the live backend: search returns real indexed results
(`slimbook` -> 12 hits from the 1,000-row index), tracking fires an immediate scrape, the
strip chart draws the stored readings with attempt ticks on its baseline, and the scrape log
shows the `retried` rows without hiding them.

### 6.5 A deliberately broken product writes a log row and no history

This proves the central claim: a failure is recorded, and history is not touched.

```bash
# Track a product, then make it point at an id that does not exist.
# Supabase → SQL Editor:
```

```sql
-- point one tracked product at a product the store does not have
update products set store_product_id = '999999'
where store_product_id = (select store_product_id from products
                          where id = (select product_id from tracked_products limit 1));
```

```bash
curl -s -X POST "https://<render-url>/api/cron/scrape?wait=1&force=1" \
  -H "x-cron-secret: <CRON_SECRET>" | jq '.products'
```

Result, run against the live store with a tracker pointed at id `999999`:

```
outcome  : failed
attempts : 1            <- a 404 is NOT retried; the answer will not change
errorCode: PRODUCT_GONE
message  : HTTP 404 from /api/product/999999: {"error":"not_found"}
```

```
log row written for the failure     1
history rows written                0     <- the whole point
tracking auto-paused                true
alert raised                        product_gone
other products history untouched    7
```

The original verification steps follow, for re-running against Render:

```sql
select outcome, error_code, attempt_number, started_at
from scrape_logs order by started_at desc limit 5;

select count(*) as history_rows_since
from price_history where scraped_at > now() - interval '5 minutes';
```

Expect a `failed / PRODUCT_GONE` log row, and **zero** new history rows. An alert will also
have been raised and tracking paused.

```
(paste)
```

Put the id back afterwards:

```sql
update products set store_product_id = '<the original id>' where store_product_id = '999999';
update tracked_products set is_active = true, consecutive_failures = 0;
```

---

## 7 · What was verified locally, without credentials

Run these yourself to reproduce; they need no accounts.

```bash
npm ci
npm test                    # 103 tests
npm run build
```

```
 Test Files  5 passed (5)
      Tests  103 passed (103)
```

The suite is offline: extraction runs against real store responses captured into
`recon/fixtures/`, and `db/schema.sql` is executed against Postgres compiled to WebAssembly,
which is how the constraints, the cascades, the overlap lock and the search ranking are
verified without a Supabase project.

The built backend was booted and exercised:

```
$ CRON_SECRET=… PORT=8081 node backend/dist/index.js
INFO backend listening port=8081 store=https://demo.inelabteamdev.com
     database=NOT CONFIGURED — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
     cronSecret=set browserFallback=disabled

$ curl -s localhost:8081/api/health
{"ok":true,"version":"1.0.0","database":"not configured",…}

$ curl -o /dev/null -w "%{http_code}" -X POST localhost:8081/api/cron/scrape
401
$ curl -o /dev/null -w "%{http_code}" -X POST -H "x-cron-secret: wrong" localhost:8081/api/cron/scrape
401

$ curl -s localhost:8081/api/tracked
{"error":"database_not_configured","message":"Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"}   HTTP 503

$ curl -s "localhost:8081/api/store/search?q=slimbook"
{"query":"slimbook","source":"live-sample","indexed":0,
 "results":[{"storeProductId":"895","name":"Copperpot Slimbook Studio",…}]}
```

The scraper was run end to end against the live store, both ways:

```
$ npx tsx backend/scripts/smoke.ts 15
INFO api: reading  ms=3261 price=129249 currency=INR stock=in_stock qty=151
                   pending=false valid=true fingerprint=api:4bda8a4cbee3e961
WARN embedded_json: missed  code=PARSE_MISS  No embedded JSON in the served HTML (459 bytes)
WARN dom: missed            code=PARSE_MISS  No price block in the served HTML (459 bytes;
                                             the store renders on the client)

$ npm run scrape:headed -w backend -- --product=15 --no-db --headless
  figure read from the page   price=129249 stock=Only 151 left shape=plain
  SUCCESS  after 1 attempt in 3.3s
```

Same number, read two completely independent ways. And the failure path:

```
$ npm run scrape:headed -w backend -- --product=15 --no-db --headless --simulate=error
  ⚡ simulated fault  forced HTTP 503 upstream_error (1/6 … 6/6)
  attempt failed — backing off   attempt=1 code=PARSE_MISS waitMs=953
  attempt started                attempt=2 of=4
  fault window over — the real store answers this one
  SUCCESS  after 2 attempts in 25.4s
```

The UI was driven in a real browser at 360, 414, 768, 1024 and 1440 px: no horizontal
overflow at any width, no unlabelled controls, every hit target at least 24 px.

---

## 8 · Fill these in when you are done

| | |
|---|---|
| Live app | `https://…vercel.app` |
| API | `https://…onrender.com` |
| Repository | `https://github.com/…` |
| Recording | `https://…` |
| First cron run at | |
| Second cron run at | |

The definition of done in `BUILD_SPEC.md` §11: two real cron-triggered runs in production, at
least one genuine non-success row in the scrape log that the UI displays without hiding it,
and no row in `price_history` that today's validation layer would reject. §6.2 and §6.5
above produce the evidence for all three.

---

## Troubleshooting

**`/api/health` says `database: unreachable`.** The Supabase URL or key is wrong. The Render
boot log prints exactly which variable is missing.

**The dashboard shows "Could not reach the API".** Either `VITE_API_BASE_URL` has a trailing
slash, or `CORS_ORIGINS` does not include the Vercel origin — the Render log prints
`CORS rejected an origin` with both values when that happens.

**The first request after a quiet hour takes ~50 seconds.** Render's free tier sleeping. The
keepalive job is what prevents it; check job 2 is enabled and succeeding.

**Search returns nothing.** The catalogue index is empty — run the seeder (§3). Until it has
run, search falls back to sampling the live store and says so in the response.

**A scrape fails with `HTTP_429`.** The store rate-limited us. It is retryable and the engine
backs off. If it is persistent, raise `STORE_MIN_REQUEST_GAP_MS` above 700.

**Every scrape fails with `GATE_REJECTED`.** The store changed its price handshake. The
constraints it enforces are documented in STORE_NOTES.md §6, measured one variable at a time;
re-run `recon/tools/probe-att2.mjs` to find what moved.
