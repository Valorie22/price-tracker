/**
 * Alerts: raise once, deliver twice.
 *
 * Every alert lands in the `alerts` table, which is what the UI reads. Email is a
 * best-effort second channel — if SendGrid is not configured or is having a bad day,
 * the alert still exists and the scrape still succeeded. An alerting path that can
 * fail a scrape is worse than no alerting path.
 */
import { hasRecentAlert, insertAlert, markAlertEmailed } from '../db/queries.js';
import type { AlertKind, AlertRow } from '../db/types.js';
import { env } from './env.js';
import { logger } from './logger.js';

/** How long the same alert stays "already said that" for. */
const DEDUPE_MINUTES: Record<AlertKind, number> = {
  price_drop: 60,
  back_in_stock: 60,
  structure_change: 180,
  repeated_failure: 180,
  product_gone: 1440,
  large_delta: 60,
};

export interface RaiseAlertInput {
  trackedId: string | null;
  kind: AlertKind;
  message: string;
  payload?: Record<string, unknown>;
  /** Skip the dedupe window — used when the caller has already decided it is new. */
  force?: boolean;
}

export async function raiseAlert(input: RaiseAlertInput): Promise<AlertRow | null> {
  try {
    if (!input.force) {
      const recent = await hasRecentAlert(input.trackedId, input.kind, DEDUPE_MINUTES[input.kind]);
      if (recent) {
        logger.debug('alert suppressed as duplicate', { kind: input.kind, trackedId: input.trackedId });
        return null;
      }
    }

    const alert = await insertAlert({
      tracked_product_id: input.trackedId,
      kind: input.kind,
      message: input.message,
      payload: input.payload ?? null,
    });
    logger.info('alert raised', { kind: input.kind, trackedId: input.trackedId, message: input.message });

    void sendAlertEmail(alert).catch((err) => logger.warn('alert email failed', { err: String(err) }));
    return alert;
  } catch (err) {
    // Never let alerting break a scrape.
    logger.error('failed to raise alert', { kind: input.kind, err: String(err) });
    return null;
  }
}

const EMAILABLE: AlertKind[] = ['price_drop', 'back_in_stock', 'repeated_failure', 'product_gone', 'structure_change'];

export function isEmailConfigured(): boolean {
  return Boolean(env.sendgridApiKey && env.alertToEmail && env.alertFromEmail);
}

async function sendAlertEmail(alert: AlertRow): Promise<void> {
  if (!isEmailConfigured()) return;
  if (!EMAILABLE.includes(alert.kind)) return;

  const subject = `[INE Price Tracker] ${titleFor(alert.kind)}`;
  const body = [
    alert.message,
    '',
    alert.payload ? `Details: ${JSON.stringify(alert.payload, null, 2)}` : '',
    '',
    `Raised at ${alert.created_at}`,
  ]
    .filter(Boolean)
    .join('\n');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.sendgridApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: env.alertToEmail }] }],
      from: { email: env.alertFromEmail, name: 'INE Price Tracker' },
      subject,
      content: [{ type: 'text/plain', value: body }],
    }),
  });

  if (!res.ok) {
    throw new Error(`SendGrid responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  await markAlertEmailed(alert.id);
  logger.info('alert emailed', { id: alert.id, kind: alert.kind });
}

function titleFor(kind: AlertKind): string {
  switch (kind) {
    case 'price_drop': return 'Price drop';
    case 'back_in_stock': return 'Back in stock';
    case 'structure_change': return 'Store structure changed';
    case 'repeated_failure': return 'Repeated scrape failures';
    case 'product_gone': return 'Product no longer exists';
    case 'large_delta': return 'Unusually large price move';
  }
}
