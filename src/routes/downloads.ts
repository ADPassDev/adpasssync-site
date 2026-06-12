// Public R2-backed download endpoints for the pre-built bloom filter.
//
// These three routes are intentionally unauthenticated — the bloom filter
// itself contains only one-way hashes of breached passwords (a publicly
// available HIBP dataset), so there's nothing to gate, and the agents that
// poll these URLs would have no good way to authenticate without burning
// API keys into every install. Caching headers are tuned so Cloudflare's
// edge does most of the work and customers fetching the file see a CDN
// response, not a per-request R2 round trip.
//
// Routes (mounted at /downloads from src/index.ts):
//
//   GET /hashdb.bin     — the bloom filter itself (~2-3 GB).
//   GET /hashdb.sha256  — checksum sidecar, used for integrity verification.
//   GET /hashdb.json    — { version, built_at, hash_count, file_size, sha256 }.
//
// The companion publisher (`adpf-hashimport --mode build-and-publish`) writes
// all three artefacts together; the order it uploads (bloom → sha → meta)
// ensures any client that successfully reads the metadata can also read the
// bloom referenced by it.

import { Hono } from 'hono';
import type { Env } from '../types';

const downloadsRoutes = new Hono<{ Bindings: Env }>();

// Long max-age on the bloom binary itself — it's content-addressed by the
// matching .sha256 / .json file, and the publisher overwrites the
// HASHDB_BLOOM_KEY object only when a new build is ready. CDN caches can
// hold onto it for an hour; clients can use the .json metadata to detect
// when to re-fetch. `public` so any caching proxy in front of CloudFlare
// (corporate gateways) participates.
const BLOOM_CACHE = 'public, max-age=3600, s-maxage=86400, immutable';

// The checksum and metadata files are small, change atomically with each
// publish, and are exactly the signals clients use to decide whether to
// refresh. Short cache, must-revalidate.
const META_CACHE = 'public, max-age=60, must-revalidate';

// helper: stream an R2 object through with the right headers.
function streamObject(
  obj: R2ObjectBody,
  contentType: string,
  cacheControl: string,
  filename?: string,
): Response {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', cacheControl);
  if (obj.size) headers.set('Content-Length', String(obj.size));
  if (obj.etag) headers.set('ETag', obj.httpEtag);
  if (obj.uploaded) headers.set('Last-Modified', obj.uploaded.toUTCString());
  if (filename) {
    // attachment so a customer who navigates to the URL gets a download
    // rather than the browser trying to render a 2.4 GB octet stream.
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  }
  return new Response(obj.body, { status: 200, headers });
}

downloadsRoutes.get('/hashdb.bin', async (c) => {
  const obj = await c.env.HASHDB_BUCKET.get(c.env.HASHDB_BLOOM_KEY);
  if (!obj) {
    return c.json(
      { error: 'hashdb_not_published', detail: `no R2 object at ${c.env.HASHDB_BLOOM_KEY}` },
      404,
    );
  }
  return streamObject(obj, 'application/octet-stream', BLOOM_CACHE, 'hashdb.bin');
});

downloadsRoutes.get('/hashdb.sha256', async (c) => {
  const obj = await c.env.HASHDB_BUCKET.get(c.env.HASHDB_SHA256_KEY);
  if (!obj) {
    return c.json(
      { error: 'hashdb_not_published', detail: `no R2 object at ${c.env.HASHDB_SHA256_KEY}` },
      404,
    );
  }
  return streamObject(obj, 'text/plain; charset=utf-8', META_CACHE);
});

downloadsRoutes.get('/hashdb.json', async (c) => {
  const obj = await c.env.HASHDB_BUCKET.get(c.env.HASHDB_META_KEY);
  if (!obj) {
    return c.json(
      { error: 'hashdb_not_published', detail: `no R2 object at ${c.env.HASHDB_META_KEY}` },
      404,
    );
  }
  return streamObject(obj, 'application/json; charset=utf-8', META_CACHE);
});

// HEAD support is useful for agents that just want to know whether a new
// build is available. Cloudflare R2's get() with onlyIf is overkill here;
// returning size + ETag + Last-Modified covers the agent's check.
downloadsRoutes.on(['HEAD'], '/hashdb.bin', async (c) => {
  const head = await c.env.HASHDB_BUCKET.head(c.env.HASHDB_BLOOM_KEY);
  if (!head) return c.body(null, 404);
  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Cache-Control', BLOOM_CACHE);
  headers.set('Content-Length', String(head.size));
  headers.set('ETag', head.httpEtag);
  if (head.uploaded) headers.set('Last-Modified', head.uploaded.toUTCString());
  return new Response(null, { status: 200, headers });
});

export default downloadsRoutes;
