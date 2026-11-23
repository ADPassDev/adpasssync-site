// Public R2-backed download endpoints for the pre-built bloom filter.
//
// These three routes are intentionally unauthenticated — the bloom filter
// itself contains only one-way hashes of breached passwords (a publicly
// available HIBP dataset), so there's nothing to gate, and the agents that
// poll these URLs would have no good way to authenticate without burning
// API keys into every install.
//
// Serving, byte ranges, If-Range and conditional requests (304) are handled
// by src/lib/r2-serve.ts, which also explains why Cloudflare's CDN doesn't
// cache these responses. The bloom is over the CDN's per-file cache limit on
// non-Enterprise plans (512 MB) anyway, so every request is served from R2
// through this Worker.
//
// Routes (mounted at /downloads from src/index.ts), each answering GET and HEAD:
//
//   /hashdb.bin     — the bloom filter itself (~2-3 GB).
//   /hashdb.sha256  — checksum sidecar, used for integrity verification.
//   /hashdb.json    — { version, built_at, hash_count, file_size, sha256 }.
//
// The companion publisher (`adpf-hashimport --mode build-and-publish`) writes
// all three artefacts together; the order it uploads (bloom → sha → meta)
// ensures any client that successfully reads the metadata can also read the
// bloom referenced by it.

import { Hono, type Context } from 'hono';
import type { Env } from '../types';
// Explicit extension so `npm test` can load this file under Node's type
// stripping, which doesn't resolve extensionless relative imports.
import { serveR2Object, type ServeOptions } from '../lib/r2-serve.ts';

type Ctx = Context<{ Bindings: Env }>;

const downloadsRoutes = new Hono<{ Bindings: Env }>();

// The publisher overwrites all three objects in place at fixed URLs, so no
// cache may reuse a stored copy without checking that it is still current.
// Any freshness lifetime lets a proxy keep serving the previous build, or the
// previous checksum, after a publish, so that the bloom and its .sha256/.json
// disagree and agents fail verification. `no-cache` still lets browsers and
// caching proxies in front of Cloudflare (corporate gateways) store them, but
// makes them revalidate before each use; a 304 makes that cheap, and a
// publish is picked up on the next request. Cloudflare's own edge doesn't
// cache them (see src/lib/r2-serve.ts).
const CACHE_CONTROL = 'public, no-cache';

function serveHashDb(
  c: Ctx,
  key: string,
  opts: Pick<ServeOptions, 'contentType' | 'contentDisposition'>,
): Promise<Response> {
  return serveR2Object(c, c.env.HASHDB_BUCKET, key, {
    ...opts,
    cacheControl: CACHE_CONTROL,
    notFound: () =>
      c.json({ error: 'hashdb_not_published', detail: `no R2 object at ${key}` }, 404),
  });
}

// Hono answers HEAD by running the GET handler and dropping its body, so
// these handlers serve HEAD too; serveR2Object() checks the method.

downloadsRoutes.get('/hashdb.bin', (c) =>
  serveHashDb(c, c.env.HASHDB_BLOOM_KEY, {
    contentType: 'application/octet-stream',
    // attachment so a customer who navigates to the URL gets a download
    // rather than the browser trying to render a 2.4 GB octet stream.
    contentDisposition: 'attachment; filename="hashdb.bin"',
  }),
);

downloadsRoutes.get('/hashdb.sha256', (c) =>
  serveHashDb(c, c.env.HASHDB_SHA256_KEY, {
    contentType: 'text/plain; charset=utf-8',
  }),
);

downloadsRoutes.get('/hashdb.json', (c) =>
  serveHashDb(c, c.env.HASHDB_META_KEY, {
    contentType: 'application/json; charset=utf-8',
  }),
);

export default downloadsRoutes;
