// Public R2-backed download endpoints for the pre-built bloom filter.
//
// These three routes are intentionally unauthenticated — the bloom filter
// itself contains only one-way hashes of breached passwords (a publicly
// available HIBP dataset), so there's nothing to gate, and the agents that
// poll these URLs would have no good way to authenticate without burning
// API keys into every install.
//
// Caching: Cloudflare's CDN does not cache these responses. A Worker runs in
// front of the cache, and a Response it builds from an R2 binding is only
// stored if the Worker puts it in the Cache API or has Workers Cache turned
// on (`cache.enabled` in wrangler config); neither is used here. The bloom is
// also over the CDN's per-file cache limit on non-Enterprise plans (512 MB).
// So every request, ranged or not, is served from R2 through this Worker.
// That's fine on cost: R2 has no egress fees, just one Class B operation per
// head()/get() call. The Cache-Control headers only matter to browsers and to
// shared caches between clients and Cloudflare (corporate proxies). If
// Workers Cache is ever enabled, re-test resumes: it strips Range before the
// Worker runs.
//
// Byte ranges, so `curl -C -`, BITS and download managers can resume a
// multi-GB transfer instead of restarting it: a GET with a single
// `Range: bytes=` spec gets a 206 with Content-Range; a malformed or
// out-of-bounds byte range gets a 416 with `Content-Range: bytes */<size>`;
// If-Range is honoured, so resuming after the publisher has replaced the
// object gets a full 200 of the new build. Multi-range requests and other
// range units get the full 200 (RFC 9110 lets a server ignore Range).
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

type Ctx = Context<{ Bindings: Env }>;

const downloadsRoutes = new Hono<{ Bindings: Env }>();

// Long max-age on the bloom binary itself. The publisher overwrites the
// HASHDB_BLOOM_KEY object in place only when a new build is ready, and
// clients use the .json metadata to detect when to re-fetch. Browsers may
// reuse it for an hour (max-age) and shared caches for a day (s-maxage);
// Cloudflare's own edge doesn't cache it (see top of file). `public` so any
// caching proxy in front of Cloudflare (corporate gateways) participates.
const BLOOM_CACHE = 'public, max-age=3600, s-maxage=86400, immutable';

// The checksum and metadata files are small, change atomically with each
// publish, and are exactly the signals clients use to decide whether to
// refresh. Short cache, must-revalidate.
const META_CACHE = 'public, max-age=60, must-revalidate';

type ServeOptions = {
  contentType: string;
  cacheControl: string;
  filename?: string;
};

// A parsed Range header. `none`: no header, a unit other than bytes, or
// several ranges, all answered with the full 200. `invalid`: a bytes range
// that doesn't parse, answered with 416.
type RangeRequest =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'from'; first: number; last?: number } // bytes=first-last, bytes=first-
  | { kind: 'suffix'; length: number }; // bytes=-length

type ByteRange = { offset: number; length: number };

function parseRange(header: string | undefined): RangeRequest {
  if (header === undefined) return { kind: 'none' };
  const eq = header.indexOf('=');
  if (eq < 0 || header.slice(0, eq).trim().toLowerCase() !== 'bytes') {
    return { kind: 'none' };
  }
  // Empty list elements are legal (RFC 9110 §5.6.1), e.g. "bytes=0-99,".
  const specs = header
    .slice(eq + 1)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (specs.length > 1) return { kind: 'none' };
  const m = /^(\d*)-(\d*)$/.exec(specs[0] ?? '');
  if (!m) return { kind: 'invalid' };
  const [, first = '', last = ''] = m;
  if (first === '') {
    return last === '' ? { kind: 'invalid' } : { kind: 'suffix', length: Number(last) };
  }
  if (last !== '' && Number(last) < Number(first)) return { kind: 'invalid' };
  return { kind: 'from', first: Number(first), last: last === '' ? undefined : Number(last) };
}

// Resolve a range against the object size (RFC 9110 §14.1.2); null means
// unsatisfiable. A last-pos past the end is clamped, and a suffix longer than
// the object selects all of it.
function resolveRange(range: RangeRequest, size: number): ByteRange | null {
  switch (range.kind) {
    case 'from': {
      if (range.first >= size) return null;
      const last = Math.min(range.last ?? size - 1, size - 1);
      return { offset: range.first, length: last - range.first + 1 };
    }
    case 'suffix': {
      if (range.length === 0) return null;
      const length = Math.min(range.length, size);
      return { offset: size - length, length };
    }
    default:
      return null;
  }
}

// If-Range (RFC 9110 §13.1.5): apply Range only if the client's validator
// still matches the stored object. An entity-tag must equal our ETag exactly
// (strong comparison, so a weak W/ tag never matches). An HTTP-date must equal
// Last-Modified to the second, which is precise enough for objects replaced
// once per multi-hour build. Without If-Range, Range always applies.
function ifRangeMatches(ifRange: string | undefined, obj: R2Object): boolean {
  if (ifRange === undefined) return true;
  const value = ifRange.trim();
  if (value.startsWith('"') || value.startsWith('W/')) return value === obj.httpEtag;
  const date = Date.parse(value);
  return (
    !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(obj.uploaded.getTime() / 1000)
  );
}

// Headers for 200, 206 and HEAD responses. contentLength is the length of the
// body actually sent: the whole object, or just the requested range.
function objectHeaders(obj: R2Object, opts: ServeOptions, contentLength: number): Headers {
  const headers = new Headers();
  headers.set('Content-Type', opts.contentType);
  headers.set('Cache-Control', opts.cacheControl);
  headers.set('Content-Length', String(contentLength));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', obj.httpEtag);
  headers.set('Last-Modified', obj.uploaded.toUTCString());
  if (opts.filename) {
    // attachment so a customer who navigates to the URL gets a download
    // rather than the browser trying to render a 2.4 GB octet stream.
    headers.set('Content-Disposition', `attachment; filename="${opts.filename}"`);
  }
  return headers;
}

function notPublished(c: Ctx, key: string): Response {
  return c.json({ error: 'hashdb_not_published', detail: `no R2 object at ${key}` }, 404);
}

async function serveFull(c: Ctx, key: string, opts: ServeOptions): Promise<Response> {
  const obj = await c.env.HASHDB_BUCKET.get(key);
  if (!obj) return notPublished(c, key);
  return new Response(obj.body, { status: 200, headers: objectHeaders(obj, opts, obj.size) });
}

// Stream an R2 object with the right headers, honouring Range on GET.
async function serveObject(c: Ctx, key: string, opts: ServeOptions): Promise<Response> {
  const bucket = c.env.HASHDB_BUCKET;

  // Range is defined for GET only (RFC 9110 §14.2), so HEAD always describes
  // the whole object. head() means a HEAD never opens a read of the bloom.
  if (c.req.method === 'HEAD') {
    const meta = await bucket.head(key);
    if (!meta) return notPublished(c, key);
    return new Response(null, { status: 200, headers: objectHeaders(meta, opts, meta.size) });
  }

  const range = parseRange(c.req.header('Range'));
  if (range.kind === 'none') return serveFull(c, key, opts);

  // Read the metadata first: resolving the range (or answering 416) needs the
  // total size, and If-Range is checked against the current ETag. Then fetch
  // exactly those bytes, pinned with onlyIf to the version just checked. The
  // publisher overwrites in place, and an unpinned read racing a publish would
  // splice bytes of the new build into a range computed against the old one.
  // If the pin fails, the object changed in between: start over against the
  // new version, as if the request had arrived after the publish.
  for (let attempt = 0; attempt < 2; attempt++) {
    const meta = await bucket.head(key);
    if (!meta) return notPublished(c, key);
    // RFC 9110 lets a server ignore Range for an empty representation.
    if (meta.size === 0 || !ifRangeMatches(c.req.header('If-Range'), meta)) {
      return serveFull(c, key, opts);
    }
    const byteRange = resolveRange(range, meta.size);
    if (!byteRange) {
      return c.json(
        { error: 'range_not_satisfiable', detail: `object is ${meta.size} bytes` },
        416,
        { 'Content-Range': `bytes */${meta.size}`, 'Accept-Ranges': 'bytes' },
      );
    }

    const obj = await bucket.get(key, { range: byteRange, onlyIf: { etagMatches: meta.etag } });
    if (!obj) return notPublished(c, key);
    if ('body' in obj) {
      const { offset, length } = byteRange;
      const headers = objectHeaders(obj, opts, length);
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      return new Response(obj.body, { status: 206, headers });
    }
  }
  // Replaced on both attempts, which takes two publishes milliseconds apart.
  // A full 200 is always a valid answer to a Range request.
  return serveFull(c, key, opts);
}

// Hono answers HEAD by running the GET handler and dropping its body, so
// these handlers serve HEAD too; serveObject() checks the method.

downloadsRoutes.get('/hashdb.bin', (c) =>
  serveObject(c, c.env.HASHDB_BLOOM_KEY, {
    contentType: 'application/octet-stream',
    cacheControl: BLOOM_CACHE,
    filename: 'hashdb.bin',
  }),
);

downloadsRoutes.get('/hashdb.sha256', (c) =>
  serveObject(c, c.env.HASHDB_SHA256_KEY, {
    contentType: 'text/plain; charset=utf-8',
    cacheControl: META_CACHE,
  }),
);

downloadsRoutes.get('/hashdb.json', (c) =>
  serveObject(c, c.env.HASHDB_META_KEY, {
    contentType: 'application/json; charset=utf-8',
    cacheControl: META_CACHE,
  }),
);

export default downloadsRoutes;
