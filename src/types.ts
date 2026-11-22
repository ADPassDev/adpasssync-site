// Shared types for the ADPassSync portal Worker.

export type Env = {
  DB: D1Database;
  RELEASES_BUCKET: R2Bucket;
  HASHDB_BUCKET: R2Bucket;
  ASSETS: Fetcher;

  // Plain config (vars).
  PUBLIC_BASE_URL: string;
  ADMIN_EMAILS: string;
  CONTACT_NOTIFY_EMAILS: string;
  PURCHASE_NOTIFY_EMAILS: string;
  SESSION_TTL_HOURS: string;
  MAGIC_LINK_TTL_MINUTES: string;
  FROM_EMAIL: string;
  RELEASE_MANIFEST_KEY: string;
  DEV_RETURN_MAGIC_LINK: string;
  HASHDB_BLOOM_KEY: string;
  HASHDB_SHA256_KEY: string;
  HASHDB_META_KEY: string;

  // Secrets (set via `wrangler secret put`).
  LICENSE_PRIVATE_KEY?: string;
  LICENSE_PUBLIC_KEY?: string;
  RESEND_API_KEY?: string;

  // Paddle Billing (see wrangler.jsonc).
  PADDLE_ENV: string;
  PADDLE_PRICE_ID: string;
  PADDLE_CLIENT_TOKEN: string;
  PADDLE_API_KEY?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  // While PADDLE_ENV isn't "production": the only accounts (comma-separated
  // emails) that may buy. Everyone else gets quote requests.
  PADDLE_SANDBOX_TESTERS?: string;
  // Overrides the API base URL that PADDLE_ENV implies. Local tests only.
  PADDLE_API_BASE_URL?: string;
  // The adpasssync-downloads Worker's D1, for full bloom filter keys.
  HASHDB_LICENSES?: D1Database;
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
  // The Install ID ADPassSync generated on first run, registered by the
  // customer in the portal. One installation per account.
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

// What a customer is licensed for, whatever installation it ends up on.
// No row means the free tier. License files (the licenses table) are issued
// from this for the customer's registered installation.
export type Entitlement = {
  customer_id: string;
  tier: LicenseTier;
  max_users: number;
  expires_at: number | null; // unix seconds; null = no expiry
  source: string | null; // e.g. "purchase:<id>", "admin:<email>"
  updated_at: number;
};
