// POST /api/paddle/webhook — Paddle Billing notifications.
//
// Point a Paddle notification destination here (Developer tools >
// Notifications) for subscription.*, transaction.completed, adjustment.created
// and adjustment.updated, and put its secret key in PADDLE_WEBHOOK_SECRET.
// No session: authenticity comes from the Paddle-Signature header alone.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { verifyPaddleSignature } from '../lib/paddle-signature';
import { handlePaddleEvent, type PaddleEvent } from '../lib/paddle-sync';

const paddle = new Hono<{ Bindings: Env; Variables: Variables }>();

paddle.post('/webhook', async (c) => {
  // The signature covers the exact bytes Paddle sent, so verify before parsing.
  const raw = await c.req.text();
  const check = await verifyPaddleSignature(raw, c.req.header('Paddle-Signature'), c.env.PADDLE_WEBHOOK_SECRET ?? '');
  if (!check.ok) {
    console.warn('paddle webhook rejected:', check.reason);
    return c.json({ error: 'invalid_signature' }, 401);
  }

  let event: PaddleEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  if (typeof event?.event_id !== 'string' || typeof event.event_type !== 'string' || !event.data) {
    return c.json({ error: 'invalid_event' }, 400);
  }

  const seen = await c.env.DB.prepare('SELECT 1 FROM paddle_events WHERE event_id = ?1')
    .bind(event.event_id)
    .first();
  if (seen) return c.json({ ok: true, duplicate: true });

  try {
    await handlePaddleEvent(c.env, c.executionCtx, event);
  } catch (e) {
    // Not recorded as processed, and a non-2xx makes Paddle retry. Handlers
    // are idempotent, so a partly applied event is safe to run again.
    console.error('paddle webhook processing failed', event.event_type, event.event_id, e);
    return c.json({ error: 'processing_failed' }, 500);
  }
  await c.env.DB.prepare('INSERT OR IGNORE INTO paddle_events (event_id, event_type, occurred_at) VALUES (?1, ?2, ?3)')
    .bind(event.event_id, event.event_type, String(event.occurred_at ?? ''))
    .run();
  return c.json({ ok: true });
});

export default paddle;
