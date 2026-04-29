// Admin routes. Mounted under requireAdmin middleware in src/index.ts —
// every handler here can assume c.get('customer') is an admin.

import { Hono } from 'hono';
import type { Env, LicenseTier, Variables } from '../types';
import {
  findCustomerById,
  getActiveLicenseForCustomer,
  listAllCustomers,
  listDownloadsForCustomer,
  listPurchases,
  setCustomerInstallId,
  updatePurchaseStatus,
} from '../lib/db';
import type { PurchaseStatus } from '../lib/db';
import { uuidv4 } from '../lib/crypto';
import { issueLicense } from '../lib/license';

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /api/admin/license/generate
// Body: { customer_id, tier, max_users, expires_at?: unix-seconds | null }
// If the target customer has no install_id yet, one is allocated.
admin.post('/license/generate', async (c) => {
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
  if (!Number.isFinite(max) || max < 1 || max > 1_000_000) {
    return c.json({ error: 'invalid_max_users' }, 400);
  }
  let expSeconds: number | null = null;
  if (expires_at !== undefined && expires_at !== null) {
    const n = Number(expires_at);
    if (!Number.isFinite(n) || n < 0) {
      return c.json({ error: 'invalid_expires_at' }, 400);
    }
    expSeconds = Math.floor(n);
  }

  const customer = await findCustomerById(c.env.DB, customer_id);
  if (!customer) return c.json({ error: 'customer_not_found' }, 404);

  let installId = customer.install_id;
  if (!installId) {
    installId = uuidv4();
    await setCustomerInstallId(c.env.DB, customer.id, installId);
  }

  try {
    const license = await issueLicense(c.env, {
      customer: { ...customer, install_id: installId },
      installId,
      tier: tier as LicenseTier,
      maxUsers: Math.floor(max),
      expiresAt: expSeconds,
    });
    return c.json({
      ok: true,
      license: {
        id: license.id,
        customer_id: license.customer_id,
        install_id: license.install_id,
        tier: license.tier,
        max_users: license.max_users,
        issued_at: license.issued_at,
        expires_at: license.expires_at,
        // license_json is large; the operator can fetch via /admin/customer/:id
      },
    });
  } catch (e) {
    return c.json({ error: 'sign_failed', detail: String(e) }, 500);
  }
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
  const license = await getActiveLicenseForCustomer(c.env.DB, id);
  const downloads = await listDownloadsForCustomer(c.env.DB, id, 50);
  return c.json({
    customer,
    license,
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
  const result = await updatePurchaseStatus(c.env.DB, id, next);
  if (!result.updated) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, id, status: next });
});

export default admin;
