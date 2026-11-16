// Customer portal routes. All endpoints require an authenticated session
// (mounted under requireAuth in src/index.ts).

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
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
  listDownloadsForCustomer,
  markLicenseDownloaded,
  recordDownload,
  recordPurchaseIntent,
  setCustomerInstallId,
  updateCustomerProfile,
} from '../lib/db';
import { uuidv4 } from '../lib/crypto';
import { freeTierDefaults, issueLicense } from '../lib/license';
import { getClientIp } from '../lib/auth';
import { sendPurchaseAlertEmail } from '../lib/email';

const portal = new Hono<{ Bindings: Env; Variables: Variables }>();

// Files the download adds to the release package.
const LICENSE_FILE = 'license-key.txt';
const README_FILE = 'README.txt';

// GET /api/portal/dashboard
// Top-level summary: customer info, license, download history, and the
// release the download button currently serves.
portal.get('/dashboard', async (c) => {
  const customer = c.get('customer')!;
  const license = await getActiveLicenseForCustomer(c.env.DB, customer.id);
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
    license: license
      ? {
          id: license.id,
          tier: license.tier,
          max_users: license.max_users,
          issued_at: license.issued_at,
          expires_at: license.expires_at,
          downloaded_at: license.downloaded_at,
        }
      : null,
    downloads: history.map((d) => ({
      downloaded_at: d.downloaded_at,
      version: d.version,
      ip_address: d.ip_address,
    })),
  });
});

// GET /api/portal/license
// License status only (lighter payload than /dashboard).
portal.get('/license', async (c) => {
  const customer = c.get('customer')!;
  const license = await getActiveLicenseForCustomer(c.env.DB, customer.id);
  if (!license) return c.json({ has_license: false });
  return c.json({
    has_license: true,
    license: {
      id: license.id,
      install_id: license.install_id,
      tier: license.tier,
      max_users: license.max_users,
      issued_at: license.issued_at,
      expires_at: license.expires_at,
      downloaded_at: license.downloaded_at,
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
// the releases bucket: both MSIs, both guides, SHA256SUMS.txt) with the
// customer's license-key.txt and a README.txt added.
//   - Fails with 503, before touching the account, if the release can't be read.
//   - On first call, allocates a UUID install_id for the customer.
//   - On first call without a license, auto-issues a Free-tier license.
//   - Records the download, with the release version, for audit.
portal.get('/download', async (c) => {
  const customer = c.get('customer')!;
  const env = c.env;

  // 1. Open the release package first, so a missing or broken release never
  //    allocates an install ID or issues a license for a download that fails.
  let pkg: ReleasePackage;
  try {
    pkg = await openLatestReleasePackage(env);
  } catch (e) {
    console.error('release package unavailable', e);
    return c.json({ error: 'release_unavailable' }, 503);
  }
  const version = pkg.release.version;

  // 2. Ensure install_id (one-shot allocation, persisted).
  let installId = customer.install_id;
  if (!installId) {
    installId = uuidv4();
    await setCustomerInstallId(env.DB, customer.id, installId);
    customer.install_id = installId;
  }

  // 3. Ensure an active license. Default to Free tier if none.
  let license = await getActiveLicenseForCustomer(env.DB, customer.id);
  if (!license) {
    const def = freeTierDefaults();
    try {
      license = await issueLicense(env, {
        customer,
        installId,
        tier: def.tier,
        maxUsers: def.maxUsers,
        expiresAt: def.expiresAt,
      });
    } catch (e) {
      console.error('issueLicense failed', e);
      return c.json(
        { error: 'license_unavailable', detail: String(e) },
        500,
      );
    }
  }

  // 4. Stream the package with the license and README appended. The
  //    package's own entries pass through byte-for-byte.
  const added = new Set([LICENSE_FILE, README_FILE].map((n) => n.toLowerCase()));
  const releaseFiles = pkg.records.map((r) => r.name).filter((n) => !added.has(n.toLowerCase()));
  let body: ReadableStream<Uint8Array>;
  try {
    body = await streamReleasePackage(
      env,
      c.executionCtx,
      pkg,
      [
        { name: LICENSE_FILE, data: license.license_json },
        {
          name: README_FILE,
          data: readmeText({ email: customer.email, installId, release: pkg.release, releaseFiles }),
        },
      ],
      new Date(),
    );
  } catch (e) {
    console.error('release package stream failed', e);
    return c.json({ error: 'release_unavailable' }, 503);
  }

  // 5. Audit + bookkeeping. Don't block the response on the writes.
  c.executionCtx.waitUntil(
    Promise.all([
      markLicenseDownloaded(env.DB, license.id),
      recordDownload(env.DB, {
        customerId: customer.id,
        licenseId: license.id,
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

function readmeText(args: {
  email: string;
  installId: string;
  release: Release;
  releaseFiles: string[];
}): string {
  const title = `ADPassSync ${args.release.version}`;
  const released = args.release.released_at?.slice(0, 10) ?? null;
  const hasSums = args.releaseFiles.includes('SHA256SUMS.txt');
  const credProv = args.releaseFiles.find((n) => /^ADPassCredProv.*\.msi$/i.test(n));
  return [
    title,
    '='.repeat(title.length),
    '',
    `Account:    ${args.email}`,
    `Install ID: ${args.installId}`,
    released ? `Released:   ${released}` : null,
    '',
    'Contents',
    '--------',
    'The complete release package:',
    '',
    ...args.releaseFiles.map((n) => `  ${n}`),
    '',
    'plus two files added for your account:',
    '',
    `  ${LICENSE_FILE.padEnd(15)}  your signed license, bound to the Install ID above`,
    `  ${README_FILE.padEnd(15)}  this file`,
    ...(hasSums
      ? [
          '',
          'SHA256SUMS.txt covers the release files, not the two added ones. Verify',
          'with "sha256sum -c SHA256SUMS.txt", or compare each line against',
          'Get-FileHash in PowerShell.',
        ]
      : []),
    '',
    'Getting started',
    '---------------',
    'Start with the Quick Start Guide. The Administrator Guide covers',
    'deployment, configuration and licensing in full.',
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
    'Need help? https://adpasssync.com/#contact',
    '',
  ]
    .filter((s) => s !== null)
    .join('\r\n');
}

export default portal;
