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
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return base64ToBytes(body);
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemBodyToBytes(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function importRsaPublicKey(pem: string): Promise<CryptoKey> {
  const der = pemBodyToBytes(pem);
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
