// Generate an RSA-2048 keypair for license signing.
//
//   node --experimental-strip-types scripts/generate-keys.ts
//
// Writes two files in the working directory:
//   license-private.pem  (PKCS#8)
//   license-public.pem   (SPKI)
//
// Pipe each file straight into `wrangler secret put` so the PEM never has
// to round-trip through your clipboard — that round-trip is the most common
// cause of "atob() invalid base64" errors at runtime, because pasting can
// introduce stray decorator characters, BOMs, or literal "\n" escape
// sequences.

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privPath = resolve(process.cwd(), 'license-private.pem');
const pubPath = resolve(process.cwd(), 'license-public.pem');

writeFileSync(privPath, privateKey, { mode: 0o600 });
writeFileSync(pubPath, publicKey, { mode: 0o644 });

process.stderr.write(
  `\nWrote:\n  ${privPath}\n  ${pubPath}\n\n` +
    `Set the secrets without copy-pasting:\n\n` +
    `  PowerShell:\n` +
    `    Get-Content license-private.pem -Raw | npx wrangler secret put LICENSE_PRIVATE_KEY\n` +
    `    Get-Content license-public.pem  -Raw | npx wrangler secret put LICENSE_PUBLIC_KEY\n\n` +
    `  bash / zsh:\n` +
    `    npx wrangler secret put LICENSE_PRIVATE_KEY < license-private.pem\n` +
    `    npx wrangler secret put LICENSE_PUBLIC_KEY  < license-public.pem\n\n` +
    `Delete the .pem files once the secrets are set:\n` +
    `  Remove-Item license-*.pem    # PowerShell\n` +
    `  rm license-*.pem             # bash\n`,
);
