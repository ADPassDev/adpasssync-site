// Customer portal routes. All endpoints require an authenticated session
// (mounted under requireAuth in src/index.ts).

import { Hono } from 'hono';
import type { Customer, Entitlement, Env, License, Variables } from '../types';
import {
  loadLatestRelease,
  openLatestReleasePackage,
  releasePackageFile,
  streamReleasePackage,
  type Release,
  type ReleasePackage,
} from '../lib/release';
import {
  findCustomerById,
  getActiveLicenseForCustomer,
  getEntitlement,
  listDownloadsForCustomer,
  markLicenseDownloaded,
  recordDownload,
  recordPurchaseIntent,
  registerInstallId,
  updateCustomerProfile,
} from '../lib/db';
import {
  FREE_TIER_MAX_USERS,
  effectiveEntitlement,
  issueLicense,
  licenseCustomerName,
  normalizeInstallId,
} from '../lib/license';
import { getClientIp } from '../lib/auth';
import { sendPurchaseAlertEmail } from '../lib/email';

const portal = new Hono<{ Bindings: Env; Variables: Variables }>();

// Files the download adds to the release package. The product's License page
// asks for "the signed license.json", so that's the name.
const LICENSE_FILE = 'license.json';
const README_FILE = 'README.txt';

// GET /api/portal/dashboard
// Top-level summary: customer info, what they're licensed for, their
// registered installation and its license file, download history, and the
// release the download button currently serves.
portal.get('/dashboard', async (c) => {
  const customer = c.get('customer')!;
  const entitlement = await getEntitlement(c.env.DB, customer.id);
  const license = await currentLicense(c.env.DB, customer);
  const history = await listDownloadsForCustomer(c.env.DB, customer.id, 10);
  const release = await latestReleaseSummary(c.env);
  return c.json({
    release,
    customer: {
      id: customer.id,
      email: customer.email,
      name: customer.name,
      company: customer.company,
      install_id: customer.install_id,
    },
    entitlement: entitlementView(entitlement),
    license: license && licenseView(license),
    license_customer_name: licenseCustomerName(customer),
    downloads: history.map((d) => ({
      downloaded_at: d.downloaded_at,
      version: d.version,
      ip_address: d.ip_address,
    })),
  });
});

// GET /api/portal/license
// Licensing status only (lighter payload than /dashboard).
portal.get('/license', async (c) => {
  const customer = c.get('customer')!;
  const license = await currentLicense(c.env.DB, customer);
  return c.json({
    install_id: customer.install_id,
    entitlement: entitlementView(await getEntitlement(c.env.DB, customer.id)),
    license: license && licenseView(license),
  });
});

// POST /api/portal/installation   { install_id }
// Registers the Install ID that ADPassSync generated on first run (shown on
// its License page, which links here with it filled in) and issues a license
// file for it. One installation per account: a different one can only be
// registered after an admin resets the current one, so a purchase can't be
// spread across sites. Re-registering the same ID is a no-op that makes sure
// a current license exists.
portal.post('/installation', async (c) => {
  const customer = c.get('customer')!;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const installId = normalizeInstallId((body as { install_id?: unknown } | null)?.install_id);
  if (!installId) return c.json({ error: 'invalid_install_id' }, 400);

  const result = await registerInstallId(c.env.DB, customer.id, installId);
  if (result.status === 'taken') {
    return c.json({ error: 'install_id_registered_elsewhere' }, 409);
  }
  if (result.status === 'account_has_other') {
    return c.json({ error: 'account_has_installation', install_id: result.install_id }, 409);
  }
  customer.install_id = installId;

  let license = await currentLicense(c.env.DB, customer);
  if (!license) {
    try {
      license = await issueLicense(c.env, {
        customer,
        installId,
        entitlement: await getEntitlement(c.env.DB, customer.id),
      });
    } catch (e) {
      console.error('issueLicense failed', e);
      return c.json({ error: 'license_unavailable' }, 500);
    }
  }
  return c.json({
    ok: true,
    registered: result.status === 'registered',
    install_id: installId,
    license: licenseView(license),
  });
});

// GET /api/portal/license.json
// The current license file for the registered installation, as a download.
portal.get('/license.json', async (c) => {
  const customer = c.get('customer')!;
  const license = await currentLicense(c.env.DB, customer);
  if (!license) return c.json({ error: 'no_license' }, 404);
  c.executionCtx.waitUntil(
    markLicenseDownloaded(c.env.DB, license.id).catch((err) =>
      console.error('markLicenseDownloaded failed', err),
    ),
  );
  return new Response(license.license_json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${LICENSE_FILE}"`,
      'Cache-Control': 'no-store',
    },
  });
});

// POST /api/portal/profile
// Update the signed-in customer's display name and/or company.
// Empty / missing fields are ignored (the existing value is kept).
portal.post('/profile', async (c) => {
  const customer = c.get('customer')!;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { name, company } = (body ?? {}) as { name?: unknown; company?: unknown };

  const cleanName = normalizeProfileField(name);
  const cleanCompany = normalizeProfileField(company);
  if (cleanName === 'invalid' || cleanCompany === 'invalid') {
    return c.json({ error: 'invalid_field' }, 400);
  }

  await updateCustomerProfile(c.env.DB, customer.id, {
    name: cleanName ?? null,
    company: cleanCompany ?? null,
  });

  // Re-read so the response reflects the actual stored state.
  const updated = await findCustomerById(c.env.DB, customer.id);
  return c.json({
    ok: true,
    customer: updated && {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      company: updated.company,
      install_id: updated.install_id,
    },
  });
});

/** Returns the trimmed string, undefined for "no change", or 'invalid' on bad input. */
function normalizeProfileField(v: unknown): string | undefined | 'invalid' {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return 'invalid';
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > 200) return 'invalid';
  return trimmed;
}

// GET /api/portal/download
// Streams the current release package (the zip that latest.json names in
// the releases bucket: both MSIs, both guides, SHA256SUMS.txt) with a
// README.txt added, plus license.json if the customer has registered an
// installation. Fails with 503 if the release can't be read. Records the
// download, with the release version, for audit.
portal.get('/download', async (c) => {
  const customer = c.get('customer')!;
  const env = c.env;

  // 1. Open the release package first, so a broken release fails before
  //    anything is recorded.
  let pkg: ReleasePackage;
  try {
    pkg = await openLatestReleasePackage(env);
  } catch (e) {
    console.error('release package unavailable', e);
    return c.json({ error: 'release_unavailable' }, 503);
  }
  const version = pkg.release.version;

  // 2. Nothing is issued here: the product generates its Install ID when it
  //    is installed, and the license follows from registering that ID. A
  //    customer who has already registered gets their current license file
  //    in the ZIP too, which saves a step when upgrading.
  const license = await currentLicense(env.DB, customer);

  // 3. Stream the package with the README (and license) appended. The
  //    package's own entries pass through byte-for-byte.
  const added = new Set([LICENSE_FILE, README_FILE].map((n) => n.toLowerCase()));
  const releaseFiles = pkg.records.map((r) => r.name).filter((n) => !added.has(n.toLowerCase()));
  const readme = readmeText({ customer, license, release: pkg.release, releaseFiles });
  let body: ReadableStream<Uint8Array>;
  try {
    body = await streamReleasePackage(
      env,
      c.executionCtx,
      pkg,
      [
        ...(license ? [{ name: LICENSE_FILE, data: license.license_json }] : []),
        { name: README_FILE, data: readme },
      ],
      new Date(),
    );
  } catch (e) {
    console.error('release package stream failed', e);
    return c.json({ error: 'release_unavailable' }, 503);
  }

  // 4. Audit + bookkeeping. Don't block the response on the writes.
  c.executionCtx.waitUntil(
    Promise.all([
      license ? markLicenseDownloaded(env.DB, license.id) : null,
      recordDownload(env.DB, {
        customerId: customer.id,
        licenseId: license?.id ?? null,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('User-Agent') ?? null,
        version,
      }),
    ]).catch((err) => console.error('download bookkeeping failed', err)),
  );

  // Content-Length comes from the FixedLengthStream behind `body`.
  const filename = `ADPassSync-${version}-${customer.id.slice(0, 8)}.zip`;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
});

// POST /api/portal/purchase
// Records a purchase intent. Stripe wiring lands later.
portal.post('/purchase', async (c) => {
  const customer = c.get('customer')!;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { tier, seats, notes } = (body ?? {}) as {
    tier?: unknown;
    seats?: unknown;
    notes?: unknown;
  };
  if (tier !== 'free' && tier !== 'professional' && tier !== 'enterprise') {
    return c.json({ error: 'invalid_tier' }, 400);
  }
  const seatsNum = Number(seats);
  if (!Number.isFinite(seatsNum) || seatsNum < 1 || seatsNum > 1_000_000) {
    return c.json({ error: 'invalid_seats' }, 400);
  }
  const purchase = await recordPurchaseIntent(c.env.DB, {
    customerId: customer.id,
    tier,
    seats: Math.floor(seatsNum),
    notes: typeof notes === 'string' ? notes.slice(0, 2000) : null,
  });

  // Notify admins out-of-band. Failures here must not bubble up to the
  // submitter — the row is already persisted and the admin UI surfaces it.
  c.executionCtx.waitUntil(
    sendPurchaseAlertEmail(c.env, purchase, customer).catch((err) =>
      console.error('purchase alert email failed', err),
    ),
  );

  return c.json({ ok: true, purchase });
});

/** What the dashboard shows about the current release; null if it can't be read. */
async function latestReleaseSummary(
  env: Env,
): Promise<{ version: string; released_at: string | null; package_size: number | null } | null> {
  try {
    const release = await loadLatestRelease(env);
    return {
      version: release.version,
      released_at: release.released_at,
      package_size: releasePackageFile(release).size,
    };
  } catch (e) {
    console.error('dashboard: release manifest unavailable', e);
    return null;
  }
}

/** The customer's current license file, if it is for their registered installation. */
async function currentLicense(db: D1Database, customer: Customer): Promise<License | null> {
  if (!customer.install_id) return null;
  const license = await getActiveLicenseForCustomer(db, customer.id);
  return license && license.install_id === customer.install_id ? license : null;
}

function licenseView(l: License) {
  return {
    id: l.id,
    install_id: l.install_id,
    tier: l.tier,
    max_users: l.max_users,
    issued_at: l.issued_at,
    expires_at: l.expires_at,
    downloaded_at: l.downloaded_at,
  };
}

/** The entitlement in force, plus the paid term that ended, if that's why it's free. */
function entitlementView(e: Entitlement | null) {
  const eff = effectiveEntitlement(e);
  return {
    ...eff,
    lapsed:
      e && e.tier !== 'free' && eff.tier === 'free'
        ? { tier: e.tier, max_users: e.max_users, expired_at: e.expires_at }
        : null,
  };
}

function readmeText(args: {
  customer: Customer;
  license: License | null;
  release: Release;
  releaseFiles: string[];
}): string {
  const { customer, license } = args;
  const title = `ADPassSync ${args.release.version}`;
  const released = args.release.released_at?.slice(0, 10) ?? null;
  const hasSums = args.releaseFiles.includes('SHA256SUMS.txt');
  const credProv = args.releaseFiles.find((n) => /^ADPassCredProv.*\.msi$/i.test(n));
  return [
    title,
    '='.repeat(title.length),
    '',
    `Account:  ${customer.email}`,
    released ? `Released: ${released}` : null,
    '',
    'Contents',
    '--------',
    'The complete release package:',
    '',
    ...args.releaseFiles.map((n) => `  ${n}`),
    '',
    ...(license
      ? [
          'plus two files for your account:',
          '',
          `  ${LICENSE_FILE.padEnd(12)}  your license: ${describeLicense(license)}`,
          `  ${''.padEnd(12)}  for the installation with Install ID ${license.install_id}`,
          `  ${README_FILE.padEnd(12)}  this file`,
        ]
      : ['plus this README.txt.']),
    ...(hasSums
      ? [
          '',
          'SHA256SUMS.txt covers the release files only. Verify with',
          '"sha256sum -c SHA256SUMS.txt", or compare each line against',
          'Get-FileHash in PowerShell.',
        ]
      : []),
    '',
    'Getting started',
    '---------------',
    'Start with the Quick Start Guide. The Administrator Guide covers',
    'deployment, configuration and licensing in full. To watch a complete',
    'installation first (about five minutes): https://adpasssync.com/support/',
    ...(credProv
      ? [
          '',
          'Credential provider (optional)',
          '------------------------------',
          `${credProv} adds the ADPassSync tiles to the`,
          'Ctrl+Alt+Del change-password screen and the logon screen, so users see',
          'the live policy rules and the reason a password was rejected. Install it',
          'on workstations and member servers; it is not needed on the Domain',
          'Controller, and the rest of the product works without it.',
          '',
          'Deploy it by Group Policy software installation or your usual endpoint',
          'management tool. A reboot is required before the tiles appear.',
        ]
      : []),
    '',
    'Licensing',
    '---------',
    `Up to ${FREE_TIER_MAX_USERS} Active Directory users are free and need no license file.`,
    '',
    ...(license
      ? [
          `Upload ${LICENSE_FILE} on the License page of the ADPassSync admin console.`,
          'It only works on the installation with the Install ID above.',
        ]
      : [
          'To license more users, open the License page in the ADPassSync admin',
          'console and click "Get a license". That opens your portal with the',
          "installation's Install ID filled in (or enter the Install ID shown",
          `there on your portal dashboard). Register it, then upload the ${LICENSE_FILE}`,
          'you get on the same License page.',
        ]),
    '',
    'Need help? https://adpasssync.com/#contact',
    '',
  ]
    .filter((s) => s !== null)
    .join('\r\n');
}

function describeLicense(l: License): string {
  const tier = l.tier.charAt(0).toUpperCase() + l.tier.slice(1);
  const users = l.max_users === 0 ? 'unlimited AD users' : `${l.max_users} AD users`;
  const until = l.expires_at ? `, until ${new Date(l.expires_at * 1000).toISOString().slice(0, 10)}` : '';
  return `${tier}, ${users}${until},`;
}

export default portal;
