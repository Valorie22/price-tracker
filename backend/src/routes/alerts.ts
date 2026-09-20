import { Router } from 'express';
import { listAlerts, listFingerprints, markAlertRead } from '../db/queries.js';
import { isEmailConfigured } from '../lib/alerts.js';

export const alertsRouter = Router();

alertsRouter.get('/alerts', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 100) || 100, 200);
    const unreadOnly = req.query['unread'] === '1' || req.query['unread'] === 'true';
    const alerts = await listAlerts({ limit, unreadOnly });
    res.json({ alerts, emailConfigured: isEmailConfigured() });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/alerts/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params['id']);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    await markAlertRead(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Structure history: every distinct shape we have seen the store in.
 * Drives the "the store changed" banner and gives it something to point at.
 */
alertsRouter.get('/structure', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query['limit'] ?? 20) || 20, 100);
    const rows = await listFingerprints(limit);
    res.json({
      current: rows[0] ?? null,
      changedRecently: rows.length > 1 && Date.parse(rows[0]?.last_seen_at ?? '') > Date.now() - 24 * 3600_000 && rows[0]?.occurrences === 1,
      fingerprints: rows,
    });
  } catch (err) {
    next(err);
  }
});
