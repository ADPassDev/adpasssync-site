// Thin typed helpers around the D1 binding. Keeps SQL out of route files.

import type {
  Customer,
  Download,
  Env,
  License,
  LicenseTier,
  Purchase,
  Session,
} from '../types';
import { uuidv4 } from './crypto';

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------- Customers ----------------

export async function findCustomerByEmail(
  db: D1Database,
  email: string,
): Promise<Customer | null> {
  const row = await db
    .prepare('SELECT * FROM customers WHERE email = ?1')
    .bind(email)
    .first<Customer>();
  return row ?? null;
}

export async function findCustomerById(
  db: D1Database,
  id: string,
): Promise<Customer | null> {
  const row = await db
    .prepare('SELECT * FROM customers WHERE id = ?1')
    .bind(id)
    .first<Customer>();
  return row ?? null;
}

export async function getOrCreateCustomerByEmail(
  db: D1Database,
  email: string,
): Promise<Customer> {
  const existing = await findCustomerByEmail(db, email);
  if (existing) return existing;
  const id = uuidv4();
  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO customers (id, email, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3)`,
    )
    .bind(id, email, now)
    .run();
  return {
    id,
    email,
    name: null,
    company: null,
    install_id: null,
    created_at: now,
    updated_at: now,
  };
}

export async function updateCustomerProfile(
  db: D1Database,
  id: string,
  patch: { name?: string | null; company?: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE customers
         SET name = COALESCE(?2, name),
             company = COALESCE(?3, company),
             updated_at = ?4
       WHERE id = ?1`,
    )
    .bind(id, patch.name ?? null, patch.company ?? null, nowSeconds())
    .run();
}

export async function setCustomerInstallId(
  db: D1Database,
  customerId: string,
  installId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE customers
         SET install_id = ?2, updated_at = ?3
       WHERE id = ?1 AND install_id IS NULL`,
    )
    .bind(customerId, installId, nowSeconds())
    .run();
}

export async function listAllCustomers(db: D1Database): Promise<Customer[]> {
  const res = await db
    .prepare('SELECT * FROM customers ORDER BY created_at DESC LIMIT 1000')
    .all<Customer>();
  return res.results ?? [];
}

// ---------------- Magic links ----------------

export async function createMagicLink(
  db: D1Database,
  tokenHash: string,
  email: string,
  ttlMinutes: number,
): Promise<void> {
  const expiresAt = nowSeconds() + ttlMinutes * 60;
  await db
    .prepare(
      `INSERT INTO magic_links (token, email, expires_at) VALUES (?1, ?2, ?3)`,
    )
    .bind(tokenHash, email, expiresAt)
    .run();
}

export async function consumeMagicLink(
  db: D1Database,
  tokenHash: string,
): Promise<{ email: string } | null> {
  const now = nowSeconds();
  const row = await db
    .prepare(
      `SELECT email, expires_at, consumed_at
         FROM magic_links
        WHERE token = ?1`,
    )
    .bind(tokenHash)
    .first<{ email: string; expires_at: number; consumed_at: number | null }>();
  if (!row) return null;
  if (row.consumed_at !== null) return null;
  if (row.expires_at < now) return null;
  // Mark consumed atomically — only succeed if still unconsumed.
  const upd = await db
    .prepare(
      `UPDATE magic_links SET consumed_at = ?2
        WHERE token = ?1 AND consumed_at IS NULL`,
    )
    .bind(tokenHash, now)
    .run();
  if (!upd.meta.changes) return null;
  return { email: row.email };
}

// ---------------- Sessions ----------------

export async function createSession(
  db: D1Database,
  args: {
    customerId: string;
    tokenHash: string;
    ttlSeconds: number;
    userAgent: string | null;
    ipAddress: string | null;
  },
): Promise<Session> {
  const id = uuidv4();
  const now = nowSeconds();
  const expiresAt = now + args.ttlSeconds;
  await db
    .prepare(
      `INSERT INTO sessions
         (id, customer_id, token, expires_at, created_at, last_seen_at, user_agent, ip_address)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)`,
    )
    .bind(
      id,
      args.customerId,
      args.tokenHash,
      expiresAt,
      now,
      args.userAgent,
      args.ipAddress,
    )
    .run();
  return {
    id,
    customer_id: args.customerId,
    token_hash: args.tokenHash,
    expires_at: expiresAt,
    created_at: now,
    last_seen_at: now,
    user_agent: args.userAgent,
    ip_address: args.ipAddress,
  };
}

export async function findSessionByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<{ session: Session; customer: Customer } | null> {
  const row = await db
    .prepare(
      `SELECT s.id           AS s_id,
              s.customer_id  AS s_customer_id,
              s.token        AS s_token,
              s.expires_at   AS s_expires_at,
              s.created_at   AS s_created_at,
              s.last_seen_at AS s_last_seen_at,
              s.user_agent   AS s_user_agent,
              s.ip_address   AS s_ip_address,
              c.id           AS c_id,
              c.email        AS c_email,
              c.name         AS c_name,
              c.company      AS c_company,
              c.install_id   AS c_install_id,
              c.created_at   AS c_created_at,
              c.updated_at   AS c_updated_at
         FROM sessions s
         JOIN customers c ON c.id = s.customer_id
        WHERE s.token = ?1`,
    )
    .bind(tokenHash)
    .first<Record<string, unknown>>();
  if (!row) return null;
  if (typeof row.s_expires_at !== 'number' || row.s_expires_at < nowSeconds()) {
    return null;
  }
  return {
    session: {
      id: row.s_id as string,
      customer_id: row.s_customer_id as string,
      token_hash: row.s_token as string,
      expires_at: row.s_expires_at,
      created_at: row.s_created_at as number,
      last_seen_at: row.s_last_seen_at as number,
      user_agent: (row.s_user_agent as string | null) ?? null,
      ip_address: (row.s_ip_address as string | null) ?? null,
    },
    customer: {
      id: row.c_id as string,
      email: row.c_email as string,
      name: (row.c_name as string | null) ?? null,
      company: (row.c_company as string | null) ?? null,
      install_id: (row.c_install_id as string | null) ?? null,
      created_at: row.c_created_at as number,
      updated_at: row.c_updated_at as number,
    },
  };
}

export async function touchSession(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await db
    .prepare('UPDATE sessions SET last_seen_at = ?2 WHERE id = ?1')
    .bind(sessionId, nowSeconds())
    .run();
}

export async function deleteSessionByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(tokenHash).run();
}

// ---------------- Licenses ----------------

export async function insertLicense(
  db: D1Database,
  l: Omit<License, 'downloaded_at' | 'revoked_at'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO licenses
         (id, customer_id, install_id, tier, max_users,
          issued_at, expires_at, license_json)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      l.id,
      l.customer_id,
      l.install_id,
      l.tier,
      l.max_users,
      l.issued_at,
      l.expires_at,
      l.license_json,
    )
    .run();
}

export async function getActiveLicenseForCustomer(
  db: D1Database,
  customerId: string,
): Promise<License | null> {
  const row = await db
    .prepare(
      `SELECT * FROM licenses
        WHERE customer_id = ?1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?2)
        ORDER BY issued_at DESC
        LIMIT 1`,
    )
    .bind(customerId, nowSeconds())
    .first<License>();
  return row ?? null;
}

export async function markLicenseDownloaded(
  db: D1Database,
  licenseId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE licenses SET downloaded_at = ?2
        WHERE id = ?1 AND downloaded_at IS NULL`,
    )
    .bind(licenseId, nowSeconds())
    .run();
}

// ---------------- Downloads ----------------

export async function recordDownload(
  db: D1Database,
  args: {
    customerId: string;
    licenseId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    version: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO downloads
         (customer_id, license_id, ip_address, user_agent, version)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      args.customerId,
      args.licenseId,
      args.ipAddress,
      args.userAgent,
      args.version,
    )
    .run();
}

export async function listDownloadsForCustomer(
  db: D1Database,
  customerId: string,
  limit = 25,
): Promise<Download[]> {
  const res = await db
    .prepare(
      `SELECT * FROM downloads
        WHERE customer_id = ?1
        ORDER BY downloaded_at DESC
        LIMIT ?2`,
    )
    .bind(customerId, limit)
    .all<Download>();
  return res.results ?? [];
}

// ---------------- Purchases ----------------

export async function recordPurchaseIntent(
  db: D1Database,
  args: {
    customerId: string;
    tier: LicenseTier;
    seats: number;
    notes: string | null;
  },
): Promise<Purchase> {
  const id = uuidv4();
  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO purchases
         (id, customer_id, tier, seats, notes, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)`,
    )
    .bind(id, args.customerId, args.tier, args.seats, args.notes, now)
    .run();
  return {
    id,
    customer_id: args.customerId,
    tier: args.tier,
    seats: args.seats,
    notes: args.notes,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
}

export function isAdminEmail(env: Env, email: string): boolean {
  const list = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}
