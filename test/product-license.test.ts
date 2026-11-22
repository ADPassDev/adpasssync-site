// Tests for src/lib/product-license.ts. Run with `npm test`.
//
// The product verifies a license signature over Go's json.Marshal of the
// payload, so the site must produce the same bytes. The expected values
// below were captured from Go 1.26 (the product's toolchain) running the
// product's own pkg/license code, not derived from the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_EXPIRY,
  canonicalProductLicense,
  goString,
  rfc3339,
  type ProductLicense,
  type ProductTier,
} from '../src/lib/product-license.ts';

type GoCaseInput = {
  install_id: string;
  customer_name: string;
  customer_email: string;
  max_users: number;
  tier: string;
  issued_at: number;
  expires_at: number | null;
};

// Each input was fed to Go 1.26 json.Marshal of the product's own pkg/license.License
// (issued_at/expires_at given as unix seconds, null = zero time); expected is base64
// of the bytes Go wrote.
const GO_CASES: { input: GoCaseInput; expected: string }[] = [
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "Acme Corp", "customer_email": "jane@acme.example", "max_users": 50, "tier": "free", "issued_at": 1794776107, "expires_at": null}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6IkFjbWUgQ29ycCIsImN1c3RvbWVyX2VtYWlsIjoiamFuZUBhY21lLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjUwLCJ0aWVyIjoiZnJlZSIsImlzc3VlZF9hdCI6IjIwMjYtMTEtMTVUMjA6NTU6MDdaIiwiZXhwaXJlc19hdCI6IjAwMDEtMDEtMDFUMDA6MDA6MDBaIn0=' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "<script>alert(\"x\")</script> & Sons", "customer_email": "ops@acme.example", "max_users": 250, "tier": "paid", "issued_at": 1794776107, "expires_at": 1826312107}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6Ilx1MDAzY3NjcmlwdFx1MDAzZWFsZXJ0KFwieFwiKVx1MDAzYy9zY3JpcHRcdTAwM2UgXHUwMDI2IFNvbnMiLCJjdXN0b21lcl9lbWFpbCI6Im9wc0BhY21lLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjI1MCwidGllciI6InBhaWQiLCJpc3N1ZWRfYXQiOiIyMDI2LTExLTE1VDIwOjU1OjA3WiIsImV4cGlyZXNfYXQiOiIyMDI3LTExLTE1VDIwOjU1OjA3WiJ9' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "He said \"hi\" \\ bye/ok", "customer_email": "a@b.example", "max_users": 51, "tier": "paid", "issued_at": 1794776107, "expires_at": 1826312107}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6IkhlIHNhaWQgXCJoaVwiIFxcIGJ5ZS9vayIsImN1c3RvbWVyX2VtYWlsIjoiYUBiLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjUxLCJ0aWVyIjoicGFpZCIsImlzc3VlZF9hdCI6IjIwMjYtMTEtMTVUMjA6NTU6MDdaIiwiZXhwaXJlc19hdCI6IjIwMjctMTEtMTVUMjA6NTU6MDdaIn0=' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "\u0000\u0001\b\f\n\r\t\u001f\u007f end", "customer_email": "a@b.example", "max_users": 50, "tier": "free", "issued_at": 1794776107, "expires_at": null}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6Ilx1MDAwMFx1MDAwMVxiXGZcblxyXHRcdTAwMWZ/IGVuZCIsImN1c3RvbWVyX2VtYWlsIjoiYUBiLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjUwLCJ0aWVyIjoiZnJlZSIsImlzc3VlZF9hdCI6IjIwMjYtMTEtMTVUMjA6NTU6MDdaIiwiZXhwaXJlc19hdCI6IjAwMDEtMDEtMDFUMDA6MDA6MDBaIn0=' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "Zo\u00eb \u00c5ngstr\u00f6m \u2014 \u6771\u4eac \ud83d\ude80", "customer_email": "zo\u00eb@ex\u00e4mple.example", "max_users": 50, "tier": "free", "issued_at": 1794776107, "expires_at": null}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6Ilpvw6sgw4VuZ3N0csO2bSDigJQg5p2x5LqsIPCfmoAiLCJjdXN0b21lcl9lbWFpbCI6Inpvw6tAZXjDpG1wbGUuZXhhbXBsZSIsIm1heF91c2VycyI6NTAsInRpZXIiOiJmcmVlIiwiaXNzdWVkX2F0IjoiMjAyNi0xMS0xNVQyMDo1NTowN1oiLCJleHBpcmVzX2F0IjoiMDAwMS0wMS0wMVQwMDowMDowMFoifQ==' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "a\u2028b\u2029c", "customer_email": "a@b.example", "max_users": 50, "tier": "free", "issued_at": 1794776107, "expires_at": null}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6ImFcdTIwMjhiXHUyMDI5YyIsImN1c3RvbWVyX2VtYWlsIjoiYUBiLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjUwLCJ0aWVyIjoiZnJlZSIsImlzc3VlZF9hdCI6IjIwMjYtMTEtMTVUMjA6NTU6MDdaIiwiZXhwaXJlc19hdCI6IjAwMDEtMDEtMDFUMDA6MDA6MDBaIn0=' },
  { input: {"install_id": "4b1e6a52-0c7e-4d1f-9a43-5f0b2f7d9c11", "customer_name": "x\ud800y\udc00z", "customer_email": "a@b.example", "max_users": 50, "tier": "free", "issued_at": 1794776107, "expires_at": null}, expected: 'eyJpbnN0YWxsX2lkIjoiNGIxZTZhNTItMGM3ZS00ZDFmLTlhNDMtNWYwYjJmN2Q5YzExIiwiY3VzdG9tZXJfbmFtZSI6Injvv71577+9eiIsImN1c3RvbWVyX2VtYWlsIjoiYUBiLmV4YW1wbGUiLCJtYXhfdXNlcnMiOjUwLCJ0aWVyIjoiZnJlZSIsImlzc3VlZF9hdCI6IjIwMjYtMTEtMTVUMjA6NTU6MDdaIiwiZXhwaXJlc19hdCI6IjAwMDEtMDEtMDFUMDA6MDA6MDBaIn0=' },
  { input: {"install_id": "", "customer_name": "", "customer_email": "jane+test@example.com", "max_users": 0, "tier": "paid", "issued_at": 0, "expires_at": 253402300799}, expected: 'eyJpbnN0YWxsX2lkIjoiIiwiY3VzdG9tZXJfbmFtZSI6IiIsImN1c3RvbWVyX2VtYWlsIjoiamFuZSt0ZXN0QGV4YW1wbGUuY29tIiwibWF4X3VzZXJzIjowLCJ0aWVyIjoicGFpZCIsImlzc3VlZF9hdCI6IjE5NzAtMDEtMDFUMDA6MDA6MDBaIiwiZXhwaXJlc19hdCI6Ijk5OTktMTItMzFUMjM6NTk6NTlaIn0=' },
];

test('canonical payload matches Go json.Marshal byte for byte', () => {
  for (const [i, c] of GO_CASES.entries()) {
    const payload: ProductLicense = {
      install_id: c.input.install_id,
      customer_name: c.input.customer_name,
      customer_email: c.input.customer_email,
      max_users: c.input.max_users,
      tier: c.input.tier as ProductTier,
      issued_at: rfc3339(c.input.issued_at),
      expires_at: c.input.expires_at === null ? NO_EXPIRY : rfc3339(c.input.expires_at),
    };
    const got = Buffer.from(canonicalProductLicense(payload), 'utf8').toString('base64');
    assert.equal(got, c.expected, `case ${i}: ${JSON.stringify(c.input.customer_name)}`);
  }
});

test('rfc3339 writes whole-second UTC times the way Go does', () => {
  assert.equal(rfc3339(0), '1970-01-01T00:00:00Z');
  assert.equal(rfc3339(1794776107), '2026-11-15T20:55:07Z');
  assert.equal(rfc3339(-62135596800), NO_EXPIRY);
});

test('rfc3339 refuses what Go cannot marshal or what is not whole seconds', () => {
  assert.throws(() => rfc3339(253402300800), RangeError); // year 10000
  assert.throws(() => rfc3339(-62167219201), RangeError); // year -1
  assert.throws(() => rfc3339(1.5), RangeError);
});

test('goString leaves plain text alone', () => {
  assert.equal(goString('Acme Corp / IT'), '"Acme Corp / IT"');
});
