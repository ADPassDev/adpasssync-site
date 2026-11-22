-- 0002: Paddle Billing.
--
-- Paddle is the system of record for payments. The site keeps just enough to
-- turn subscription state into entitlements (and from there license files
-- and full bloom filter keys). Only creates tables, so it is safe to re-run.
--
--   npx wrangler d1 migrations apply adpasssync-db --remote

-- Portal account <-> Paddle customer (ctm_...).
CREATE TABLE IF NOT EXISTS paddle_customers (
  customer_id         TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  paddle_customer_id  TEXT NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One row per Paddle subscription (sub_...).
CREATE TABLE IF NOT EXISTS paddle_subscriptions (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status             TEXT NOT NULL,              -- active | past_due | paused | canceled | trialing
  quantity           INTEGER NOT NULL,           -- active AD users paid for
  paid_through       INTEGER,                    -- end of the latest billing period a payment covered
  next_billed_at     INTEGER,
  cancel_at          INTEGER,                    -- scheduled cancellation, if any
  refunded_at        INTEGER,                    -- an approved refund/chargeback ended the paid term
  ended_by           TEXT,                       -- 'refund' or 'chargeback': which one
  paddle_updated_ms  INTEGER NOT NULL DEFAULT 0, -- updated_at of the newest subscription state applied
  created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_paddle_subscriptions_customer ON paddle_subscriptions(customer_id);

-- Webhook events already processed. Paddle retries deliveries, and event_id
-- stays the same across retries.
CREATE TABLE IF NOT EXISTS paddle_events (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  processed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Each paid customer's key for the full bloom filter. The key itself lives in
-- the adpasssync-downloads Worker's D1 (adpasssync-licenses), which checks it
-- on /downloads/paid/*; this records which key is whose.
CREATE TABLE IF NOT EXISTS hashdb_keys (
  customer_id  TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  key          TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
