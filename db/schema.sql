-- ============================================================================
-- INE Price Tracker - Supabase / Postgres schema
-- Run once in the Supabase SQL editor (Project -> SQL Editor -> New query -> Run).
-- Safe to re-run: every statement is idempotent.
-- ============================================================================

-- gen_random_uuid() has been core Postgres since 13, so pgcrypto is not needed.
-- pg_trgm powers the similarity ranking in search_products (see the bottom of this file);
-- it ships with Supabase and only needs enabling.
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------------------------
-- products - catalogue snapshot ingested from the store.
-- The store has no search endpoint and /api/catalog returns a fresh random
-- sample on every call, so the only way to offer "search by partial name" is
-- to hold our own copy of the catalogue. This table is that copy.
-- ---------------------------------------------------------------------------
create table if not exists products (
  id                uuid primary key default gen_random_uuid(),
  store_product_id  text unique not null,          -- the store's numeric id, as text
  name              text not null,
  url               text not null,
  image_url         text,
  category          text,
  brand             text,
  sku               text,
  slug              text,
  description       text,
  specs             jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create index if not exists products_name_trgm_idx on products using gin (lower(name) gin_trgm_ops);
create index if not exists products_category_idx  on products (category);

-- ---------------------------------------------------------------------------
-- tracked_products - what the user asked us to watch.
-- ---------------------------------------------------------------------------
create table if not exists tracked_products (
  id                      uuid primary key default gen_random_uuid(),
  product_id              uuid not null references products(id) on delete cascade,
  is_active               boolean not null default true,
  scrape_interval_minutes int not null default 120,
  alert_price_below       numeric(12,2),
  alert_on_restock        boolean not null default false,
  created_at              timestamptz not null default now(),
  last_scraped_at         timestamptz,
  last_success_at         timestamptz,
  consecutive_failures    int not null default 0,
  unique (product_id)
);

create index if not exists tracked_active_idx on tracked_products (is_active, last_scraped_at);

-- ---------------------------------------------------------------------------
-- price_history - written ONLY on a verified, validated, successful scrape.
-- A gap here is correct. A wrong row here is a failed assignment.
-- ---------------------------------------------------------------------------
create table if not exists price_history (
  id                 bigserial primary key,
  tracked_product_id uuid not null references tracked_products(id) on delete cascade,
  price              numeric(12,2) not null,
  currency           text not null default 'INR',
  mrp                numeric(12,2),
  stock_status       text not null,   -- in_stock | low_stock | out_of_stock | unknown
  stock_quantity     int,
  scraped_at         timestamptz not null default now(),
  scrape_log_id      bigint,          -- provenance: which attempt produced this row
  constraint price_history_price_sane check (price > 0 and price < 1000000),
  constraint price_history_stock_enum check (stock_status in ('in_stock','low_stock','out_of_stock','unknown'))
);

create index if not exists price_history_tp_time_idx on price_history (tracked_product_id, scraped_at desc);

-- ---------------------------------------------------------------------------
-- scrape_logs - EVERY attempt, success or not. This is the honesty record.
--   retried  = this attempt failed and another attempt followed
--   failed   = this attempt failed and the retry budget is exhausted
--   success  = data extracted, validated and written
--   skipped  = the cycle never ran (overlap lock, run budget)
-- ---------------------------------------------------------------------------
create table if not exists scrape_logs (
  id                 bigserial primary key,
  tracked_product_id uuid references tracked_products(id) on delete cascade,
  run_id             uuid not null,
  attempt_number     int not null,
  outcome            text not null,
  strategy           text,            -- api | embedded_json | dom | browser
  http_status        int,
  duration_ms        int not null,
  error_code         text,
  error_message      text,
  price_found        numeric(12,2),
  stock_found        text,
  structure_changed  boolean not null default false,
  started_at         timestamptz not null,
  finished_at        timestamptz not null default now(),
  constraint scrape_logs_outcome_enum check (outcome in ('success','retried','failed','skipped'))
);

create index if not exists scrape_logs_tp_time_idx on scrape_logs (tracked_product_id, started_at desc);
create index if not exists scrape_logs_run_idx     on scrape_logs (run_id);
create index if not exists scrape_logs_outcome_idx on scrape_logs (outcome, started_at desc);

-- price_history.scrape_log_id points at the attempt that produced it.
do $fk$
begin
  alter table price_history
    add constraint price_history_log_fk
    foreign key (scrape_log_id) references scrape_logs(id) on delete set null;
exception
  when duplicate_object then null;
end
$fk$;

-- ---------------------------------------------------------------------------
-- structure_fingerprints - what the store's markup/response shape looked like.
-- ---------------------------------------------------------------------------
create table if not exists structure_fingerprints (
  id            bigserial primary key,
  fingerprint   text not null,
  sample_url    text,
  details       jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  occurrences   int not null default 1
);

create index if not exists structure_fp_seen_idx on structure_fingerprints (last_seen_at desc);
create unique index if not exists structure_fp_uniq on structure_fingerprints (fingerprint);

-- ---------------------------------------------------------------------------
-- alerts
-- ---------------------------------------------------------------------------
create table if not exists alerts (
  id                 bigserial primary key,
  tracked_product_id uuid references tracked_products(id) on delete cascade,
  kind               text not null,   -- price_drop | back_in_stock | structure_change | repeated_failure | product_gone
  message            text not null,
  payload            jsonb,
  created_at         timestamptz not null default now(),
  read_at            timestamptz,
  email_sent_at      timestamptz
);

create index if not exists alerts_unread_idx on alerts (read_at, created_at desc);

-- ---------------------------------------------------------------------------
-- cron_runs - overlap protection + run-level visibility.
-- ---------------------------------------------------------------------------
create table if not exists cron_runs (
  run_id             uuid primary key,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  products_attempted int not null default 0,
  products_succeeded int not null default 0,
  trigger_source     text,            -- cron | manual | headed
  notes              text
);

create index if not exists cron_runs_started_idx on cron_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security.
-- The backend uses the service-role key, which bypasses RLS. Enabling RLS with
-- no policies means an anon/public key can read and write nothing. All reads go
-- through the backend so exactly one place owns correctness.
-- ---------------------------------------------------------------------------
alter table products               enable row level security;
alter table tracked_products       enable row level security;
alter table price_history          enable row level security;
alter table scrape_logs            enable row level security;
alter table structure_fingerprints enable row level security;
alter table alerts                 enable row level security;
alter table cron_runs              enable row level security;

-- ---------------------------------------------------------------------------
-- search_products - trigram + prefix search used by GET /api/store/search.
-- Kept in the database so ranking is one query rather than a table scan in Node.
-- ---------------------------------------------------------------------------
create or replace function search_products(q text, lim int default 12)
returns table (
  store_product_id text,
  name text,
  brand text,
  category text,
  sku text,
  slug text,
  url text,
  score real
)
language sql
stable
as $$
  select p.store_product_id, p.name, p.brand, p.category, p.sku, p.slug, p.url,
         greatest(
           similarity(lower(p.name), lower(q)),
           case when lower(p.name)  like lower(q) || '%' then 0.95 else 0 end,
           case when lower(p.name)  like '%' || lower(q) || '%' then 0.85 else 0 end,
           case when lower(p.brand) like '%' || lower(q) || '%' then 0.55 else 0 end,
           case when lower(p.sku)   like '%' || lower(q) || '%' then 0.90 else 0 end
         )::real as score
  from products p
  where lower(p.name)  like '%' || lower(q) || '%'
     or lower(p.brand) like '%' || lower(q) || '%'
     or lower(p.sku)   like '%' || lower(q) || '%'
     or similarity(lower(p.name), lower(q)) > 0.25
  order by score desc, p.name asc
  limit lim;
$$;

-- ---------------------------------------------------------------------------
-- cron_locks - overlap protection.
--
-- Free-tier cron services double-fire, and Render can have two instances alive
-- during a deploy. Two runs scraping the same product at the same time would
-- write two history rows for one moment in time and race each other's
-- consecutive_failures counter.
--
-- A session-level pg_try_advisory_lock is the textbook answer, but it is tied to
-- a connection and the backend reaches Postgres through PostgREST, where every
-- call is its own transaction on a pooled connection. So the lock is a row, and
-- the atomicity comes from INSERT ... ON CONFLICT ... WHERE, which either
-- returns the row (we took it) or returns nothing (somebody else holds it).
-- ---------------------------------------------------------------------------
create table if not exists cron_locks (
  name        text primary key,
  run_id      uuid not null,
  acquired_at timestamptz not null default now()
);

create or replace function try_acquire_cron_lock(p_run_id uuid, p_stale_seconds int default 600)
returns boolean
language plpgsql
as $lock$
declare
  v_holder uuid;
begin
  insert into cron_locks (name, run_id, acquired_at)
  values ('scrape', p_run_id, now())
  on conflict (name) do update
    set run_id = excluded.run_id, acquired_at = now()
    where cron_locks.acquired_at < now() - make_interval(secs => p_stale_seconds)
  returning run_id into v_holder;

  return v_holder is not distinct from p_run_id;
end;
$lock$;

create or replace function release_cron_lock(p_run_id uuid)
returns boolean
language sql
as $rel$
  delete from cron_locks where name = 'scrape' and run_id = p_run_id returning true;
$rel$;

alter table cron_locks enable row level security;

-- ---------------------------------------------------------------------------
-- tracked_overview - one row per tracked product with everything the dashboard
-- needs, computed in the database so the list view is a single round trip
-- instead of N+1 queries against price_history.
-- ---------------------------------------------------------------------------
create or replace view tracked_overview as
with latest as (
  select distinct on (ph.tracked_product_id)
         ph.tracked_product_id, ph.price, ph.currency, ph.stock_status,
         ph.stock_quantity, ph.scraped_at, ph.mrp
  from price_history ph
  order by ph.tracked_product_id, ph.scraped_at desc
),
ago_24h as (
  select distinct on (ph.tracked_product_id) ph.tracked_product_id, ph.price
  from price_history ph
  where ph.scraped_at <= now() - interval '24 hours'
  order by ph.tracked_product_id, ph.scraped_at desc
),
ago_7d as (
  select distinct on (ph.tracked_product_id) ph.tracked_product_id, ph.price
  from price_history ph
  where ph.scraped_at <= now() - interval '7 days'
  order by ph.tracked_product_id, ph.scraped_at desc
),
last_log as (
  select distinct on (sl.tracked_product_id)
         sl.tracked_product_id, sl.outcome, sl.error_code, sl.strategy,
         sl.started_at, sl.duration_ms, sl.structure_changed
  from scrape_logs sl
  where sl.tracked_product_id is not null
  order by sl.tracked_product_id, sl.started_at desc
)
select
  t.id                      as tracked_id,
  t.is_active,
  t.scrape_interval_minutes,
  t.alert_price_below,
  t.alert_on_restock,
  t.created_at,
  t.last_scraped_at,
  t.last_success_at,
  t.consecutive_failures,
  p.store_product_id,
  p.name,
  p.brand,
  p.category,
  p.sku,
  p.slug,
  p.url,
  p.description,
  p.specs,
  l.price          as latest_price,
  l.currency       as latest_currency,
  l.mrp            as latest_mrp,
  l.stock_status   as latest_stock_status,
  l.stock_quantity as latest_stock_quantity,
  l.scraped_at     as latest_scraped_at,
  a24.price        as price_24h_ago,
  a7.price         as price_7d_ago,
  ll.outcome       as last_outcome,
  ll.error_code    as last_error_code,
  ll.strategy      as last_strategy,
  ll.started_at    as last_attempt_at,
  ll.duration_ms   as last_duration_ms,
  ll.structure_changed as last_structure_changed,
  (select count(*) from price_history h where h.tracked_product_id = t.id) as history_points
from tracked_products t
join products p on p.id = t.product_id
left join latest  l   on l.tracked_product_id   = t.id
left join ago_24h a24 on a24.tracked_product_id = t.id
left join ago_7d  a7  on a7.tracked_product_id  = t.id
left join last_log ll on ll.tracked_product_id  = t.id;
