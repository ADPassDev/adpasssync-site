// Customer portal routes. All endpoints require an authenticated session
// (mounted under requireAuth in src/index.ts).

import { Hono } from 'hono';
import type { Env, Variables } from '../types';
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
import { buildZip } from '../lib/zip';
import { sendPurchaseAlertEmail } from '../lib/email';

const portal = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/portal/dashboard
// Top-level summary: customer info, license, download history.
portal.get('/dashboard', async (c) => {
  const customer = c.get('customer')!;
  const license = await getActiveLicenseForCustomer(c.env.DB, customer.id);
  const history = await listDownloadsForCustomer(c.env.DB, customer.id, 10);
  return c.json({
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
// Streams a ZIP containing the MSI installer and license-key.txt.
//   - On first call, allocates a UUID install_id for the customer.
//   - On first call without a license, auto-issues a Free-tier license.
//   - Records the download for audit.
portal.get('/download', async (c) => {
  const customer = c.get('customer')!;
  const env = c.env;

  // 1. Ensure install_id (one-shot allocation, persisted).
  let installId = customer.install_id;
  if (!installId) {
    installId = uuidv4();
    await setCustomerInstallId(env.DB, customer.id, installId);
    customer.install_id = installId;
  }

  // 2. Ensure an active license. Default to Free tier if none.
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

  // 3. Pull the installers from R2. The credential provider is a separate,
  //    optional package for workstations — if it hasn't been published yet the
  //    ZIP ships without it rather than failing the whole download.
  const [obj, credProvObj] = await Promise.all([
    env.INSTALLER_BUCKET.get(env.INSTALLER_OBJECT_KEY),
    env.INSTALLER_BUCKET.get(env.CREDPROV_OBJECT_KEY).catch((e) => {
      console.error('credprov fetch failed', e);
      return null;
    }),
  ]);
  if (!obj) {
    return c.json(
      { error: 'installer_missing', detail: `no R2 object at ${env.INSTALLER_OBJECT_KEY}` },
      503,
    );
  }
  const msiBytes = new Uint8Array(await obj.arrayBuffer());
  const version = obj.customMetadata?.version ?? null;

  if (!credProvObj) {
    console.warn(`credprov installer missing at ${env.CREDPROV_OBJECT_KEY}`);
  }
  const credProv = credProvObj
    ? {
        bytes: new Uint8Array(await credProvObj.arrayBuffer()),
        version: credProvObj.customMetadata?.version ?? null,
      }
    : null;

  // 4. Build the ZIP. The license file ships as JSON so the agent can
  //    verify the signature with the bundled public key.
  const zipBytes = buildZip([
    { name: 'ADPassSync-Setup.msi', data: msiBytes },
    ...(credProv ? [{ name: 'ADPassCredProv.msi', data: credProv.bytes }] : []),
    { name: 'license-key.txt', data: license.license_json },
    {
      name: 'README.txt',
      data: readmeText({
        email: customer.email,
        installId,
        version,
        credProvVersion: credProv ? credProv.version : null,
        hasCredProv: credProv !== null,
      }),
    },
  ]);

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

  const filename = `ADPassSync-${customer.id.slice(0, 8)}.zip`;
  return new Response(zipBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(zipBytes.byteLength),
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

function readmeText(opts: {
  email: string;
  installId: string;
  version: string | null;
  credProvVersion: string | null;
  hasCredProv: boolean;
}): string {
  const { email, installId, version, credProvVersion, hasCredProv } = opts;
  return [
    'ADPassSync',
    '==========',
    '',
    `Account:    ${email}`,
    `Install ID: ${installId}`,
    version ? `Version:    ${version}` : null,
    hasCredProv && credProvVersion ? `Cred. prov: ${credProvVersion}` : null,
    '',
    'Contents',
    '--------',
    'ADPassSync-Setup.msi  server package (service, password filter, portal)',
    hasCredProv
      ? 'ADPassCredProv.msi    optional Windows credential provider for'
      : null,
    hasCredProv ? '                      workstations and member servers' : null,
    'license-key.txt       signed license, bound to the Install ID above',
    '',
    'Installation',
    '------------',
    '1. Run ADPassSync-Setup.msi on a Domain Controller (or member server',
    '   running the AD PowerShell module) with administrator privileges.',
    '2. When prompted, place license-key.txt in the install directory',
    '   (typically C:\\Program Files\\ADPassSync\\).',
    '3. The service verifies the license signature on startup. The license',
    '   is bound to the Install ID above.',
    ...(hasCredProv
      ? [
          '',
          'Credential provider (optional)',
          '------------------------------',
          'ADPassCredProv.msi adds the ADPassSync tiles to the Ctrl+Alt+Del',
          'change-password screen and the logon screen, so users see the live',
          'policy rules and the reason a password was rejected. Install it on',
          'workstations and member servers; it is not needed on the Domain',
          'Controller and the rest of the product works without it.',
          '',
          'Deploy it by Group Policy software installation or your usual',
          'endpoint management tool. A reboot is required before the tiles',
          'appear.',
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
