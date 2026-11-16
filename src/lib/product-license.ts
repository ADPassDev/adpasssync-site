// The product's license format (ADPassSync repo, pkg/license).
//
// The product loads a LicenseFile:
//
//   {"payload": { ...License... }, "signature": "<base64>"}
//
// It re-encodes the parsed payload with Go's json.Marshal and checks an
// RSASSA-PKCS1-v1_5 / SHA-256 signature over those bytes. So the bytes the
// site signs must be exactly what Go writes for the same License: fields in
// struct order, compact, times in RFC 3339, and Go's string escaping.
// test/product-license.test.ts pins this against output captured from Go
// 1.26 running the product's own pkg/license code.
//
// Kept free of imports so the tests can load it directly.

/** pkg/license.Tier. */
export type ProductTier = 'free' | 'paid' | 'trial';

/** pkg/license.License, field for field and in declaration order. */
export type ProductLicense = {
  install_id: string;
  customer_name: string;
  customer_email: string;
  max_users: number;
  tier: ProductTier;
  /** RFC 3339, UTC, whole seconds (see rfc3339). */
  issued_at: string;
  /** RFC 3339, or NO_EXPIRY. */
  expires_at: string;
};

/** Go's zero time.Time as JSON. The product reads it as "never expires". */
export const NO_EXPIRY = '0001-01-01T00:00:00Z';

/** pkg/license.FreeTierMaxUsers: the cap the product applies with no license loaded. */
export const FREE_TIER_MAX_USERS = 50;

/**
 * The bytes the product verifies the signature over: Go's json.Marshal of the
 * License struct. Features (a map tagged omitempty) is never set by the site,
 * so Go leaves it out as well.
 */
export function canonicalProductLicense(p: ProductLicense): string {
  return (
    '{"install_id":' + goString(p.install_id) +
    ',"customer_name":' + goString(p.customer_name) +
    ',"customer_email":' + goString(p.customer_email) +
    ',"max_users":' + goInt(p.max_users) +
    ',"tier":' + goString(p.tier) +
    ',"issued_at":' + goString(p.issued_at) +
    ',"expires_at":' + goString(p.expires_at) +
    '}'
  );
}

/**
 * Unix seconds as Go marshals a whole-second UTC time.Time:
 * 2026-11-16T01:02:03Z. Go refuses years outside 0000-9999, and so does this.
 */
export function rfc3339(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds)) throw new RangeError(`not whole seconds: ${unixSeconds}`);
  const iso = new Date(unixSeconds * 1000).toISOString();
  if (!/^\d{4}-/.test(iso)) throw new RangeError(`year outside 0000-9999: ${iso}`);
  return iso.slice(0, 19) + 'Z';
}

const HEX = '0123456789abcdef';

/**
 * A JSON string literal exactly as Go's encoding/json writes it with HTML
 * escaping on (the json.Marshal default): <, > and & as < > &,
 * U+2028 and U+2029 escaped, \b \f \n \r \t as short escapes, other control
 * characters as \u00XX, everything else (DEL included) raw. Unpaired
 * surrogates become U+FFFD, which is what Go decodes them to.
 */
export function goString(input: string): string {
  let out = '"';
  for (const ch of input.toWellFormed()) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x80) {
      out += cp === 0x2028 || cp === 0x2029 ? '\\u202' + HEX[cp & 0xf] : ch;
    } else if (cp === 0x22 || cp === 0x5c) {
      out += '\\' + ch;
    } else if (cp === 0x3c || cp === 0x3e || cp === 0x26 || cp < 0x20) {
      out += SHORT_ESCAPES[cp] ?? '\\u00' + HEX[cp >> 4] + HEX[cp & 0xf];
    } else {
      out += ch;
    }
  }
  return out + '"';
}

const SHORT_ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x0c: '\\f',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
};

function goInt(n: number): string {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not an integer: ${n}`);
  return String(n);
}
