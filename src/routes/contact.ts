// Public contact form endpoint.
//
// POST /api/contact  { name, email, company?, ad_users?, interest?, message? }
//
// Unauthenticated by design — this backs the contact form on the marketing
// site. Replaces the third-party formsubmit.co relay the form used to POST to,
// so submissions go through our own Resend sender and show up in Worker logs.

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { isValidEmail, sendContactEmail } from '../lib/email';

const contact = new Hono<{ Bindings: Env; Variables: Variables }>();

// Field caps. Everything here is attacker-controlled, and the values are only
// ever rendered into an email we send ourselves, so truncating is enough —
// there's no store to protect.
const MAX_NAME = 200;
const MAX_SHORT = 200;
const MAX_MESSAGE = 5000;

/** Trim, truncate, and collapse empties to null. */
function optional(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

contact.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const {
    name,
    email,
    company,
    ad_users: adUsers,
    interest,
    message,
    _honey: honey,
  } = (body ?? {}) as Record<string, unknown>;

  // Honeypot: the form ships a hidden field real users never fill in. Answer
  // 200 so bots can't tell they were caught, but send nothing.
  if (typeof honey === 'string' && honey.trim()) {
    return c.json({ ok: true });
  }

  if (typeof email !== 'string' || !isValidEmail(email.trim())) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  const cleanName = optional(name, MAX_NAME);
  if (!cleanName) {
    return c.json({ error: 'invalid_name' }, 400);
  }

  const submission = {
    name: cleanName,
    email: email.trim().toLowerCase(),
    company: optional(company, MAX_SHORT),
    adUsers: optional(adUsers, MAX_SHORT),
    interest: optional(interest, MAX_SHORT),
    message: optional(message, MAX_MESSAGE),
  };

  // Send out-of-band so a slow or flaky provider doesn't stall the visitor.
  // There's no contact table to fall back on, so a failure is only recoverable
  // from the Worker logs — log the whole submission, not just the error.
  c.executionCtx.waitUntil(
    sendContactEmail(c.env, submission).catch((err) => {
      console.error('contact email failed', err, JSON.stringify(submission));
    }),
  );

  return c.json({ ok: true });
});

export default contact;
