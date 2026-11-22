// Magic-link authentication.
//
// Flow:
//   POST /api/auth/login          { email }
//     -> generate raw token, store SHA-256(token) with 15-min TTL,
//        email a link to GET /api/auth/verify?token=raw
//   GET  /api/auth/verify?token=  -> consume token, upsert customer,
//        issue session cookie, redirect to /portal/dashboard.html
//   POST /api/auth/logout         -> clear session
//   GET  /api/auth/me             -> current customer info

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import {
  consumeMagicLink,
  createMagicLink,
  getOrCreateCustomerByEmail,
  isAdminEmail,
} from '../lib/db';
import { randomToken, sha256Hex } from '../lib/crypto';
import {
  issueSession,
  magicLinkTtlMinutes,
  revokeCurrentSession,
} from '../lib/auth';
import { isValidEmail, sendMagicLinkEmail } from '../lib/email';

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

// Where to land after sign-in when a portal page asked for it, e.g.
// /portal/register?install_id=… opened from the product's License page.
// It ends up in a redirect, so only same-site portal paths are accepted.
const NEXT_RE = /^\/portal\/[A-Za-z0-9._\/-]*(\?[A-Za-z0-9._~%&=-]*)?$/;

export function safeNext(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  if (!NEXT_RE.test(raw) || raw.includes('//') || raw.includes('..')) return null;
  return raw;
}

function withNext(path: string, next: string | null): string {
  return next ? `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(next)}` : path;
}

auth.post('/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { email, next: rawNext } = (body ?? {}) as { email?: unknown; next?: unknown };
  if (typeof email !== 'string' || !isValidEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  const normalized = email.trim().toLowerCase();

  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  await createMagicLink(c.env.DB, tokenHash, normalized, magicLinkTtlMinutes(c.env));

  const link = withNext(
    `${c.env.PUBLIC_BASE_URL}/api/auth/verify?token=${rawToken}`,
    safeNext(rawNext),
  );
  await sendMagicLinkEmail(c.env, normalized, link);

  // For local dev / tests, return the link in the response so the magic-link
  // flow can be exercised without a real email backend. Disable in prod.
  const dev = c.env.DEV_RETURN_MAGIC_LINK === 'true';
  return c.json({
    ok: true,
    message: 'If that email exists, a sign-in link has been sent.',
    ...(dev ? { dev_link: link } : {}),
  });
});

auth.get('/verify', async (c) => {
  const next = safeNext(c.req.query('next'));
  const token = c.req.query('token');
  if (!token || typeof token !== 'string' || token.length < 32) {
    return c.redirect(withNext('/portal/?error=invalid_link', next), 302);
  }
  const tokenHash = await sha256Hex(token);
  const consumed = await consumeMagicLink(c.env.DB, tokenHash);
  if (!consumed) {
    return c.redirect(withNext('/portal/?error=expired_link', next), 302);
  }

  const customer = await getOrCreateCustomerByEmail(c.env.DB, consumed.email);
  await issueSession(c, customer.id);

  // A page that sent the customer to sign in gets them back; otherwise admins
  // land on the admin page and customers on the dashboard.
  const dest =
    next ?? (isAdminEmail(c.env, customer.email) ? '/portal/admin.html' : '/portal/dashboard.html');
  return c.redirect(dest, 302);
});

auth.post('/logout', async (c) => {
  await revokeCurrentSession(c);
  return c.json({ ok: true });
});

auth.get('/me', async (c) => {
  const customer = c.get('customer');
  if (!customer) return c.json({ authenticated: false }, 200);
  return c.json({
    authenticated: true,
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      company: customer.company,
      install_id: customer.install_id,
    },
    is_admin: c.get('isAdmin') === true,
  });
});

export default auth;
