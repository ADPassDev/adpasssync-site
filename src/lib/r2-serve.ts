// Serve one R2 object over HTTP the way a static file server would. Shared by
// /downloads/* (the bloom filter, src/routes/downloads.ts) and /media/* (site
// videos, src/routes/media.ts).
//
// Caching: Cloudflare's CDN does not cache these responses. A Worker runs in
// front of the cache, and a Response it builds from an R2 binding is only
// stored if the Worker puts it in the Cache API or has Workers Cache turned
// on (`cache.enabled` in wrangler config); neither is used here. So every
// request, ranged or not, is served from R2 through this Worker. That's fine
// on cost: R2 has no egress fees, just one Class B operation per head()/get()
// call. The Cache-Control headers only matter to browsers and to shared caches
// between clients and Cloudflare (corporate proxies). If Workers Cache is ever
// enabled, re-test resumes: it strips Range before the Worker runs.
//
// Byte ranges, so `curl -C -`, BITS and download managers can resume a
// multi-GB transfer instead of restarting it, and so a <video> can seek (Safari
// won't play an MP4 at all without them): a GET with a single `Range: bytes=`
// spec gets a 206 with Content-Range; a malformed or out-of-bounds byte range
// gets a 416 with `Content-Range: bytes */<size>`; If-Range is honoured, so
// resuming after the object has been replaced gets a full 200 of the new one.
// Multi-range requests and other range units get the full 200 (RFC 9110 lets
// a server ignore Range).
//
// Conditional GET and HEAD: an If-None-Match (or, without one,
// If-Modified-Since) that matches the stored object gets a 304 with no body,
// so a cache holding the current version revalidates it without a download.

import type { Context } from 'hono';

export type ServeOptions = {
  contentType: string;
  cacheControl: string;
  /** Content-Disposition on 200, 206 and HEAD responses; none when unset. */
  contentDisposition?: string;
  /** More headers for 200, 206 and HEAD responses. */
  extraHeaders?: Record<string, string>;
  /** The response when there's no object at the key, including one deleted mid-request. */
  notFound: () => Response;
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
// Last-Modified to the second, which is precise enough for objects that are
// replaced by an upload, not edited. Without If-Range, Range always applies.
function ifRangeMatches(ifRange: string | undefined, obj: R2Object): boolean {
  if (ifRange === undefined) return true;
  const value = ifRange.trim();
  if (value.startsWith('"') || value.startsWith('W/')) return value === obj.httpEtag;
  const date = Date.parse(value);
  return (
    !Number.isNaN(date) && Math.floor(date / 1000) === Math.floor(obj.uploaded.getTime() / 1000)
  );
}

// Conditional GET/HEAD (RFC 9110 §13.1.2, §13.1.3): true when the client's
// copy is current, so a 304 can stand in for the body. If-None-Match takes
// precedence over If-Modified-Since and compares weakly, so W/"x" matches "x".
function notModified(c: Context, obj: R2Object): boolean {
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    const tags = ifNoneMatch.match(/(?:W\/)?"[^"]*"/g) ?? [];
    return tags.some((tag) => tag.replace(/^W\//, '') === obj.httpEtag);
  }
  const ifModifiedSince = c.req.header('If-Modified-Since');
  if (ifModifiedSince === undefined) return false;
  const date = Date.parse(ifModifiedSince);
  return (
    !Number.isNaN(date) && Math.floor(obj.uploaded.getTime() / 1000) <= Math.floor(date / 1000)
  );
}

// A 304 carries no body, just what a cache needs to refresh its stored copy
// (RFC 9110 §15.4.5).
function notModifiedResponse(obj: R2Object, opts: ServeOptions): Response {
  return new Response(null, {
    status: 304,
    headers: {
      'Cache-Control': opts.cacheControl,
      ETag: obj.httpEtag,
      'Last-Modified': obj.uploaded.toUTCString(),
    },
  });
}

// Headers for 200, 206 and HEAD responses. contentLength is the length of the
// body actually sent: the whole object, or just the requested range.
function objectHeaders(obj: R2Object, opts: ServeOptions, contentLength: number): Headers {
  const headers = new Headers(opts.extraHeaders);
  headers.set('Content-Type', opts.contentType);
  headers.set('Cache-Control', opts.cacheControl);
  headers.set('Content-Length', String(contentLength));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', obj.httpEtag);
  headers.set('Last-Modified', obj.uploaded.toUTCString());
  if (opts.contentDisposition) headers.set('Content-Disposition', opts.contentDisposition);
  return headers;
}

async function serveFull(bucket: R2Bucket, key: string, opts: ServeOptions): Promise<Response> {
  const obj = await bucket.get(key);
  if (!obj) return opts.notFound();
  return new Response(obj.body, { status: 200, headers: objectHeaders(obj, opts, obj.size) });
}

/**
 * Stream the R2 object at `key` with the right headers, honouring conditional
 * requests, and Range on GET. Answers GET and HEAD; Hono routes HEAD to GET
 * handlers, so mount this on a GET route and it checks the method itself.
 */
export async function serveR2Object(
  c: Context,
  bucket: R2Bucket,
  key: string,
  opts: ServeOptions,
): Promise<Response> {
  // Range is defined for GET only (RFC 9110 §14.2), so HEAD always describes
  // the whole object. head() means a HEAD never opens a read of the object.
  if (c.req.method === 'HEAD') {
    const meta = await bucket.head(key);
    if (!meta) return opts.notFound();
    if (notModified(c, meta)) return notModifiedResponse(meta, opts);
    return new Response(null, { status: 200, headers: objectHeaders(meta, opts, meta.size) });
  }

  const range = parseRange(c.req.header('Range'));
  const conditional =
    c.req.header('If-None-Match') !== undefined || c.req.header('If-Modified-Since') !== undefined;
  if (range.kind === 'none' && !conditional) return serveFull(bucket, key, opts);

  // Read the metadata first: a conditional GET may need only a 304, resolving
  // a range (or answering 416) needs the total size, and If-Range is checked
  // against the current ETag. Then fetch exactly those bytes, pinned with
  // onlyIf to the version just checked. An upload can replace the object in
  // place, and an unpinned read racing it would splice bytes of the new
  // version into a range computed against the old one. If the pin fails, the
  // object changed in between: start over against the new version, as if the
  // request had arrived after the upload.
  for (let attempt = 0; attempt < 2; attempt++) {
    const meta = await bucket.head(key);
    if (!meta) return opts.notFound();
    // Preconditions are evaluated before Range (RFC 9110 §13.2.2).
    if (notModified(c, meta)) return notModifiedResponse(meta, opts);
    // The whole object when there is no range to apply, the object is empty
    // (RFC 9110 lets a server ignore Range then), or If-Range is stale.
    if (
      range.kind === 'none' ||
      meta.size === 0 ||
      !ifRangeMatches(c.req.header('If-Range'), meta)
    ) {
      return serveFull(bucket, key, opts);
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
    if (!obj) return opts.notFound();
    if ('body' in obj) {
      const { offset, length } = byteRange;
      const headers = objectHeaders(obj, opts, length);
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
      return new Response(obj.body, { status: 206, headers });
    }
  }
  // Replaced on both attempts, which takes two uploads milliseconds apart.
  // A full 200 is always a valid answer to a Range request.
  return serveFull(bucket, key, opts);
}
