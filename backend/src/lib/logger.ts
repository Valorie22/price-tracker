/**
 * Structured logging.
 *
 * Two audiences:
 *   - Render's log stream (JSON lines, greppable by run_id)
 *   - a human watching the headed run (`pretty` mode, aligned columns)
 *
 * The scrape log in Postgres is the durable record; this is the live narration.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = LEVEL_ORDER[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? 20;
let pretty = process.env.LOG_FORMAT === 'pretty';

export function setPretty(value: boolean): void {
  pretty = value;
}

const COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function emit(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;

  if (pretty) {
    const ts = new Date().toISOString().slice(11, 23);
    const extras = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${DIM}${k}=${RESET}${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' ');
    // eslint-disable-next-line no-console
    console.log(`${DIM}${ts}${RESET} ${COLOR[level]}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${extras ? '  ' + extras : ''}`);
    return;
  }

  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

export function createLogger(bound: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, f) => emit('debug', m, { ...bound, ...f }),
    info: (m, f) => emit('info', m, { ...bound, ...f }),
    warn: (m, f) => emit('warn', m, { ...bound, ...f }),
    error: (m, f) => emit('error', m, { ...bound, ...f }),
    child: (extra) => createLogger({ ...bound, ...extra }),
  };
}

export const logger = createLogger();
