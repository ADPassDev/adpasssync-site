// Generate an RSA-2048 keypair for license signing.
//
//   node --experimental-strip-types scripts/generate-keys.ts
//
// Outputs PKCS#8 (private) and SPKI (public) PEM strings — the same formats
// the Worker imports via crypto.subtle.importKey. Pipe into wrangler:
//
//   wrangler secret put LICENSE_PRIVATE_KEY
//   wrangler secret put LICENSE_PUBLIC_KEY
//
// Keep the private key out of git.

import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Write to stdout / stderr separately so the user can redirect each.
process.stdout.write('===== PRIVATE KEY (LICENSE_PRIVATE_KEY) =====\n');
process.stdout.write(privateKey);
process.stdout.write('\n===== PUBLIC KEY  (LICENSE_PUBLIC_KEY)  =====\n');
process.stdout.write(publicKey);
process.stdout.write('\n');

process.stderr.write(
  '\nSet the secrets:\n' +
    '  wrangler secret put LICENSE_PRIVATE_KEY  # paste the private block above\n' +
    '  wrangler secret put LICENSE_PUBLIC_KEY   # paste the public block above\n' +
    '\nShip the public key with your installer so it can verify license signatures.\n',
);
