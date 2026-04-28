// Shared types for the ADPassSync portal Worker.

export type Env = {
  DB: D1Database;
  INSTALLER_BUCKET: R2Bucket;
  ASSETS: Fetcher;

  // Plain config (vars).
  PUBLIC_BASE_URL: string;
  ADMIN_EMAILS: string;
  SESSION_TTL_HOURS: string;
  MAGIC_LINK_TTL_MINUTES: string;
  FROM_EMAIL: string;
  INSTALLER_OBJECT_KEY: string;
  DEV_RETURN_MAGIC_LINK: string;

  // Secrets (set via `wrangler secret put`).
  LICENSE_PRIVATE_KEY?: string;
  LICENSE_PUBLIC_KEY?: string;
  RESEND_API_KEY?: string;
};

// Hono Variables — values stashed onto the request context by middleware.
export type Variables = {
  customer?: Customer;
  isAdmin?: boolean;
};

export type LicenseTier = 'free' | 'professional' | 'enterprise';

export type Customer = {
  id: string;
  email: string;
  name: string | null;
  company: string | null;
  install_id: string | null;
  created_at: number;
  updated_at: number;
};

export type Session = {
  id: string;
  customer_id: string;
  token_hash: string;
  expires_at: number;
  created_at: number;
  last_seen_at: number;
  user_agent: string | null;
  ip_address: string | null;
};

export type License = {
  id: string;
  customer_id: string;
  install_id: string;
  tier: LicenseTier;
  max_users: number;
  issued_at: number;
  expires_at: number | null;
  license_json: string;
  downloaded_at: number | null;
  revoked_at: number | null;
};

export type Download = {
  id: number;
  customer_id: string;
  license_id: string | null;
  downloaded_at: number;
  ip_address: string | null;
  user_agent: string | null;
  version: string | null;
};

export type Purchase = {
  id: string;
  customer_id: string;
  tier: LicenseTier;
  seats: number;
  notes: string | null;
  status: 'pending' | 'paid' | 'cancelled';
  created_at: number;
  updated_at: number;
};

// The signed license payload that ships inside license-key.txt.
export type LicensePayload = {
  v: 1;
  license_id: string;
  install_id: string;
  customer_id: string;
  email: string;
  company: string | null;
  tier: LicenseTier;
  max_users: number;
  issued_at: number; // unix seconds
  expires_at: number | null;
};

export type SignedLicense = {
  payload: LicensePayload;
  signature: string; // base64
  alg: 'RS256';
  kid: string; // "v1" — key id, lets us rotate later
};
