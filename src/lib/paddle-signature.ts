// Paddle Billing webhook signature check.
//
//   Paddle-Signature: ts=1671552777;h1=eb4d0dc8853be92b7f063b9f3ba5233e...
//
// h1 is the hex HMAC-SHA256 of `${ts}:${rawBody}`, keyed with the
// notification destination's secret key (not the API key). This matches
// @paddle/paddle-node-sdk's WebhooksValidator, including its 5-second limit on
// the timestamp's age, except that any of several h1 values may match, so a
// secret rotation doesn't drop deliveries. Always check the raw body: parsing
// and re-serialising the JSON changes the bytes.
//
// Kept free of imports so the tests can load it directly.

export const MAX_SIGNATURE_AGE_SECONDS = 5;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export async function verifyPaddleSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
  nowMs = Date.now(),
): Promise<SignatureCheck> {
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  if (!header) return { ok: false, reason: 'missing Paddle-Signature header' };

  let ts: number | null = null;
  const h1s: string[] = [];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts' && /^\d{1,12}$/.test(value)) ts = Number(value);
    else if (key === 'h1' && /^[0-9a-fA-F]{64}$/.test(value)) h1s.push(value.toLowerCase());
  }
  if (ts === null || h1s.length === 0) return { ok: false, reason: 'malformed Paddle-Signature header' };
  if (Math.abs(nowMs - ts * 1000) > MAX_SIGNATURE_AGE_SECONDS * 1000) {
    return { ok: false, reason: 'signature timestamp too old or in the future' };
  }

  const expected = await hmacSha256Hex(secret, `${ts}:${rawBody}`);
  let match = false;
  for (const h1 of h1s) match = constantTimeEqual(h1, expected) || match;
  return match ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
