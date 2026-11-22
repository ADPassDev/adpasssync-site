-- 0001: license after install.
--
-- License files are now issued in the product's own format and bound to the
-- Install ID the product generates on first run, which the customer registers
-- in the portal. Before this, the site generated its own install IDs at first
-- download and signed licenses in a format the product cannot load.
--
-- Old-format rows are recognised by their content: only the old envelope has
-- an "alg" key (the product format is just "payload" and "signature", and a
-- quote inside a value is always escaped). Nothing the new code writes is
-- touched, so this is safe to run any number of times. Run it again right
-- after deploying, to catch anything the old Worker wrote in between:
--
--   npx wrangler d1 migrations apply adpasssync-db --remote          # before deploy
--   npx wrangler d1 execute adpasssync-db --remote \
--       --file=migrations/0001_license_after_install.sql             # after deploy

CREATE TABLE IF NOT EXISTS entitlements (
  customer_id  TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tier         TEXT NOT NULL CHECK (tier IN ('free','professional','enterprise')),
  max_users    INTEGER NOT NULL,
  expires_at   INTEGER,
  source       TEXT,
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Keep what customers were sold: carry each customer's newest unrevoked paid
-- old-format license over as their entitlement (unless they already have one).
INSERT OR IGNORE INTO entitlements (customer_id, tier, max_users, expires_at, source, updated_at)
SELECT l.customer_id, l.tier, l.max_users, l.expires_at, 'migrated:' || l.id, unixepoch()
  FROM licenses l
 WHERE l.revoked_at IS NULL
   AND l.tier <> 'free'
   AND l.license_json LIKE '%"alg"%'
   AND l.issued_at = (SELECT MAX(x.issued_at) FROM licenses x
                       WHERE x.customer_id = l.customer_id AND x.revoked_at IS NULL
                         AND x.license_json LIKE '%"alg"%');

-- Install IDs the site generated (every one got an old-format license) match
-- no real installation.
UPDATE customers SET install_id = NULL, updated_at = unixepoch()
 WHERE install_id IN (SELECT install_id FROM licenses WHERE license_json LIKE '%"alg"%');

-- The product can't load old-format license files; retire them.
UPDATE licenses SET revoked_at = unixepoch()
 WHERE revoked_at IS NULL
   AND license_json LIKE '%"alg"%';
