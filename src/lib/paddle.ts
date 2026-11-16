// Paddle Billing API client: the handful of calls the portal makes, with plain
// fetch. Paths and payloads follow @paddle/paddle-node-sdk's types, which are
// generated from Paddle's API. Requests and responses are snake_case JSON;
// responses are { data, meta } or { error: { type, code, detail } }.

import type { Env } from '../types';
import type { PaddleSubscription } from './billing';

export class PaddleApiError extends Error {
  override name = 'PaddleApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
  ) {
    super(`Paddle API ${status} ${code}: ${detail}`);
  }
}

function baseUrl(env: Env): string {
  if (env.PADDLE_API_BASE_URL) return env.PADDLE_API_BASE_URL.replace(/\/+$/, '');
  return env.PADDLE_ENV === 'production' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  if (!env.PADDLE_API_KEY) throw new PaddleApiError(0, 'not_configured', 'PADDLE_API_KEY is not set');
  const res = await fetch(baseUrl(env) + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: { data?: unknown; error?: { code?: string; detail?: string } } | null = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page; reported below.
  }
  if (!res.ok) {
    throw new PaddleApiError(res.status, parsed?.error?.code ?? 'http_error', parsed?.error?.detail ?? text.slice(0, 200));
  }
  return parsed?.data as T;
}

const seg = encodeURIComponent;

export type PaddleCustomer = { id: string; email: string; name?: string | null };

export async function getPaddleCustomer(env: Env, paddleCustomerId: string): Promise<PaddleCustomer> {
  return call<PaddleCustomer>(env, 'GET', `/customers/${seg(paddleCustomerId)}`);
}

/** The Paddle customer for this email, created if Paddle has none. */
export async function findOrCreatePaddleCustomer(
  env: Env,
  email: string,
  name: string | null,
): Promise<string> {
  const find = async () =>
    (await call<PaddleCustomer[]>(env, 'GET', `/customers?email=${seg(email)}`))?.[0]?.id ?? null;
  const existing = await find();
  if (existing) return existing;
  try {
    return (await call<PaddleCustomer>(env, 'POST', '/customers', { email, ...(name ? { name } : {}) })).id;
  } catch (e) {
    // Created concurrently (or the email filter missed it): look again.
    const again = e instanceof PaddleApiError && e.status === 409 ? await find() : null;
    if (again) return again;
    throw e;
  }
}

/**
 * A transaction for `quantity` users of the Professional price, opened in
 * Paddle.js with its id. Creating it here, not in the browser, means the
 * price, quantity and account it credits can't be changed client-side.
 * custom_data is copied onto the subscription Paddle creates from it.
 */
export async function createCheckoutTransaction(
  env: Env,
  args: { paddleCustomerId: string; quantity: number; customerId: string },
): Promise<{ id: string; status: string }> {
  return call(env, 'POST', '/transactions', {
    items: [{ price_id: env.PADDLE_PRICE_ID, quantity: args.quantity }],
    customer_id: args.paddleCustomerId,
    custom_data: { customer_id: args.customerId },
    collection_mode: 'automatic',
  });
}

type SubscriptionUpdatePreview = {
  immediate_transaction?: { details?: { totals?: { grand_total?: string; currency_code?: string } } } | null;
};

/**
 * Changes the subscription's user count, billing or crediting the
 * difference for the rest of the period straight away. With `preview`,
 * changes nothing and returns what would be charged now.
 */
export async function changeSubscriptionQuantity(
  env: Env,
  subscriptionId: string,
  quantity: number,
  preview: boolean,
): Promise<{ charge_now: string | null; currency_code: string | null }> {
  const data = await call<SubscriptionUpdatePreview>(
    env,
    'PATCH',
    `/subscriptions/${seg(subscriptionId)}${preview ? '/preview' : ''}`,
    {
      items: [{ price_id: env.PADDLE_PRICE_ID, quantity }],
      proration_billing_mode: 'prorated_immediately',
    },
  );
  const totals = data?.immediate_transaction?.details?.totals;
  return { charge_now: totals?.grand_total ?? null, currency_code: totals?.currency_code ?? null };
}

/** The subscription as Paddle has it now; null if this Paddle account has no such subscription. */
export async function getPaddleSubscription(env: Env, subscriptionId: string): Promise<PaddleSubscription | null> {
  try {
    return await call<PaddleSubscription>(env, 'GET', `/subscriptions/${seg(subscriptionId)}`);
  } catch (e) {
    if (e instanceof PaddleApiError && e.status === 404) return null;
    throw e;
  }
}

/** Cancels now, not at the end of the period (used when a refund ends the term). */
export async function cancelSubscriptionNow(env: Env, subscriptionId: string): Promise<void> {
  await call(env, 'POST', `/subscriptions/${seg(subscriptionId)}/cancel`, { effective_from: 'immediately' });
}

/**
 * An authenticated link to Paddle's customer portal (payment method,
 * invoices, cancellation). Short-lived: create one per click, never cache.
 */
export async function createPortalSession(
  env: Env,
  paddleCustomerId: string,
  subscriptionIds: string[],
): Promise<string> {
  const data = await call<{ urls: { general: { overview: string } } }>(
    env,
    'POST',
    `/customers/${seg(paddleCustomerId)}/portal-sessions`,
    { subscription_ids: subscriptionIds.slice(0, 25) },
  );
  return data.urls.general.overview;
}
