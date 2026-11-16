-- 0001: license after install.
--
-- License files are now issued in the product's own format and bound to the
-- Install ID the product generates on first run, which the customer registers
-- in the portal. Before this, the site generated its own install IDs at first
-- download and signed licenses in a format the product cannot load.
--
-- Apply BEFORE deploying the Worker that uses it:
--   npx wrangler d1 migrations apply adpasssync-db --remote
--
-- Every data change is guarded by a marker row, so applying this file a
-- second time (e.g. with `wrangler d1 execute --file`) changes nothing.

CREATE TABLE IF NOT EXISTS schema_markers (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS entitlements (
  customer_id  TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL CHECK (tier IN ('free','professional','enterprise')),
  max_users    INTEGER NOT NULL,
  expires_at   INTEGER,
  source       TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Keep what customers were sold: carry each customer's newest unrevoked paid
-- license over as their entitlement.
INSERT OR IGNORE INTO entitlements (customer_id, tier, max_users, expires_at, source, updated_at)
SELECT l.customer_id, l.tier, l.max_users, l.expires_at, 'migrated:' || l.id, unixepoch()
  FROM licenses l
 WHERE l.revoked_at IS NULL
   AND l.tier <> 'free'
   AND l.issued_at = (SELECT MAX(x.issued_at) FROM licenses x
                       WHERE x.customer_id = l.customer_id AND x.revoked_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '0001_license_after_install');

-- The old-format license files can't be loaded by the product; retire them.
UPDATE licenses SET revoked_at = unixepoch()
 WHERE revoked_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '0001_license_after_install');

-- Site-generated install IDs match no real installation.
UPDATE customers SET install_id = NULL, updated_at = unixepoch()
 WHERE install_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM schema_markers WHERE name = '0001_license_after_install');

INSERT OR IGNORE INTO schema_markers (name) VALUES ('0001_license_after_install');
