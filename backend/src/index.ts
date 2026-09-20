/**
 * HTTP entry point.
 *
 * Boots even without Supabase configured, so a misconfigured deploy fails at the
 * endpoint you called with a sentence you can act on, rather than as a crash loop
 * that tells you nothing from the Render dashboard.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { env, isProd } from './lib/env.js';
import { logger } from './lib/logger.js';
import { isDbConfigured } from './db/client.js';
import { closeFetcher } from './scraper/fetcher.js';
import { closeBrowser } from './scraper/browser.js';
import { healthRouter } from './routes/health.js';
import { storeRouter } from './routes/store.js';
import { trackedRouter } from './routes/tracked.js';
import { cronRouter } from './routes/cron.js';
import { alertsRouter } from './routes/alerts.js';

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const allowed = env.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true); // curl, server-to-server, cron
      if (allowed.includes('*')) return callback(null, true);
      if (allowed.some((a) => origin === a || (a.startsWith('*.') && origin.endsWith(a.slice(1))))) {
        return callback(null, true);
      }
      // Vercel preview deployments get a new subdomain per commit.
      if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) && allowed.some((a) => a.endsWith('.vercel.app'))) {
        return callback(null, true);
      }
      logger.warn('CORS rejected an origin', { origin, allowed });
      return callback(new Error(`Origin ${origin} is not allowed`));
    },
    credentials: false,
  }),
);

// Request log: one line per request, with the duration. Health checks are noisy and
// arrive every few seconds from Render, so they log at debug.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const fields = { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started };
    if (req.path.includes('health') || req.path.includes('keepalive')) logger.debug('request', fields);
    else logger.info('request', fields);
  });
  next();
});

app.use('/api', healthRouter);
app.use('/api', storeRouter);
app.use('/api', trackedRouter);
app.use('/api', cronRouter);
app.use('/api', alertsRouter);

app.get('/', (_req, res) => {
  res.json({
    name: 'INE Price Tracker API',
    version: env.version,
    docs: 'See README.md § API',
    endpoints: ['/api/health', '/api/store/search?q=', '/api/tracked', '/api/alerts', '/api/cron/scrape'],
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const configError = /Supabase is not configured/i.test(err.message);
  logger.error('unhandled error', { message: err.message, stack: isProd ? undefined : err.stack });
  res.status(configError ? 503 : 500).json({
    error: configError ? 'database_not_configured' : 'internal_error',
    message: err.message,
  });
});

const server = app.listen(env.port, () => {
  logger.info('backend listening', {
    port: env.port,
    env: env.nodeEnv,
    store: env.storeBaseUrl,
    database: isDbConfigured() ? 'configured' : 'NOT CONFIGURED — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    cronSecret: env.cronSecret ? 'set' : 'NOT SET — /api/cron/scrape will reject every call',
    browserFallback: env.browserFallbackEnabled ? 'enabled' : 'disabled',
  });
});

/**
 * Graceful shutdown.
 *
 * Render sends SIGTERM on every deploy. Closing the HTTP server first lets in-flight
 * requests finish; closing the undici pool and any browser afterwards keeps a deploy
 * during a scrape from leaking a Chromium process on the way out.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });

  const forced = setTimeout(() => {
    logger.warn('shutdown timed out; exiting anyway');
    process.exit(1);
  }, 12_000);
  forced.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([closeFetcher(), closeBrowser()]);
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { reason: String(reason) }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { message: err.message, stack: err.stack });
  void shutdown('uncaughtException');
});

export { app };
