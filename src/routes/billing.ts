// Self-service billing for the signed-in customer, through Paddle. Mounted at
// /api/portal/billing behind requireAuth. Nothing here grants anything: the
// entitlement changes only when Paddle's webhook confirms a payment.

import { Hono } from 'hono';
import type { Customer, Env, Variables } from '../types';
import {
  MAX_PAID_USERS,
  MIN_PAID_USERS,
  billingOpenTo,
  parsePaidUsers,
  type SubscriptionRecord,
} from '../lib/billing';
import {
  PaddleApiError,
  changeSubscriptionQuantity,
  createCheckoutTransaction,
  createPortalSession,
  findOrCreatePaddleCustomer,
  paddleConfigured,
} from '../lib/paddle';
import { getHashDbKey } from '../lib/hashdb-key';
import { getEntitlement } from '../lib/db';
import { effectiveEntitlement } from '../lib/license';

const billing = new Hono<{ Bindings: Env; Variables: Variables }>();

// Subscriptions that still renew (or could, once a payment goes through).
const LIVE = new Set(['active', 'past_due', 'paused', 'trialing']);

// GET /api/portal/billing
// What the dashboard needs to show the plan: whether self-service purchasing
// is on, Paddle.js settings, the customer's current subscription, and their
// full bloom filter key if they have one.
billing.get('/', async (c) => {
  const customer = c.get('customer')!;
  const sub = await currentSubscription(c.env.DB, customer.id);
  // The key is revoked whenever the customer is back on the free tier.
  const paid = effectiveEntitlement(await getEntitlement(c.env.DB, customer.id)).tier !== 'free';
  return c.json({
    enabled: closedFor(c.env, customer) === null,
    environment: c.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox',
    client_token: c.env.PADDLE_CLIENT_TOKEN || null,
    min_users: MIN_PAID_USERS,
    max_users: MAX_PAID_USERS,
    subscription: sub && {
      id: sub.id,
      status: sub.status,
      live: LIVE.has(sub.status) && sub.refunded_at === null,
      quantity: sub.quantity,
      paid_through: sub.paid_through,
      next_billed_at: sub.next_billed_at,
      cancel_at: sub.cancel_at,
      refunded_at: sub.refunded_at,
    },
    hashdb_key: paid ? await getHashDbKey(c.env, customer.id) : null,
  });
});

// POST /api/portal/billing/checkout   { users }
// Creates the Paddle transaction for a new subscription and returns its id
// for Paddle.Checkout.open({ transactionId }).
billing.post('/checkout', async (c) => {
  const customer = c.get('customer')!;
  const closed = closedFor(c.env, customer);
  if (closed) return c.json({ error: closed.error }, closed.status);
  const users = parsePaidUsers(((await readJson(c.req.raw)) as { users?: unknown } | null)?.users);
  if (users === null) return c.json({ error: 'invalid_users', min: MIN_PAID_USERS, max: MAX_PAID_USERS }, 400);

  const sub = await currentSubscription(c.env.DB, customer.id);
  if (sub && LIVE.has(sub.status) && sub.refunded_at === null) {
    return c.json({ error: 'already_subscribed' }, 409);
  }
  try {
    const paddleCustomerId = await paddleCustomerFor(c.env, customer);
    const txn = await createCheckoutTransaction(c.env, { paddleCustomerId, quantity: users, customerId: customer.id });
    return c.json({ transaction_id: txn.id });
  } catch (e) {
    return paddleFailure(c, 'checkout', e);
  }
});

// POST /api/portal/billing/users/preview   { users }
// POST /api/portal/billing/users           { users }
// Changes the user count on the current subscription; the difference for the
// rest of the period is charged (or credited) now. The preview says how much.
for (const [path, preview] of [['/users/preview', true], ['/users', false]] as const) {
  billing.post(path, async (c) => {
    const customer = c.get('customer')!;
    const closed = closedFor(c.env, customer);
    if (closed) return c.json({ error: closed.error }, closed.status);
    const users = parsePaidUsers(((await readJson(c.req.raw)) as { users?: unknown } | null)?.users);
    if (users === null) return c.json({ error: 'invalid_users', min: MIN_PAID_USERS, max: MAX_PAID_USERS }, 400);

    const sub = await currentSubscription(c.env.DB, customer.id);
    if (!sub || sub.status !== 'active' || sub.refunded_at !== null) {
      return c.json({ error: 'no_active_subscription' }, 409);
    }
    if (sub.quantity === users) return c.json({ error: 'no_change' }, 400);
    try {
      const result = await changeSubscriptionQuantity(c.env, sub.id, users, preview);
      return c.json({ ok: true, users, ...result });
    } catch (e) {
      return paddleFailure(c, preview ? 'quantity preview' : 'quantity change', e);
    }
  });
}

// POST /api/portal/billing/portal
// A fresh link to Paddle's customer portal: payment method, invoices, cancel.
billing.post('/portal', async (c) => {
  const customer = c.get('customer')!;
  const closed = closedFor(c.env, customer);
  if (closed) return c.json({ error: closed.error }, closed.status);
  const row = await c.env.DB.prepare('SELECT paddle_customer_id FROM paddle_customers WHERE customer_id = ?1')
    .bind(customer.id)
    .first<{ paddle_customer_id: string }>();
  if (!row) return c.json({ error: 'no_billing_account' }, 404);
  const subs = await c.env.DB.prepare('SELECT id FROM paddle_subscriptions WHERE customer_id = ?1 ORDER BY created_at DESC')
    .bind(customer.id)
    .all<{ id: string }>();
  try {
    const url = await createPortalSession(c.env, row.paddle_customer_id, (subs.results ?? []).map((s) => s.id));
    return c.json({ url });
  } catch (e) {
    return paddleFailure(c, 'portal session', e);
  }
});

/**
 * Why this customer can't use Paddle right now, if they can't: purchasing
 * isn't configured, or it's the sandbox and they aren't a named tester.
 */
function closedFor(env: Env, customer: Customer): { error: string; status: 403 | 503 } | null {
  if (!paddleConfigured(env)) return { error: 'billing_not_configured', status: 503 };
  if (!billingOpenTo(env, customer.email)) return { error: 'billing_testers_only', status: 403 };
  return null;
}

/** The customer's subscription to show: the newest live one, else the newest. */
async function currentSubscription(db: D1Database, customerId: string): Promise<SubscriptionRecord | null> {
  const res = await db
    .prepare('SELECT * FROM paddle_subscriptions WHERE customer_id = ?1 ORDER BY created_at DESC')
    .bind(customerId)
    .all<SubscriptionRecord>();
  const rows = res.results ?? [];
  return rows.find((s) => LIVE.has(s.status) && s.refunded_at === null) ?? rows[0] ?? null;
}

async function paddleCustomerFor(env: Env, customer: Customer): Promise<string> {
  const row = await env.DB.prepare('SELECT paddle_customer_id FROM paddle_customers WHERE customer_id = ?1')
    .bind(customer.id)
    .first<{ paddle_customer_id: string }>();
  if (row) return row.paddle_customer_id;
  const id = await findOrCreatePaddleCustomer(env, customer.email, customer.company || customer.name);
  await env.DB.prepare('INSERT OR IGNORE INTO paddle_customers (customer_id, paddle_customer_id) VALUES (?1, ?2)')
    .bind(customer.id, id)
    .run();
  return id;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function paddleFailure(c: { json: (b: unknown, s: 502) => Response }, what: string, e: unknown): Response {
  console.error(`paddle ${what} failed`, e);
  return c.json({ error: 'billing_unavailable', code: e instanceof PaddleApiError ? e.code : null }, 502);
}

export default billing;
