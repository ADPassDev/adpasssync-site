// Keys for the full ("paid") bloom filter.
//
// The adpasssync-downloads Worker (product repo, cloudflare/worker) serves
// /downloads/paid/* only to requests carrying an X-License-Key it finds in
// its own D1 table: tier 'paid', not revoked, not expired. ADPassSync reads
// that key from %ProgramData%\ADPassSync\license.key. Each paying customer
// gets one key, created on their first paid term and kept in step with their
// entitlement afterwards: the expiry follows the paid term, and the key is
// revoked when they're back on the free tier. Renewing reactivates the same
// key, so nothing needs reconfiguring.

import type { Customer, Env } from '../types';
import type { EffectiveEntitlement } from './license';
import { randomToken } from './crypto';
import { nowSeconds } from './db';

export async function getHashDbKey(env: Env, customerId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT key FROM hashdb_keys WHERE customer_id = ?1')
    .bind(customerId)
    .first<{ key: string }>();
  return row?.key ?? null;
}

/** Brings the customer's full bloom filter key in line with their entitlement. */
export async function syncHashDbKey(
  env: Env,
  customer: Customer,
  entitlement: EffectiveEntitlement,
): Promise<string | null> {
  const keys = env.HASHDB_LICENSES;
  if (!keys) return null;
  const existing = await getHashDbKey(env, customer.id);

  if (entitlement.tier === 'free') {
    if (existing) {
      await keys.prepare('UPDATE licenses SET revoked = 1 WHERE key = ?1').bind(existing).run();
    }
    return null;
  }

  if (existing) {
    await keys
      .prepare('UPDATE licenses SET revoked = 0, expires_at = ?2, customer_email = ?3 WHERE key = ?1')
      .bind(existing, entitlement.expires_at, customer.email)
      .run();
    return existing;
  }

  // Same shape the downloads Worker's README uses: adppass_ + 32 hex digits.
  const key = `adppass_${randomToken(16)}`;
  await keys
    .prepare(
      `INSERT INTO licenses (key, customer_email, tier, issued_at, expires_at, revoked, notes)
       VALUES (?1, ?2, 'paid', ?3, ?4, 0, ?5)`,
    )
    .bind(key, customer.email, nowSeconds(), entitlement.expires_at, `adpasssync.com customer ${customer.id}`)
    .run();
  await env.DB.prepare('INSERT INTO hashdb_keys (customer_id, key) VALUES (?1, ?2)')
    .bind(customer.id, key)
    .run();
  return key;
}
