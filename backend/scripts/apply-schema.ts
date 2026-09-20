/**
 * Apply `db/schema.sql` to a Supabase project over the Management API.
 *
 * The SQL editor in the dashboard is the documented route and it works fine, but it is a
 * manual paste — which means it is a step that can be half-done, done against the wrong
 * project, or forgotten on a rebuild. This does the same thing from a personal access
 * token, and then *verifies* the result rather than trusting that the paste took.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_… npm run db:apply -w backend
 *   SUPABASE_ACCESS_TOKEN=sbp_… npm run db:apply -w backend -- --project-ref abcdefgh
 *   SUPABASE_ACCESS_TOKEN=sbp_… npm run db:apply -w backend -- --print-env
 *
 * With no `--project-ref` it lists the projects on the account and picks one if there is
 * exactly one, so the common case needs no arguments at all.
 *
 * `--print-env` additionally fetches the project's API keys and prints the two lines the
 * backend needs, ready to paste into `backend/.env` or Render.
 *
 * The token is never written anywhere: it is read from the environment, used, and dropped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, setPretty } from '../src/lib/logger.js';

setPretty(true);
const log = createLogger({ script: 'apply-schema' });

const API = 'https://api.supabase.com/v1';
const TOKEN = process.env['SUPABASE_ACCESS_TOKEN']?.trim();

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(here, '../../db/schema.sql');

function flag(name: string): string | null {
  const withEq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i >= 0 && next && !next.startsWith('--') ? next : null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase API ${init.method ?? 'GET'} ${pathname} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

interface Project {
  id: string;
  name: string;
  region: string;
  status: string;
  created_at: string;
}

/** Run one statement batch. The Management API takes raw SQL and returns rows as JSON. */
const runSql = (ref: string, query: string): Promise<unknown> =>
  api(`/projects/${ref}/database/query`, { method: 'POST', body: JSON.stringify({ query }) });

async function resolveProjectRef(): Promise<string> {
  const explicit = flag('project-ref');
  if (explicit) return explicit;

  const projects = await api<Project[]>('/projects');
  const usable = projects.filter((p) => p.status === 'ACTIVE_HEALTHY' || p.status === 'COMING_UP');

  if (usable.length === 0) {
    throw new Error(
      `No active projects on this account. Create one at https://supabase.com/dashboard, then re-run.\n` +
        `All projects seen: ${projects.map((p) => `${p.name} (${p.status})`).join(', ') || 'none'}`,
    );
  }
  if (usable.length > 1) {
    throw new Error(
      `This account has ${usable.length} active projects. Choose one with --project-ref:\n` +
        usable.map((p) => `  --project-ref ${p.id}    ${p.name} · ${p.region}`).join('\n'),
    );
  }

  const only = usable[0] as Project;
  log.info('using the only active project on this account', { name: only.name, ref: only.id, region: only.region });
  return only.id;
}

async function verify(ref: string): Promise<void> {
  const EXPECTED_TABLES = [
    'alerts', 'cron_locks', 'cron_runs', 'price_history',
    'products', 'scrape_logs', 'structure_fingerprints', 'tracked_products',
  ];

  const tables = (await runSql(
    ref,
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )) as { table_name: string }[];
  const names = tables.map((t) => t.table_name);
  const missing = EXPECTED_TABLES.filter((t) => !names.includes(t));
  if (missing.length > 0) throw new Error(`Schema applied but these tables are missing: ${missing.join(', ')}`);

  const views = (await runSql(
    ref,
    `select table_name from information_schema.views where table_schema = 'public'`,
  )) as { table_name: string }[];
  if (!views.some((v) => v.table_name === 'tracked_overview')) {
    throw new Error('The tracked_overview view was not created; the dashboard reads it.');
  }

  const functions = (await runSql(
    ref,
    `select routine_name from information_schema.routines
     where routine_schema = 'public' and routine_name in
       ('search_products','try_acquire_cron_lock','release_cron_lock')`,
  )) as { routine_name: string }[];
  const fnNames = functions.map((f) => f.routine_name);
  const missingFns = ['search_products', 'try_acquire_cron_lock', 'release_cron_lock'].filter(
    (f) => !fnNames.includes(f),
  );
  if (missingFns.length > 0) throw new Error(`Missing function(s): ${missingFns.join(', ')}`);

  // RLS on every table is what makes the anon key harmless. Check it rather than assume it.
  const unprotected = (await runSql(
    ref,
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
  )) as { relname: string }[];
  if (unprotected.length > 0) {
    throw new Error(`Row Level Security is off on: ${unprotected.map((r) => r.relname).join(', ')}`);
  }

  log.info('verified', {
    tables: names.length,
    view: 'tracked_overview',
    functions: fnNames.length,
    rls: 'enabled on every table',
  });
}

async function printEnv(ref: string): Promise<void> {
  const keys = (await api<{ name: string; api_key: string }[]>(`/projects/${ref}/api-keys`).catch(() => null)) ?? [];
  const service = keys.find((k) => k.name === 'service_role')?.api_key;
  const anon = keys.find((k) => k.name === 'anon')?.api_key;

  console.log('\n  Paste into backend/.env, and into Render when you deploy:\n');
  console.log(`  SUPABASE_URL=https://${ref}.supabase.co`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY=${service ?? '<Settings → API Keys → service_role>'}`);
  if (anon) console.log(`  # anon key (not used by this backend, RLS blocks it anyway): ${anon.slice(0, 12)}…`);
  console.log('');
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error(
      [
        '',
        '  SUPABASE_ACCESS_TOKEN is not set.',
        '',
        '  Create one at https://supabase.com/dashboard/account/tokens, then:',
        '',
        '    SUPABASE_ACCESS_TOKEN=sbp_xxx npm run db:apply -w backend -- --print-env',
        '',
        '  If you would rather not use a token: open the Supabase SQL editor and paste',
        '  db/schema.sql by hand. It is idempotent and does exactly the same thing.',
        '',
      ].join('\n'),
    );
    process.exit(2);
  }

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  log.info('read schema', { path: 'db/schema.sql', bytes: schema.length });

  const ref = await resolveProjectRef();

  log.info('applying schema', { ref });
  await runSql(ref, schema);
  log.info('schema applied');

  await verify(ref);
  if (has('print-env')) await printEnv(ref);

  console.log(`\n  Done. Next: seed the catalogue so search works —\n\n    npm run seed:catalog -w backend\n`);
}

main().catch((err: unknown) => {
  log.error('failed', { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
