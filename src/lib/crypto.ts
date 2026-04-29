// Crypto primitives. All built on the Web Crypto API available in Workers.

export function uuidv4(): string {
  return crypto.randomUUID();
}

/** Hex-encoded cryptographically random token. 32 bytes => 64 hex chars. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export function bytesToHex(buf: Uint8Array): string {
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToBase64(buf: Uint8Array): string {
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

/** Constant-time comparison for two equal-length hex/ascii strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------- PEM <-> CryptoKey helpers ----------

function pemBodyToBytes(pem: string): Uint8Array {
  // Strip BEGIN/END framing then keep only base64 characters. We can't just
  // strip whitespace — secrets pasted through `wrangler secret put` (or
  // round-tripped through JSON / dotenv) often arrive with literal "\n"
  // escape sequences, BOMs, or smart quotes mixed in. Filtering to the
  // base64 alphabet is the most forgiving fix that's still correct.
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  if (body.length === 0) {
    throw new Error(
      'PEM body is empty after stripping framing — secret may be missing or corrupt',
    );
  }
  return base64ToBytes(body);
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  let der: Uint8Array;
  try {
    der = pemBodyToBytes(pem);
  } catch (e) {
    throw new Error(
      `LICENSE_PRIVATE_KEY is not a valid PEM-encoded PKCS#8 RSA private key: ${
        (e as Error).message
      }`,
    );
  }
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  let der: Uint8Array;
  try {
    der = pemBodyToBytes(pem);
  } catch (e) {
    throw new Error(
      `LICENSE_PUBLIC_KEY is not a valid PEM-encoded SPKI RSA public key: ${
        (e as Error).message
      }`,
    );
  }
  return crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  );
}

/** RSASSA-PKCS1-v1_5 / SHA-256 signature, base64-encoded. */
export async function rsaSign(privateKey: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(message),
  );
  return bytesToBase64(new Uint8Array(sig));
}

export async function rsaVerify(
  publicKey: CryptoKey,
  message: string,
  signatureBase64: string,
): Promise<boolean> {
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    base64ToBytes(signatureBase64),
    new TextEncoder().encode(message),
  );
}
