-- ADPassSync customer portal schema (D1 / SQLite)
-- Apply with: wrangler d1 execute adpasssync-db --local  --file=./schema.sql
--             wrangler d1 execute adpasssync-db --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,                          -- uuid v4
  email        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name         TEXT,
  company      TEXT,
  install_id   TEXT UNIQUE,                               -- uuid v4, set on first download
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_customers_install_id ON customers(install_id);

-- Magic-link tokens (single-use, short TTL).
CREATE TABLE IF NOT EXISTS magic_links (
  token        TEXT PRIMARY KEY,                          -- random 32-byte hex
  email        TEXT NOT NULL COLLATE NOCASE,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);

-- Long-lived browser sessions (cookie-bound).
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,                          -- uuid v4
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,                      -- random 32-byte hex stored opaquely
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_agent   TEXT,
  ip_address   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_customer_id ON sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions(expires_at);

-- Issued license files. license_json holds the signed payload + signature.
CREATE TABLE IF NOT EXISTS licenses (
  id            TEXT PRIMARY KEY,                         -- uuid v4
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  install_id    TEXT NOT NULL,                            -- denormalized from customers.install_id
  tier          TEXT NOT NULL CHECK (tier IN ('free','professional','enterprise')),
  max_users     INTEGER NOT NULL,                         -- 50 for free; arbitrary for paid
  issued_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at    INTEGER,                                  -- NULL = perpetual (free tier)
  license_json  TEXT NOT NULL,                            -- signed JSON envelope
  downloaded_at INTEGER,
  revoked_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_licenses_customer_id ON licenses(customer_id);
CREATE INDEX IF NOT EXISTS idx_licenses_install_id  ON licenses(install_id);

-- Audit log of installer downloads.
CREATE TABLE IF NOT EXISTS downloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  license_id    TEXT REFERENCES licenses(id) ON DELETE SET NULL,
  downloaded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  ip_address    TEXT,
  user_agent    TEXT,
  version       TEXT
);

CREATE INDEX IF NOT EXISTS idx_downloads_customer_id ON downloads(customer_id);

-- Purchase intents recorded before payment integration is wired up.
CREATE TABLE IF NOT EXISTS purchases (
  id           TEXT PRIMARY KEY,                          -- uuid v4
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL,
  seats        INTEGER NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'            -- pending|paid|cancelled
                CHECK (status IN ('pending','paid','cancelled')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_purchases_customer_id ON purchases(customer_id);
