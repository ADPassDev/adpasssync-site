// Paddle subscriptions -> what the customer has paid for.
//
// Pricing: 50 active AD users are free and built into the product. Past that,
// customers pay $5 per user per year for every user, the first 50 included,
// so a Paddle subscription's quantity is the license's user count, and the
// Professional price only allows 51 and up.
//
// The paid term is the end of the latest billing period a payment covered:
//   - a cancellation doesn't shorten it; the customer keeps what they paid for
//     until it runs out, and the subscription just doesn't renew;
//   - an approved refund or chargeback ends it at once;
//   - a failed renewal (past_due) doesn't extend it until the payment succeeds.
//
// Pure functions, no imports, so test/billing.test.ts can load them directly.

export const MIN_PAID_USERS = 51;
export const MAX_PAID_USERS = 100_000;

/** The subset of a Paddle subscription entity (webhook `data`) used here. */
export type PaddleSubscription = {
  id: string;
  status: string; // active | canceled | past_due | paused | trialing
  customer_id: string;
  items: {
    quantity: number;
    recurring?: boolean;
    status?: string;
    price?: { id: string } | null;
  }[];
  current_billing_period?: { starts_at: string; ends_at: string } | null;
  next_billed_at?: string | null;
  scheduled_change?: { action: string; effective_at: string } | null;
  custom_data?: Record<string, unknown> | null;
  updated_at: string;
};

/** What the site keeps per subscription (the paddle_subscriptions table). */
export type SubscriptionRecord = {
  id: string;
  customer_id: string;
  status: string;
  quantity: number;
  paid_through: number | null;
  next_billed_at: number | null;
  cancel_at: number | null;
  refunded_at: number | null;
  paddle_updated_ms: number;
};

/** An entitlement as license.ts / db.ts store it. */
export type PaidTerm = {
  tier: 'professional';
  max_users: number;
  expires_at: number;
  source: string;
};

export function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Self-service purchasing needs the API key, the Professional price, a
 * Paddle.js token and the webhook secret. Without the secret every payment
 * notification is rejected, so a checkout would take money that never
 * becomes a license.
 */
export function paddleConfigured(env: {
  PADDLE_API_KEY?: string;
  PADDLE_PRICE_ID?: string;
  PADDLE_CLIENT_TOKEN?: string;
  PADDLE_WEBHOOK_SECRET?: string;
}): boolean {
  return Boolean(env.PADDLE_API_KEY && env.PADDLE_PRICE_ID && env.PADDLE_CLIENT_TOKEN && env.PADDLE_WEBHOOK_SECRET);
}

/**
 * Whether this account may buy through Paddle. In production, everyone. In
 * the sandbox, only the accounts listed in PADDLE_SANDBOX_TESTERS (comma
 * separated): the sandbox takes Paddle's published test cards, so on the live
 * site an open sandbox checkout would hand out paid licenses for nothing.
 */
export function billingOpenTo(
  env: { PADDLE_ENV?: string; PADDLE_SANDBOX_TESTERS?: string },
  email: string,
): boolean {
  if (env.PADDLE_ENV === 'production') return true;
  const who = email.trim().toLowerCase();
  if (!who) return false;
  return (env.PADDLE_SANDBOX_TESTERS ?? '').split(',').some((t) => t.trim().toLowerCase() === who);
}

/** Valid number of users to buy: a whole number from 51 to 100,000. */
export function parsePaidUsers(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= MIN_PAID_USERS && n <= MAX_PAID_USERS ? n : null;
}

/**
 * The fields of a Paddle subscription the site keeps. `periodPaidThrough` is
 * set only while the subscription is active: Paddle moves a subscription
 * whose renewal payment fails to past_due, so an active subscription's
 * current period has been paid for.
 */
export function subscriptionFields(sub: PaddleSubscription, priceId: string) {
  const item =
    sub.items.find((i) => i.price?.id === priceId) ??
    sub.items.find((i) => i.recurring !== false) ??
    sub.items[0];
  return {
    status: sub.status,
    quantity: item?.quantity ?? 0,
    next_billed_at: toUnixSeconds(sub.next_billed_at),
    cancel_at:
      sub.scheduled_change?.action === 'cancel' ? toUnixSeconds(sub.scheduled_change.effective_at) : null,
    periodPaidThrough:
      sub.status === 'active' ? toUnixSeconds(sub.current_billing_period?.ends_at) : null,
    updated_ms: Number.isFinite(Date.parse(sub.updated_at)) ? Date.parse(sub.updated_at) : 0,
  };
}

/**
 * The paid term a customer's subscriptions give them: the one that runs
 * furthest (normally there is only one). Null if no payment ever completed,
 * in which case Paddle has nothing to say about the customer's entitlement.
 * A refunded subscription's term ends at the refund.
 */
export function paidTerm(
  subs: Pick<SubscriptionRecord, 'id' | 'quantity' | 'paid_through' | 'refunded_at'>[],
): PaidTerm | null {
  let best: PaidTerm | null = null;
  for (const s of subs) {
    if (s.paid_through === null) continue;
    const end = s.refunded_at === null ? s.paid_through : Math.min(s.refunded_at, s.paid_through);
    if (best === null || end > best.expires_at) {
      best = {
        tier: 'professional',
        max_users: Math.max(s.quantity, MIN_PAID_USERS),
        expires_at: end,
        source: `paddle:${s.id}`,
      };
    }
  }
  return best;
}
