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

auth.post('/login', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const email = (body as { email?: unknown })?.email;
  if (typeof email !== 'string' || !isValidEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  const normalized = email.trim().toLowerCase();

  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  await createMagicLink(c.env.DB, tokenHash, normalized, magicLinkTtlMinutes(c.env));

  const link = `${c.env.PUBLIC_BASE_URL}/api/auth/verify?token=${rawToken}`;
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
  const token = c.req.query('token');
  if (!token || typeof token !== 'string' || token.length < 32) {
    return c.redirect('/portal/?error=invalid_link', 302);
  }
  const tokenHash = await sha256Hex(token);
  const consumed = await consumeMagicLink(c.env.DB, tokenHash);
  if (!consumed) {
    return c.redirect('/portal/?error=expired_link', 302);
  }

  const customer = await getOrCreateCustomerByEmail(c.env.DB, consumed.email);
  await issueSession(c, customer.id);

  // Admins land on the admin page; regular customers on the dashboard.
  const dest = isAdminEmail(c.env, customer.email)
    ? '/portal/admin.html'
    : '/portal/dashboard.html';
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
