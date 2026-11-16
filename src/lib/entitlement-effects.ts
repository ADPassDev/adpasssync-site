// What follows a change to a customer's entitlement, wherever it came from (a
// Paddle webhook, an admin edit, a quote request marked paid): a new license
// file for their registered installation, their full bloom filter key brought
// in line, and, if asked, an email saying the license is ready.

import type { Customer, Env, License } from '../types';
import { getEntitlement } from './db';
import { effectiveEntitlement, issueLicense } from './license';
import { syncHashDbKey } from './hashdb-key';
import { sendLicenseReadyEmail } from './email';

export async function applyEntitlementChange(
  env: Env,
  ctx: ExecutionContext,
  customer: Customer,
  opts: { notify: boolean },
): Promise<{ license: License | null; licenseError: string | null }> {
  const entitlement = await getEntitlement(env.DB, customer.id);
  const effective = effectiveEntitlement(entitlement);

  let license: License | null = null;
  let licenseError: string | null = null;
  if (customer.install_id) {
    try {
      license = await issueLicense(env, { customer, installId: customer.install_id, entitlement });
    } catch (e) {
      // The entitlement is recorded; the license is issued on the customer's
      // next registration or the next change.
      licenseError = String(e);
      console.error('license issue after entitlement change failed', customer.id, e);
    }
  }

  try {
    await syncHashDbKey(env, customer, effective);
  } catch (e) {
    console.error('full bloom filter key sync failed', customer.id, e);
  }

  if (opts.notify && effective.tier !== 'free') {
    ctx.waitUntil(
      sendLicenseReadyEmail(env, customer, effective, license !== null).catch((err) =>
        console.error('license email failed', err),
      ),
    );
  }
  return { license, licenseError };
}
