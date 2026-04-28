// License envelope construction and signing.

import type {
  Customer,
  Env,
  License,
  LicensePayload,
  LicenseTier,
  SignedLicense,
} from '../types';
import { importRsaPrivateKey, rsaSign, uuidv4 } from './crypto';
import { insertLicense, nowSeconds } from './db';

export const FREE_TIER_MAX_USERS = 50;

/** Stable JSON serialization — sorted keys so signatures are deterministic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ':' + canonicalJson(obj[k]));
  }
  return '{' + parts.join(',') + '}';
}

export type IssueLicenseArgs = {
  customer: Customer;
  installId: string;
  tier: LicenseTier;
  maxUsers: number;
  /** unix seconds; null = perpetual */
  expiresAt: number | null;
};

export async function issueLicense(
  env: Env,
  args: IssueLicenseArgs,
): Promise<License> {
  if (!env.LICENSE_PRIVATE_KEY) {
    throw new Error(
      'LICENSE_PRIVATE_KEY is not configured. Run `npm run keys:generate` ' +
        'and add the private key with `wrangler secret put LICENSE_PRIVATE_KEY`.',
    );
  }
  const licenseId = uuidv4();
  const issuedAt = nowSeconds();
  const payload: LicensePayload = {
    v: 1,
    license_id: licenseId,
    install_id: args.installId,
    customer_id: args.customer.id,
    email: args.customer.email,
    company: args.customer.company,
    tier: args.tier,
    max_users: args.maxUsers,
    issued_at: issuedAt,
    expires_at: args.expiresAt,
  };
  const message = canonicalJson(payload);
  const privateKey = await importRsaPrivateKey(env.LICENSE_PRIVATE_KEY);
  const signature = await rsaSign(privateKey, message);

  const signed: SignedLicense = {
    payload,
    signature,
    alg: 'RS256',
    kid: 'v1',
  };
  const licenseJson = JSON.stringify(signed, null, 2);

  const license: License = {
    id: licenseId,
    customer_id: args.customer.id,
    install_id: args.installId,
    tier: args.tier,
    max_users: args.maxUsers,
    issued_at: issuedAt,
    expires_at: args.expiresAt,
    license_json: licenseJson,
    downloaded_at: null,
    revoked_at: null,
  };
  await insertLicense(env.DB, {
    id: license.id,
    customer_id: license.customer_id,
    install_id: license.install_id,
    tier: license.tier,
    max_users: license.max_users,
    issued_at: license.issued_at,
    expires_at: license.expires_at,
    license_json: license.license_json,
  });
  return license;
}

/** Default license parameters for the free tier (up to 50 AD users, perpetual). */
export function freeTierDefaults(): { tier: LicenseTier; maxUsers: number; expiresAt: null } {
  return { tier: 'free', maxUsers: FREE_TIER_MAX_USERS, expiresAt: null };
}
