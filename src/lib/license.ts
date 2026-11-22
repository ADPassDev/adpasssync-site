// License issuance: signed license files in the product's own format (see
// product-license.ts), bound to the Install ID the customer registered.
//
// The model: the free tier (50 AD users) is built into the product and needs
// no file. A customer registers their installation's Install ID in the portal
// (the product's License page links there with it filled in); from then on,
// every change to what they're entitled to (a purchase marked paid, an admin
// edit) issues a new license file for that installation automatically.

import type { Customer, Entitlement, Env, License, LicenseTier } from '../types';
import {
  FREE_TIER_MAX_USERS,
  NO_EXPIRY,
  canonicalProductLicense,
  rfc3339,
  type ProductLicense,
  type ProductTier,
} from './product-license';
import { importRsaPrivateKey, importRsaPublicKey, rsaSign, rsaVerify, uuidv4 } from './crypto';
import { insertLicenseRevokingOthers, nowSeconds } from './db';

export { FREE_TIER_MAX_USERS };

/** Install IDs are what the product's uuid.New().String() writes. */
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lower-cased Install ID, or null if it isn't one. */
export function normalizeInstallId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return INSTALL_ID_RE.test(id) ? id : null;
}

export type EffectiveEntitlement = {
  tier: LicenseTier;
  max_users: number;
  expires_at: number | null;
};

/** The entitlement in force: a paid one until it expires, otherwise the free tier. */
export function effectiveEntitlement(
  e: Pick<Entitlement, 'tier' | 'max_users' | 'expires_at'> | null,
  now = nowSeconds(),
): EffectiveEntitlement {
  if (e && e.tier !== 'free' && (e.expires_at === null || e.expires_at > now)) {
    return { tier: e.tier, max_users: e.max_users, expires_at: e.expires_at };
  }
  return { tier: 'free', max_users: FREE_TIER_MAX_USERS, expires_at: null };
}

/** The product has one paid tier; Professional and Enterprise both map to it. */
export function productTier(tier: LicenseTier): ProductTier {
  return tier === 'free' ? 'free' : 'paid';
}

/** The name the product shows as "Customer" on its License page. */
export function licenseCustomerName(c: Pick<Customer, 'company' | 'name' | 'email'>): string {
  return c.company?.trim() || c.name?.trim() || c.email;
}

/**
 * Signs a license for `installId` carrying the customer's effective
 * entitlement, stores it, and revokes the customer's earlier licenses (in the
 * same transaction), so the newest file is the only one the portal offers.
 */
export async function issueLicense(
  env: Env,
  args: { customer: Customer; installId: string; entitlement: Entitlement | null },
): Promise<License> {
  if (!env.LICENSE_PRIVATE_KEY || !env.LICENSE_PUBLIC_KEY) {
    throw new Error(
      'LICENSE_PRIVATE_KEY and LICENSE_PUBLIC_KEY must both be set. Run `npm run keys:generate` ' +
        'and add them with `wrangler secret put`.',
    );
  }
  const ent = effectiveEntitlement(args.entitlement);
  const issuedAt = nowSeconds();
  const payload: ProductLicense = {
    install_id: args.installId,
    customer_name: licenseCustomerName(args.customer).toWellFormed(),
    customer_email: args.customer.email.toWellFormed(),
    max_users: ent.max_users,
    tier: productTier(ent.tier),
    issued_at: rfc3339(issuedAt),
    expires_at: ent.expires_at === null ? NO_EXPIRY : rfc3339(ent.expires_at),
  };
  const message = canonicalProductLicense(payload);
  const signature = await rsaSign(await importRsaPrivateKey(env.LICENSE_PRIVATE_KEY), message);

  // The product embeds the key this site serves at /api/public-key
  // (LICENSE_PUBLIC_KEY). Never hand out a license that key would reject.
  const publicKey = await importRsaPublicKey(env.LICENSE_PUBLIC_KEY);
  if (!(await rsaVerify(publicKey, message, signature))) {
    throw new Error(
      'LICENSE_PUBLIC_KEY does not match LICENSE_PRIVATE_KEY; refusing to issue a license the product would reject',
    );
  }

  const license: License = {
    id: uuidv4(),
    customer_id: args.customer.id,
    install_id: args.installId,
    tier: ent.tier,
    max_users: ent.max_users,
    issued_at: issuedAt,
    expires_at: ent.expires_at,
    license_json: JSON.stringify({ payload, signature }, null, 2) + '\n',
    downloaded_at: null,
    revoked_at: null,
  };
  await insertLicenseRevokingOthers(env.DB, license);
  return license;
}

/**
 * The entitlement a paid purchase grants: its tier and total user count for a
 * year, counted from the current paid term's end if that is still running (so
 * renewing early loses nothing), otherwise from now.
 */
export function entitlementForPurchase(
  purchase: { id: string; tier: LicenseTier; seats: number },
  current: Entitlement | null,
  now = nowSeconds(),
): Omit<Entitlement, 'customer_id' | 'updated_at'> {
  const running =
    current && current.tier !== 'free' && current.expires_at !== null && current.expires_at > now
      ? current.expires_at
      : now;
  return {
    tier: purchase.tier === 'free' ? 'professional' : purchase.tier,
    // Seats are total AD users; a paid license never covers fewer than free does.
    max_users: Math.max(purchase.seats, FREE_TIER_MAX_USERS),
    expires_at: addOneYear(running),
    source: `purchase:${purchase.id}`,
  };
}

function addOneYear(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}
