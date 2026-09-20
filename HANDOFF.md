# HANDOFF

Everything that does not need a credential is built, tested and committed. What is left
needs accounts only you can sign into. This file is the exact sequence — commands to paste,
values to copy, and the verification evidence to capture at the end.

**Time: about 25 minutes**, most of it waiting for Render's first build.

> **Status:** no Supabase, Vercel, Render or GitHub credential was present in
> `secrets/CREDENTIALS.md` or the environment during the build, so no deployment was
> performed. Everything below has been rehearsed against the built artefact where that was
> possible without an account — the boot sequence, the health endpoint, the cron rejection
> path and the search fallback were all executed locally against `backend/dist/index.js`
> (evidence in §7).

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

### One decision to make first

`BUILD_SPEC.md` is the build spec this project was written against, and it is currently committed.
Keeping it is the transparent choice and it is consistent with the brief, which explicitly
asks the design note to cover what your AI tools got wrong — `DESIGN_NOTE.md` §3 and
`AI_ERRORS.md` already disclose that in detail.

If you would rather it not appear in the submitted repository:

```bash
git rm --cached BUILD_SPEC.md && echo "BUILD_SPEC.md" >> .gitignore
git commit -m "chore: keep the build spec out of the public repository"
```

Nothing references it except this paragraph, so removing it breaks nothing. Your call — but
make it before you push, not after.

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

CI (`.github/workflows/ci.yml`) runs on that push: typecheck, lint, 98 tests, build. It needs
no secrets — the tests run entirely offline.

---

## 2 · Supabase — create the database

1. [supabase.com](https://supabase.com) → **New project**. Region **ap-south-1 (Mumbai)** if
   offered; it is closest to both the store and the Render region in `render.yaml`.
2. Wait for provisioning (~2 min).
3. **SQL Editor → New query** → paste the whole of `db/schema.sql` → **Run**.
   It is idempotent, so re-running is safe. Expect `Success. No rows returned`.
4. **Project Settings → Data API** → copy the **Project URL**.
5. **Project Settings → API Keys** → reveal and copy the **`service_role`** key.
   This key bypasses RLS. It belongs on the server and nowhere else.

Confirm the schema landed:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
```

Expect: `alerts`, `cron_locks`, `cron_runs`, `price_history`, `products`, `scrape_logs`,
`structure_fingerprints`, `tracked_products`, and the `tracked_overview` view.

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

### Seed the catalogue index

The store has no search endpoint and `/api/catalog` returns a random sample on every call, so
partial-name search only works against a copy we hold (STORE_NOTES.md §3). Run this once,
from your machine, against the live Supabase:

```bash
cp .env.example backend/.env       # then paste the Supabase values into it
npm ci
npm run seed:catalog -w backend
```

Takes about two minutes for all 1,000 products, paced at the measured-safe request rate. It
prints its coverage at the end:

```
INFO  done  indexed=1000 distinctIds=1000 storeTotal=1000 coverage=100.0% draws=137
```

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

### 6.1 Health

```bash
curl -s https://<render-url>/api/health
```

Paste the output here:

```
(paste)
```

### 6.2 A real cron-triggered scrape writes log rows

Track at least one product first (open the Vercel URL, press ⌘K, search, Enter). Then:

```bash
curl -s -X POST "https://<render-url>/api/cron/scrape?wait=1&force=1" \
  -H "x-cron-secret: <CRON_SECRET>" | jq
```

`?wait=1` forces the synchronous form so you can see the summary. Expect a per-product
result with `outcome`, `attempts`, `strategy` and `price`:

```
(paste)
```

Confirm the rows landed — Supabase → SQL Editor:

```sql
select outcome, count(*), max(started_at) as latest
from scrape_logs group by outcome order by 2 desc;
```

```
(paste)
```

### 6.3 Two concurrent runs — the second must be refused

```bash
curl -s -o /tmp/a.json -w "first  %{http_code}\n" -X POST \
  "https://<render-url>/api/cron/scrape?wait=1&force=1" -H "x-cron-secret: <CRON_SECRET>" &
curl -s -o /tmp/b.json -w "second %{http_code}\n" -X POST \
  "https://<render-url>/api/cron/scrape?wait=1&force=1" -H "x-cron-secret: <CRON_SECRET>" &
wait
cat /tmp/a.json /tmp/b.json
```

Expect one `200` and one `409 {"skipped":"run in progress"}`. Then confirm nothing was
written twice:

```sql
select tracked_product_id, scraped_at, count(*)
from price_history group by 1, 2 having count(*) > 1;
```

Expect **zero rows**.

```
(paste)
```

### 6.4 End to end in the browser

Open the Vercel URL and:

1. Press **⌘K** (or **Ctrl-K**), type a partial name — `slimbook`, `nord`, `sleep tracker` —
   and press Enter on a result.
2. You land on its detail page and the first scrape is already running.
3. Press **Scrape now**. Within a few seconds a new point appears on the strip chart and new
   rows appear in the scrape log below it.
4. Check the log shows the strategy (`JSON API`), the duration and the HTTP status.

Note what you saw:

```
(paste)
```

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

Expect `outcome: "failed"`, `errorCode: "PRODUCT_GONE"`, `attempts: 1` — a 404 is not
retried, because the answer will not change. Then:

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
npm test                    # 98 tests
npm run build
```

```
 Test Files  5 passed (5)
      Tests  98 passed (98)
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
