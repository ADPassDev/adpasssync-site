// Paddle webhook events -> subscription records -> entitlements.
//
// Events can arrive more than once and in any order, so each handler records
// state rather than applying deltas: subscription fields are only replaced by
// a newer updated_at, paid_through only ever moves forward (or is cut short
// by a refund), and the entitlement is recomputed from the records each time.
// The rules themselves (cancellation keeps the paid term, refunds end it) are
// in billing.ts.

import type { Customer, Env } from '../types';
import {
  MIN_PAID_USERS,
  billingOpenTo,
  paidTerm,
  subscriptionFields,
  toUnixSeconds,
  type PaddleSubscription,
  type SubscriptionRecord,
} from './billing';
import { findCustomerByEmail, findCustomerById, getEntitlement, nowSeconds, setEntitlement } from './db';
import { effectiveEntitlement } from './license';
import { applyEntitlementChange } from './entitlement-effects';
import { cancelSubscriptionNow, getPaddleCustomer, getPaddleSubscription } from './paddle';

export type PaddleEvent = {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
};

type PaddleTransaction = {
  id: string;
  status: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  custom_data?: Record<string, unknown> | null;
  billing_period?: { starts_at: string; ends_at: string } | null;
  items: { quantity: number; price_id?: string | null; price?: { id: string } | null }[];
};

type PaddleAdjustment = {
  id: string;
  action: string; // refund | chargeback | chargeback_reverse | credit | ...
  status: string; // pending_approval | approved | rejected | reversed
  subscription_id?: string | null;
  transaction_id: string;
  updated_at: string;
};

export async function handlePaddleEvent(env: Env, ctx: ExecutionContext, event: PaddleEvent): Promise<void> {
  if (event.event_type.startsWith('subscription.')) {
    await onSubscription(env, ctx, event.data as unknown as PaddleSubscription);
  } else if (event.event_type === 'transaction.completed') {
    await onTransactionCompleted(env, ctx, event.data as unknown as PaddleTransaction);
  } else if (event.event_type === 'adjustment.created' || event.event_type === 'adjustment.updated') {
    await onAdjustment(env, ctx, event.data as unknown as PaddleAdjustment);
  }
  // Anything else isn't ours to act on.
}

// Upserts a subscription record. Status, quantity and schedule are replaced
// only by state at least as new as what's stored; paid_through only grows.
const UPSERT_SUBSCRIPTION = `
  INSERT INTO paddle_subscriptions
    (id, customer_id, status, quantity, paid_through, next_billed_at, cancel_at, paddle_updated_ms, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
  ON CONFLICT(id) DO UPDATE SET
    status         = CASE WHEN excluded.paddle_updated_ms >= paddle_subscriptions.paddle_updated_ms
                          THEN excluded.status ELSE paddle_subscriptions.status END,
    quantity       = CASE WHEN excluded.paddle_updated_ms >= paddle_subscriptions.paddle_updated_ms
                          THEN excluded.quantity ELSE paddle_subscriptions.quantity END,
    next_billed_at = CASE WHEN excluded.paddle_updated_ms >= paddle_subscriptions.paddle_updated_ms
                          THEN excluded.next_billed_at ELSE paddle_subscriptions.next_billed_at END,
    cancel_at      = CASE WHEN excluded.paddle_updated_ms >= paddle_subscriptions.paddle_updated_ms
                          THEN excluded.cancel_at ELSE paddle_subscriptions.cancel_at END,
    paid_through   = CASE WHEN excluded.paid_through IS NULL THEN paddle_subscriptions.paid_through
                          WHEN paddle_subscriptions.paid_through IS NULL THEN excluded.paid_through
                          ELSE MAX(excluded.paid_through, paddle_subscriptions.paid_through) END,
    paddle_updated_ms = MAX(excluded.paddle_updated_ms, paddle_subscriptions.paddle_updated_ms),
    updated_at     = excluded.updated_at`;

async function onSubscription(env: Env, ctx: ExecutionContext, sub: PaddleSubscription): Promise<void> {
  const customer = await recordSubscription(env, sub);
  if (customer) await refreshEntitlement(env, ctx, customer);
}

/** Stores the subscription's state for its portal account, which it returns (null if none). */
async function recordSubscription(env: Env, sub: PaddleSubscription): Promise<Customer | null> {
  const customer = await resolveCustomer(env, sub.custom_data, sub.customer_id);
  if (!customer) {
    console.error('paddle: no portal account for subscription', sub.id, sub.customer_id);
    return null;
  }
  const f = subscriptionFields(sub, env.PADDLE_PRICE_ID);
  await env.DB.prepare(UPSERT_SUBSCRIPTION)
    .bind(sub.id, customer.id, f.status, f.quantity, f.periodPaidThrough, f.next_billed_at, f.cancel_at, f.updated_ms, nowSeconds())
    .run();
  return customer;
}

// A completed payment for a subscription covers its billing period.
async function onTransactionCompleted(env: Env, ctx: ExecutionContext, txn: PaddleTransaction): Promise<void> {
  const paidThrough = toUnixSeconds(txn.billing_period?.ends_at);
  if (!txn.subscription_id || paidThrough === null) return;
  const customer = await resolveCustomer(env, txn.custom_data, txn.customer_id ?? null);
  if (!customer) {
    console.error('paddle: no portal account for transaction', txn.id, txn.customer_id);
    return;
  }
  // The subscription's own events may not have arrived yet; until they do,
  // the quantity comes from the transaction (paddle_updated_ms 0 means the
  // first subscription event overwrites it).
  const item =
    txn.items.find((i) => (i.price_id ?? i.price?.id) === env.PADDLE_PRICE_ID) ?? txn.items[0];
  await env.DB.prepare(UPSERT_SUBSCRIPTION)
    .bind(txn.subscription_id, customer.id, 'active', item?.quantity ?? MIN_PAID_USERS, paidThrough, null, null, 0, nowSeconds())
    .run();
  await refreshEntitlement(env, ctx, customer);
}

// An approved refund or chargeback ends the paid term and stops renewals. A
// reversed chargeback (the payment stands after all) restores a term that a
// chargeback ended, though the subscription stays cancelled. Credits (e.g. for
// fewer users) don't touch the term.
async function onAdjustment(env: Env, ctx: ExecutionContext, adj: PaddleAdjustment): Promise<void> {
  if (adj.status !== 'approved' || !adj.subscription_id) return;
  const ends = adj.action === 'refund' || adj.action === 'chargeback';
  const restores = adj.action === 'chargeback_reverse';
  if (!ends && !restores) return;

  const subscriptionRow = () =>
    env.DB.prepare('SELECT * FROM paddle_subscriptions WHERE id = ?1')
      .bind(adj.subscription_id)
      .first<SubscriptionRecord & { ended_by: string | null }>();
  let row = await subscriptionRow();
  let recorded = false;
  if (!row) {
    // Paddle doesn't promise order, and retries after an outage come in any
    // order, so a refund can arrive before anything about its subscription.
    // Record the subscription from Paddle first, granting nothing yet, so the
    // refund applies to it and the term it ends is never handed out (nor a
    // "license ready" email sent) when the payment's notification turns up.
    // A failed lookup throws: Paddle retries the refund later.
    const sub = await getPaddleSubscription(env, adj.subscription_id);
    if (sub && (await recordSubscription(env, sub))) {
      row = await subscriptionRow();
      recorded = true;
    }
    if (!row) {
      console.error('paddle: adjustment for a subscription no portal account has', adj.id, adj.subscription_id);
      return;
    }
  }
  if (ends) {
    await env.DB.prepare(
      `UPDATE paddle_subscriptions
          SET refunded_at = COALESCE(refunded_at, ?2), ended_by = COALESCE(ended_by, ?3), updated_at = ?4
        WHERE id = ?1`,
    )
      .bind(row.id, toUnixSeconds(adj.updated_at) ?? nowSeconds(), adj.action, nowSeconds())
      .run();
    if (row.status !== 'canceled') {
      try {
        await cancelSubscriptionNow(env, row.id);
      } catch (e) {
        // Already canceled in Paddle, or unreachable: the term has ended here
        // either way; a subscription.canceled event follows a successful cancel.
        console.error('paddle: cancel after refund failed', row.id, e);
      }
    }
  } else if (row.ended_by === 'chargeback') {
    await env.DB.prepare(
      'UPDATE paddle_subscriptions SET refunded_at = NULL, ended_by = NULL, updated_at = ?2 WHERE id = ?1',
    )
      .bind(row.id, nowSeconds())
      .run();
  } else if (!recorded) {
    return; // a refund stands, and nothing changed
  }
  const customer = await findCustomerById(env.DB, row.customer_id);
  if (customer) await refreshEntitlement(env, ctx, customer);
}

/**
 * Sets the customer's entitlement from their Paddle subscriptions and, if
 * that changed anything, reissues their license and syncs their bloom filter
 * key. Customers with no paid Paddle subscription are left alone, so
 * entitlements set by an admin stand. The customer is emailed when they gain
 * or keep a paid term (first payment, renewal, new user count), not when it
 * ends.
 */
async function refreshEntitlement(env: Env, ctx: ExecutionContext, customer: Customer): Promise<void> {
  const subs = await env.DB.prepare(
    'SELECT id, quantity, paid_through, refunded_at FROM paddle_subscriptions WHERE customer_id = ?1',
  )
    .bind(customer.id)
    .all<Pick<SubscriptionRecord, 'id' | 'quantity' | 'paid_through' | 'refunded_at'>>();
  const term = paidTerm(subs.results ?? []);
  if (!term) return;

  const current = await getEntitlement(env.DB, customer.id);
  if (
    current &&
    current.tier === term.tier &&
    current.max_users === term.max_users &&
    current.expires_at === term.expires_at &&
    current.source === term.source
  ) {
    return;
  }
  const before = effectiveEntitlement(current);
  await setEntitlement(env.DB, customer.id, term);
  const after = effectiveEntitlement(term);
  const notify =
    after.tier !== 'free' &&
    (before.tier === 'free' || after.max_users !== before.max_users || after.expires_at !== before.expires_at);
  await applyEntitlementChange(env, ctx, customer, { notify });
}

/**
 * The portal account a Paddle object belongs to: the customer_id the portal
 * put in custom_data when it created the checkout, else a previously seen
 * Paddle customer, else (for subscriptions set up in Paddle directly) an
 * account with the Paddle customer's email. Null in the sandbox for anyone
 * who isn't a named tester, so their test-card payments grant nothing.
 */
async function resolveCustomer(
  env: Env,
  customData: Record<string, unknown> | null | undefined,
  paddleCustomerId: string | null,
): Promise<Customer | null> {
  let customer: Customer | null = null;
  const fromData = customData?.customer_id;
  if (typeof fromData === 'string') customer = await findCustomerById(env.DB, fromData);

  if (!customer && paddleCustomerId) {
    const mapped = await env.DB.prepare('SELECT customer_id FROM paddle_customers WHERE paddle_customer_id = ?1')
      .bind(paddleCustomerId)
      .first<{ customer_id: string }>();
    if (mapped) customer = await findCustomerById(env.DB, mapped.customer_id);
  }

  if (!customer && paddleCustomerId) {
    try {
      const pc = await getPaddleCustomer(env, paddleCustomerId);
      if (pc?.email) customer = await findCustomerByEmail(env.DB, pc.email);
    } catch (e) {
      console.error('paddle: customer lookup failed', paddleCustomerId, e);
    }
  }

  // Sandbox payments use public test cards: they count only for named testers.
  if (customer && !billingOpenTo(env, customer.email)) {
    console.warn('paddle: sandbox event for an account that is not a tester; ignored', customer.id);
    return null;
  }

  if (customer && paddleCustomerId) {
    await env.DB.prepare('INSERT OR IGNORE INTO paddle_customers (customer_id, paddle_customer_id) VALUES (?1, ?2)')
      .bind(customer.id, paddleCustomerId)
      .run();
  }
  return customer;
}
