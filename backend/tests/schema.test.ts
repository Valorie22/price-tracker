/**
 * `db/schema.sql` is run by hand, once, in the Supabase SQL editor. That makes it the one
 * file in this project with no compiler and no linter in front of it — a stray comma ships
 * as a broken deployment and you find out from a 500 at 2 a.m.
 *
 * So it gets run for real here, against Postgres compiled to WebAssembly (pglite). No
 * Docker, no credentials, a couple of seconds. This exercises the actual statements: the
 * extensions, the constraints, the foreign keys, the view, and both lock functions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.resolve(here, '../../db/schema.sql'), 'utf8');

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(SCHEMA);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  ((await db.query(sql, params)).rows[0] ?? {}) as T;

describe('db/schema.sql', () => {
  it('applies cleanly to an empty database', async () => {
    const { count } = await one<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    expect(Number(count)).toBeGreaterThanOrEqual(8);
  });

  it('is idempotent — re-running it changes nothing and throws nothing', async () => {
    await expect(db.exec(SCHEMA)).resolves.toBeDefined();
  });

  it('has row level security on every table', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    const withoutRls = res.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(withoutRls).toEqual([]);
  });

  it('has no policies, so the anon key can read and write nothing', async () => {
    const res = await db.query(`select policyname from pg_policies where schemaname = 'public'`);
    expect(res.rows).toEqual([]);
  });

  it('installs pg_trgm outside the public schema', async () => {
    const { schema } = await one<{ schema: string }>(
      `select n.nspname as schema from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm'`,
    );
    expect(schema).toBe('extensions');
  });
});

/**
 * The Supabase security advisor caught both of these on the live project after the
 * schema was first applied. A view without `security_invoker` runs with its owner's
 * rights and bypasses RLS on every table it touches — which made the entire tracked
 * catalogue, price history and scrape log readable with the public anon key, through
 * the one object that joins all of them. See AI_ERRORS.md §8.
 */
describe('hardening — the checks that RLS actually depends on', () => {
  it('tracked_overview runs as the caller, so RLS applies to it', async () => {
    const { opts } = await one<{ opts: string | null }>(
      `select array_to_string(c.reloptions, ',') as opts from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'tracked_overview'`,
    );
    expect(opts ?? '').toContain('security_invoker=on');
  });

  it('pins search_path on every function', async () => {
    const res = await db.query<{ proname: string; proconfig: string[] | null }>(
      `select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('search_products','try_acquire_cron_lock','release_cron_lock')`,
    );
    expect(res.rows).toHaveLength(3);
    for (const row of res.rows) {
      expect(row.proconfig, `${row.proname} has no pinned search_path`).not.toBeNull();
      expect(String(row.proconfig)).toContain('search_path');
    }
  });

  it('does not leave EXECUTE granted to PUBLIC on any function', async () => {
    const res = await db.query<{ proname: string; acl: string | null }>(
      `select p.proname, p.proacl::text as acl from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('search_products','try_acquire_cron_lock','release_cron_lock')`,
    );
    expect(res.rows).toHaveLength(3);

    for (const row of res.rows) {
      // A NULL acl is not "no grants" — it is *default* privileges, which for a
      // function means EXECUTE to PUBLIC. Asserting only "no PUBLIC entry in the
      // string" would pass vacuously on exactly the case we care about.
      expect(row.acl, `${row.proname} has default privileges, i.e. EXECUTE to PUBLIC`).not.toBeNull();
      // A bare "=" entry is the PUBLIC grant, e.g. {=X/postgres,...}
      expect(row.acl ?? '', `${row.proname} still grants EXECUTE to PUBLIC`).not.toMatch(/[{,]=/);
    }
  });
});

describe('price_history constraints — the last line of defence', () => {
  let trackedId: string;

  beforeAll(async () => {
    const p = await one<{ id: string }>(
      `insert into products (store_product_id, name, url) values ('15','Nordkraft Slimbook Pro','https://demo.inelabteamdev.com/product/15') returning id`,
    );
    const t = await one<{ id: string }>(`insert into tracked_products (product_id) values ($1) returning id`, [p.id]);
    trackedId = t.id;
  });

  it('accepts a sane reading', async () => {
    const row = await one<{ id: string; currency: string }>(
      `insert into price_history (tracked_product_id, price, stock_status, stock_quantity)
       values ($1, 129249, 'in_stock', 151) returning id, currency`,
      [trackedId],
    );
    expect(row.id).toBeTruthy();
    expect(row.currency).toBe('INR'); // not USD — the store quotes rupees
  });

  it('refuses a zero or negative price at the database level', async () => {
    for (const price of [0, -5]) {
      await expect(
        db.query(`insert into price_history (tracked_product_id, price, stock_status) values ($1, $2, 'in_stock')`, [
          trackedId,
          price,
        ]),
      ).rejects.toThrow(/price_history_price_sane/);
    }
  });

  it('refuses an absurd price at the database level', async () => {
    await expect(
      db.query(`insert into price_history (tracked_product_id, price, stock_status) values ($1, 9999999, 'in_stock')`, [
        trackedId,
      ]),
    ).rejects.toThrow(/price_history_price_sane/);
  });

  it('refuses a stock status outside the enum', async () => {
    await expect(
      db.query(`insert into price_history (tracked_product_id, price, stock_status) values ($1, 100, 'probably')`, [
        trackedId,
      ]),
    ).rejects.toThrow(/price_history_stock_enum/);
  });

  it('refuses a scrape_logs outcome outside the enum', async () => {
    await expect(
      db.query(
        `insert into scrape_logs (run_id, attempt_number, outcome, duration_ms, started_at)
         values (gen_random_uuid(), 1, 'sort of', 10, now())`,
      ),
    ).rejects.toThrow(/scrape_logs_outcome_enum/);
  });

  it('accepts all four real outcomes', async () => {
    for (const outcome of ['success', 'retried', 'failed', 'skipped']) {
      await expect(
        db.query(
          `insert into scrape_logs (tracked_product_id, run_id, attempt_number, outcome, duration_ms, started_at)
           values ($1, gen_random_uuid(), 1, $2, 10, now())`,
          [trackedId, outcome],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('cascades history and logs away when a tracked product is deleted', async () => {
    await db.query(`delete from tracked_products where id = $1`, [trackedId]);
    const h = await one<{ count: string }>(`select count(*)::text as count from price_history where tracked_product_id = $1`, [trackedId]);
    const l = await one<{ count: string }>(`select count(*)::text as count from scrape_logs where tracked_product_id = $1`, [trackedId]);
    expect(Number(h.count)).toBe(0);
    expect(Number(l.count)).toBe(0);
  });
});

describe('the overlap lock', () => {
  it('lets the first run in and keeps the second out', async () => {
    const a = await one<{ ok: boolean }>(`select try_acquire_cron_lock(gen_random_uuid(), 600) as ok`);
    expect(a.ok).toBe(true);
    const b = await one<{ ok: boolean }>(`select try_acquire_cron_lock(gen_random_uuid(), 600) as ok`);
    expect(b.ok).toBe(false);
  });

  it('lets the next run take a stale lock, so a crash cannot wedge the scheduler', async () => {
    await db.query(`update cron_locks set acquired_at = now() - interval '11 minutes' where name = 'scrape'`);
    const c = await one<{ ok: boolean }>(`select try_acquire_cron_lock(gen_random_uuid(), 600) as ok`);
    expect(c.ok).toBe(true);
  });

  it('releases cleanly and lets the next run straight in', async () => {
    const res = await db.query<{ run_id: string }>(`select run_id from cron_locks where name = 'scrape'`);
    const holder = res.rows[0]?.run_id as string;
    await db.query(`select release_cron_lock($1)`, [holder]);
    const next = await one<{ ok: boolean }>(`select try_acquire_cron_lock(gen_random_uuid(), 600) as ok`);
    expect(next.ok).toBe(true);
  });
});

describe('search_products', () => {
  beforeAll(async () => {
    await db.query(`insert into products (store_product_id, name, brand, category, sku, slug, url) values
      ('15','Nordkraft Slimbook Pro','Nordkraft','Laptops','NOR-10015','nordkraft-slimbook-pro','https://x/15'),
      ('502','Basecamp Sleep Tracker Two','Basecamp','Wearables','BAS-10502','basecamp-sleep-tracker-two','https://x/502'),
      ('326','Helix Turntable Lite','Helix','Audio','HEL-10326','helix-turntable-lite','https://x/326')
      on conflict (store_product_id) do nothing`);
  });

  it('matches a partial name from the middle of the string', async () => {
    const res = await db.query<{ name: string }>(`select name from search_products('slimbook', 10)`);
    expect(res.rows.map((r) => r.name)).toContain('Nordkraft Slimbook Pro');
  });

  it('matches a brand', async () => {
    const res = await db.query<{ name: string }>(`select name from search_products('basecamp', 10)`);
    expect(res.rows.map((r) => r.name)).toContain('Basecamp Sleep Tracker Two');
  });

  it('matches a SKU', async () => {
    const res = await db.query<{ name: string }>(`select name from search_products('HEL-10326', 10)`);
    expect(res.rows.map((r) => r.name)).toContain('Helix Turntable Lite');
  });

  it('ranks a prefix match above a mere brand match', async () => {
    const res = await db.query<{ name: string; score: number }>(`select name, score from search_products('helix', 10)`);
    expect(res.rows[0]?.name).toBe('Helix Turntable Lite');
  });

  it('is case-insensitive and tolerates a near miss', async () => {
    const res = await db.query<{ name: string }>(`select name from search_products('TURNTABLE', 10)`);
    expect(res.rows.map((r) => r.name)).toContain('Helix Turntable Lite');
  });

  it('returns nothing rather than guessing for an unrelated query', async () => {
    const res = await db.query(`select name from search_products('xylophone', 10)`);
    expect(res.rows).toEqual([]);
  });
});

describe('tracked_overview — what the dashboard reads', () => {
  it('reports a tracked product with no readings without dropping it', async () => {
    const p = await one<{ id: string }>(
      `insert into products (store_product_id, name, url) values ('777','Fresh Product','https://x/777') returning id`,
    );
    await db.query(`insert into tracked_products (product_id) values ($1)`, [p.id]);

    const row = await one<{ name: string; latest_price: number | null; history_points: string }>(
      `select name, latest_price, history_points::text from tracked_overview where store_product_id = '777'`,
    );
    expect(row.name).toBe('Fresh Product');
    expect(row.latest_price).toBeNull();
    expect(Number(row.history_points)).toBe(0);
  });

  it('surfaces the latest reading and the last attempt outcome together', async () => {
    const p = await one<{ id: string }>(
      `insert into products (store_product_id, name, url) values ('888','Watched Product','https://x/888') returning id`,
    );
    const t = await one<{ id: string }>(`insert into tracked_products (product_id) values ($1) returning id`, [p.id]);

    await db.query(
      `insert into price_history (tracked_product_id, price, stock_status, scraped_at) values
       ($1, 100000, 'in_stock', now() - interval '8 days'),
       ($1, 120000, 'in_stock', now() - interval '25 hours'),
       ($1, 129249, 'low_stock', now())`,
      [t.id],
    );
    await db.query(
      `insert into scrape_logs (tracked_product_id, run_id, attempt_number, outcome, strategy, duration_ms, started_at)
       values ($1, gen_random_uuid(), 2, 'success', 'api', 640, now())`,
      [t.id],
    );

    const row = await one<{
      latest_price: number; latest_stock_status: string; price_24h_ago: number;
      price_7d_ago: number; last_outcome: string; last_strategy: string; history_points: string;
    }>(`select * from tracked_overview where store_product_id = '888'`);

    expect(Number(row.latest_price)).toBe(129249);
    expect(row.latest_stock_status).toBe('low_stock');
    expect(Number(row.price_24h_ago)).toBe(120000);
    expect(Number(row.price_7d_ago)).toBe(100000);
    expect(row.last_outcome).toBe('success');
    expect(row.last_strategy).toBe('api');
    expect(Number(row.history_points)).toBe(3);
  });
});
