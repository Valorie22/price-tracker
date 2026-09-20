/**
 * Supabase client.
 *
 * The backend holds the service-role key and is the only thing that touches the
 * database. Every table has RLS on with no policies, so the anon key can read and
 * write nothing — reads go through the API so exactly one place owns correctness
 * (and so a future auth layer has one door to guard rather than seven).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '../lib/env.js';

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (cached) return cached;
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    throw new Error('Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  cached = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'ine-price-tracker' } },
  });
  return cached;
}

export function isDbConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseServiceRoleKey);
}

/** Turn a PostgREST error into something a log reader can act on. */
export class DbError extends Error {
  readonly details: string | undefined;
  readonly hint: string | undefined;
  readonly code: string | undefined;

  constructor(operation: string, error: { message: string; details?: string; hint?: string; code?: string }) {
    super(`${operation}: ${error.message}`);
    this.name = 'DbError';
    this.details = error.details;
    this.hint = error.hint;
    this.code = error.code;
  }
}

export function unwrap<T>(operation: string, result: { data: T | null; error: unknown }): T {
  if (result.error) throw new DbError(operation, result.error as { message: string });
  if (result.data === null) throw new DbError(operation, { message: 'query returned no data' });
  return result.data;
}
