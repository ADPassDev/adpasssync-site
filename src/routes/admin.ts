// Admin routes. Mounted under requireAdmin middleware in src/index.ts —
// every handler here can assume c.get('customer') is an admin.

import { Hono } from 'hono';
import type { Env, License, LicenseTier, Variables } from '../types';
import {
  clearInstallation,
  findCustomerById,
  findPurchaseById,
  getActiveLicenseForCustomer,
  getEntitlement,
  listAllCustomers,
  listDownloadsForCustomer,
  listPurchases,
  markPurchasePaid,
  setEntitlement,
  updatePurchaseStatus,
} from '../lib/db';
import type { PurchaseStatus } from '../lib/db';
import { FREE_TIER_MAX_USERS, effectiveEntitlement, entitlementForPurchase } from '../lib/license';
import { applyEntitlementChange } from '../lib/entitlement-effects';
import { getHashDbKey } from '../lib/hashdb-key';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// Latest expiry Go's time.Time can marshal (9999-12-31T23:59:59Z).
const MAX_EXPIRES_AT = 253402300799;

// POST /api/admin/entitlement
// Body: { customer_id, tier, max_users, expires_at?: unix-seconds | null }
// Sets what the customer is licensed for. If they have registered an
// installation, a license file for it is issued right away; otherwise one is
// issued when they register. max_users 0 means unlimited (paid tiers only).
admin.post('/entitlement', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { customer_id, tier, max_users, expires_at } = (body ?? {}) as {
    customer_id?: unknown;
    tier?: unknown;
    max_users?: unknown;
    expires_at?: unknown;
  };

  if (typeof customer_id !== 'string' || !customer_id) {
    return c.json({ error: 'customer_id_required' }, 400);
  }
  if (tier !== 'free' && tier !== 'professional' && tier !== 'enterprise') {
    return c.json({ error: 'invalid_tier' }, 400);
  }
  const max = Number(max_users);
  if (!Number.isInteger(max) || max < 0 || max > 1_000_000 || (max === 0 && tier === 'free')) {
    return c.json({ error: 'invalid_max_users' }, 400);
  }
  let expSeconds: number | null = null;
  if (expires_at !== undefined && expires_at !== null) {
    const n = Number(expires_at);
    if (!Number.isFinite(n) || n < 0 || n > MAX_EXPIRES_AT) {
      return c.json({ error: 'invalid_expires_at' }, 400);
    }
    expSeconds = Math.floor(n);
  }

  const customer = await findCustomerById(c.env.DB, customer_id);
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);

  const adminEmail = c.get('customer')!.email;
  await setEntitlement(c.env.DB, customer.id, {
    tier: tier as LicenseTier,
    max_users: tier === 'free' ? FREE_TIER_MAX_USERS : max,
    expires_at: tier === 'free' ? null : expSeconds,
    source: `admin:${adminEmail}`,
  });

  const { license, licenseError } = await applyEntitlementChange(c.env, c.executionCtx, customer, {
    notify: false,
  });
  if (licenseError) return c.json({ error: 'sign_failed', detail: licenseError }, 500);
  const entitlement = await getEntitlement(c.env.DB, customer.id);
  return c.json({
    ok: true,
    entitlement,
    effective: effectiveEntitlement(entitlement),
    license: license && licenseSummary(license),
  });
});

// POST /api/admin/customer/:id/installation/reset
// Unbinds the customer's installation and revokes its license files, so they
// can register a different one (e.g. after moving to a new server). This is
// deliberately admin-only: the old installation keeps its license file and,
// being offline, keeps working until that license expires.
admin.post('/customer/:id/installation/reset', async (c) => {
  const customer = await findCustomerById(c.env.DB, c.req.param('id'));
  if (!customer) return c.json({ error: 'not_found' }, 404);
  await clearInstallation(c.env.DB, customer.id);
  return c.json({ ok: true, previous_install_id: customer.install_id });
});

// GET /api/admin/customers
admin.get('/customers', async (c) => {
  const customers = await listAllCustomers(c.env.DB);
  return c.json({ customers });
});

// GET /api/admin/customer/:id
admin.get('/customer/:id', async (c) => {
  const id = c.req.param('id');
  const customer = await findCustomerById(c.env.DB, id);
  if (!customer) return c.json({ error: 'not_found' }, 404);
  const entitlement = await getEntitlement(c.env.DB, id);
  const license = await getActiveLicenseForCustomer(c.env.DB, id);
  const downloads = await listDownloadsForCustomer(c.env.DB, id, 50);
  const subscriptions = await c.env.DB.prepare(
    'SELECT * FROM paddle_subscriptions WHERE customer_id = ?1 ORDER BY created_at DESC',
  )
    .bind(id)
    .all();
  return c.json({
    customer,
    entitlement,
    effective: effectiveEntitlement(entitlement),
    license,
    subscriptions: subscriptions.results ?? [],
    hashdb_key: await getHashDbKey(c.env, id),
    downloads,
  });
});

// GET /api/admin/purchases?status=pending|paid|cancelled
// Returns purchase rows joined with customer email/name/company.
admin.get('/purchases', async (c) => {
  const status = c.req.query('status');
  let filter: PurchaseStatus | null = null;
  if (status !== undefined && status !== '') {
    if (status !== 'pending' && status !== 'paid' && status !== 'cancelled') {
      return c.json({ error: 'invalid_status' }, 400);
    }
    filter = status;
  }
  const purchases = await listPurchases(c.env.DB, filter);
  return c.json({ purchases });
});

// POST /api/admin/purchase/:id/status   { status: "paid" | "cancelled" | "pending" }
// Marking a purchase paid grants it: the customer's entitlement becomes the
// purchase's tier and user count for a year, a license file is issued for
// their registered installation (if any), and they're emailed. This is the
// one place a payment turns into a license, so a payment webhook can call
// the same path later. Moving a purchase away from paid doesn't take the
// entitlement back; set it on the customer instead.
admin.post('/purchase/:id/status', async (c) => {
  const id = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const next = (body as { status?: unknown })?.status;
  if (next !== 'pending' && next !== 'paid' && next !== 'cancelled') {
    return c.json({ error: 'invalid_status' }, 400);
  }
  const purchase = await findPurchaseById(c.env.DB, id);
  if (!purchase) return c.json({ error: 'not_found' }, 404);

  if (next !== 'paid' || purchase.status === 'paid') {
    await updatePurchaseStatus(c.env.DB, id, next);
    return c.json({ ok: true, id, status: next });
  }

  const customer = await findCustomerById(c.env.DB, purchase.customer_id);
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);
  const current = await getEntitlement(c.env.DB, customer.id);
  // A purchase that was paid, un-marked and marked paid again must not add
  // a second year.
  const grant = current?.source === `purchase:${purchase.id}` ? null : entitlementForPurchase(purchase, current);
  await markPurchasePaid(c.env.DB, purchase, grant);
  if (!grant) return c.json({ ok: true, id, status: 'paid', entitlement: current });

  const { license } = await applyEntitlementChange(c.env, c.executionCtx, customer, { notify: true });
  return c.json({
    ok: true,
    id,
    status: 'paid',
    entitlement: effectiveEntitlement(await getEntitlement(c.env.DB, customer.id)),
    license: license && licenseSummary(license),
  });
});

function licenseSummary(l: License) {
  return {
    id: l.id,
    install_id: l.install_id,
    tier: l.tier,
    max_users: l.max_users,
    issued_at: l.issued_at,
    expires_at: l.expires_at,
  };
}

export default admin;
