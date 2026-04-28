// Session/cookie helpers and Hono middleware for authn/z.

import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Env, Variables } from '../types';
import {
  createSession,
  deleteSessionByTokenHash,
  findSessionByTokenHash,
  isAdminEmail,
  touchSession,
} from './db';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'pps_session';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

export function getClientIp(c: AppContext): string | null {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    null
  );
}

export function sessionTtlSeconds(env: Env): number {
  const hours = Number(env.SESSION_TTL_HOURS) || 24;
  return hours * 3600;
}

export function magicLinkTtlMinutes(env: Env): number {
  return Number(env.MAGIC_LINK_TTL_MINUTES) || 15;
}

/** Create a session for the given customer and set the cookie. Returns the raw token. */
export async function issueSession(
  c: AppContext,
  customerId: string,
): Promise<string> {
  const env = c.env;
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const ttl = sessionTtlSeconds(env);
  await createSession(env.DB, {
    customerId,
    tokenHash,
    ttlSeconds: ttl,
    userAgent: c.req.header('User-Agent') ?? null,
    ipAddress: getClientIp(c),
  });
  setCookie(c, SESSION_COOKIE, rawToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: ttl,
  });
  return rawToken;
}

export async function revokeCurrentSession(c: AppContext): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    const hash = await sha256Hex(raw);
    await deleteSessionByTokenHash(c.env.DB, hash);
  }
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  });
}

/**
 * Middleware: if a valid session cookie is present, attach the customer
 * (and admin flag) to the request context. Always continues — does not
 * reject anonymous requests.
 */
export const loadSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    const hash = await sha256Hex(raw);
    const found = await findSessionByTokenHash(c.env.DB, hash);
    if (found) {
      c.set('customer', found.customer);
      c.set('isAdmin', isAdminEmail(c.env, found.customer.email));
      // Best-effort touch; failures are non-fatal.
      c.executionCtx.waitUntil(
        touchSession(c.env.DB, found.session.id).catch(() => {}),
      );
    }
  }
  await next();
};

/** Reject the request unless a session is attached. */
export const requireAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  if (!c.get('customer')) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  await next();
};

/** Reject the request unless the attached customer is an admin. */
export const requireAdmin: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const customer = c.get('customer');
  if (!customer) return c.json({ error: 'unauthenticated' }, 401);
  if (!c.get('isAdmin')) return c.json({ error: 'forbidden' }, 403);
  await next();
};
