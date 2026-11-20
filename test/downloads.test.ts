// Unit tests for src/routes/downloads.ts, run against a mock R2 bucket.
//
//   npm test
//
// Covers the Range / If-Range logic plus what `wrangler dev` can't trigger on
// demand: the object being replaced or deleted between head() and get(), and
// which R2 calls each kind of request makes (each one is a Class B operation).
// test/downloads-dev.sh runs end-to-end checks against a local R2 bucket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import downloadsRoutes from '../src/routes/downloads.ts';

type Version = { etag: string; bytes: Uint8Array; uploaded: Date };
type Store = { cur: Version | null };
type GetOptions = { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } };

function version(etag: string, text: string, uploaded: string): Version {
  return { etag, bytes: new TextEncoder().encode(text), uploaded: new Date(uploaded) };
}

const BODY = 'version-one-0123456789'; // 22 bytes
const V1 = version('aaaa', BODY, '2026-11-01T00:00:00Z');
const V2 = version('bbbb', 'VERSION-TWO-abcdefghijklmnop', '2026-11-02T00:00:00Z'); // 28 bytes

// Stands in for the HASHDB_BUCKET binding and records each call. afterHead
// runs after every head() and may replace or delete the stored object, which
// simulates a publish landing mid-request.
function mockBucket(initial: Version | null, afterHead?: (n: number, store: Store) => void) {
  const store: Store = { cur: initial };
  const calls: string[] = [];
  const keys: string[] = [];
  let heads = 0;
  const meta = (key: string, v: Version) => ({
    key,
    etag: v.etag,
    httpEtag: `"${v.etag}"`,
    size: v.bytes.length,
    uploaded: v.uploaded,
  });
  const bucket = {
    async head(key: string) {
      calls.push('head');
      keys.push(key);
      const v = store.cur;
      afterHead?.(++heads, store);
      return v ? meta(key, v) : null;
    },
    async get(key: string, opts: GetOptions = {}) {
      const v = store.cur;
      const pin = opts.onlyIf?.etagMatches;
      calls.push(opts.range ? (pin ? 'get(range, pinned)' : 'get(range)') : 'get');
      keys.push(key);
      if (!v) return null;
      // Real R2 throws on a quoted ETag in onlyIf and on an offset past the end.
      if (pin?.startsWith('"')) throw new Error('Conditional ETag should not be wrapped in quotes');
      if (pin !== undefined && pin !== v.etag) return meta(key, v); // precondition failed: no body
      let bytes = v.bytes;
      if (opts.range) {
        const { offset, length } = opts.range;
        if (offset >= v.bytes.length) throw new Error('get: The requested range is not satisfiable (10039)');
        bytes = v.bytes.slice(offset, offset + length);
      }
      return { ...meta(key, v), body: new Response(bytes).body };
    },
  };
  return { bucket, calls, keys };
}

const ENV_KEYS = {
  HASHDB_BLOOM_KEY: 'current/hashdb.bin',
  HASHDB_SHA256_KEY: 'current/hashdb.sha256',
  HASHDB_META_KEY: 'current/hashdb.json',
};

async function request(
  bucket: object,
  init: { method?: string; headers?: Record<string, string> } = {},
  path = '/hashdb.bin',
) {
  const env = { HASHDB_BUCKET: bucket, ...ENV_KEYS };
  const res = await downloadsRoutes.fetch(new Request(`http://localhost${path}`, init), env);
  return { res, body: await res.text() };
}

test('plain GET: one get(), full 200 with Accept-Ranges', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res, body } = await request(bucket);
  assert.equal(res.status, 200);
  assert.equal(body, BODY);
  assert.equal(res.headers.get('content-length'), '22');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('etag'), '"aaaa"');
  assert.equal(res.headers.get('last-modified'), V1.uploaded.toUTCString());
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="hashdb.bin"');
  assert.equal(res.headers.get('content-range'), null);
  assert.deepEqual(calls, ['get']);
});

test('HEAD: one head(), whole-object headers, Range ignored, body never read', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res } = await request(bucket, { method: 'HEAD', headers: { Range: 'bytes=0-6' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '22');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('content-range'), null);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="hashdb.bin"');
  assert.deepEqual(calls, ['head']);
});

test('Range GET: head(), then a ranged get() pinned to that ETag', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=0-6' } });
  assert.equal(res.status, 206);
  assert.equal(body, 'version');
  assert.equal(res.headers.get('content-range'), 'bytes 0-6/22');
  assert.equal(res.headers.get('content-length'), '7');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('etag'), '"aaaa"');
  assert.deepEqual(calls, ['head', 'get(range, pinned)']);
});

test('Range syntax, resolved against a 22-byte object', async (t) => {
  // [Range header, status, Content-Range, body of a 206]
  const cases: [string, number, string | null, string?][] = [
    ['bytes=0-6', 206, 'bytes 0-6/22', 'version'],
    ['bytes=12-', 206, 'bytes 12-21/22', '0123456789'],
    ['bytes=-4', 206, 'bytes 18-21/22', '6789'],
    ['bytes=-100', 206, 'bytes 0-21/22', BODY], // suffix longer than the object
    ['bytes=18-1000', 206, 'bytes 18-21/22', '6789'], // last-pos clamped
    ['bytes=21-', 206, 'bytes 21-21/22', '9'],
    ['Bytes=0-0', 206, 'bytes 0-0/22', 'v'], // unit is case-insensitive
    ['bytes=0-6,', 206, 'bytes 0-6/22', 'version'], // empty list element
    ['bytes=22-', 416, 'bytes */22'],
    ['bytes=99999999999-', 416, 'bytes */22'],
    ['bytes=-0', 416, 'bytes */22'],
    ['bytes=5-2', 416, 'bytes */22'],
    ['bytes=abc', 416, 'bytes */22'],
    ['bytes=', 416, 'bytes */22'],
    ['bytes=0-1,5-6', 200, null], // multi-range: full object
    ['items=0-5', 200, null], // other unit: ignored
    ['garbage', 200, null],
  ];
  for (const [range, status, contentRange, partial] of cases) {
    await t.test(range, async () => {
      const { bucket } = mockBucket(V1);
      const { res, body } = await request(bucket, { headers: { Range: range } });
      assert.equal(res.status, status);
      assert.equal(res.headers.get('content-range'), contentRange);
      if (status === 206) {
        assert.equal(body, partial);
        assert.equal(res.headers.get('content-length'), String(body.length));
      }
      if (status === 200) assert.equal(body, BODY);
      if (status === 416) assert.equal(JSON.parse(body).error, 'range_not_satisfiable');
    });
  }
});

test('If-Range decides between a 206 and a full 200', async (t) => {
  const oneSecondLater = new Date(V1.uploaded.getTime() + 1000).toUTCString();
  const cases: [string, number][] = [
    ['"aaaa"', 206], // current ETag
    ['"zzzz"', 200], // another build's ETag
    ['W/"aaaa"', 200], // weak tags never match
    [V1.uploaded.toUTCString(), 206], // HTTP-date equal to Last-Modified
    [oneSecondLater, 200],
    ['not-a-validator', 200],
  ];
  for (const [ifRange, status] of cases) {
    await t.test(ifRange, async () => {
      const { bucket } = mockBucket(V1);
      const { res, body } = await request(bucket, {
        headers: { Range: 'bytes=0-6', 'If-Range': ifRange },
      });
      assert.equal(res.status, status);
      assert.equal(body, status === 206 ? 'version' : BODY);
    });
  }
});

test('If-Range without Range is ignored', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res } = await request(bucket, { headers: { 'If-Range': '"zzzz"' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['get']);
});

test('stale If-Range wins over a malformed Range: full 200, not 416', async () => {
  const { bucket } = mockBucket(V1);
  const stale = await request(bucket, { headers: { Range: 'bytes=5-2', 'If-Range': '"zzzz"' } });
  assert.equal(stale.res.status, 200);
  const current = await request(bucket, { headers: { Range: 'bytes=5-2', 'If-Range': '"aaaa"' } });
  assert.equal(current.res.status, 416);
});

test('416 costs one head() and reports the size', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res } = await request(bucket, { headers: { Range: 'bytes=22-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */22');
  assert.deepEqual(calls, ['head']);
});

test('stale If-Range: head(), then one full get()', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=0-6', 'If-Range': '"zzzz"' } });
  assert.equal(res.status, 200);
  assert.equal(body, BODY);
  assert.deepEqual(calls, ['head', 'get']);
});

// A publish replacing the object between head() and get(): the pinned read
// returns no body, and the request is re-evaluated against the new version.
const replaceWith = (v: Version | null) => (n: number, store: Store) => {
  if (n === 1) store.cur = v;
};

test('replaced mid-request, no If-Range: 206 of the new build, its size in Content-Range', async () => {
  const { bucket, calls } = mockBucket(V1, replaceWith(V2));
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=12-' } });
  assert.equal(res.status, 206);
  assert.equal(body, 'abcdefghijklmnop');
  assert.equal(res.headers.get('content-range'), 'bytes 12-27/28');
  assert.equal(res.headers.get('etag'), '"bbbb"');
  assert.deepEqual(calls, ['head', 'get(range, pinned)', 'head', 'get(range, pinned)']);
});

test('replaced mid-request, If-Range of the old build: full 200 of the new build', async () => {
  const { bucket, calls } = mockBucket(V1, replaceWith(V2));
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=12-', 'If-Range': '"aaaa"' } });
  assert.equal(res.status, 200);
  assert.equal(body, 'VERSION-TWO-abcdefghijklmnop');
  assert.equal(res.headers.get('etag'), '"bbbb"');
  assert.deepEqual(calls, ['head', 'get(range, pinned)', 'head', 'get']);
});

test('replaced by a smaller build that the range overruns: 416 with the new size', async () => {
  const { bucket, calls } = mockBucket(V2, replaceWith(V1));
  const { res } = await request(bucket, { headers: { Range: 'bytes=25-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */22');
  assert.deepEqual(calls, ['head', 'get(range, pinned)', 'head']);
});

test('replaced on every attempt: gives up and serves a full 200', async () => {
  const flip = (_n: number, store: Store) => {
    store.cur = store.cur === V1 ? V2 : V1;
  };
  const { bucket, calls } = mockBucket(V1, flip);
  const { res } = await request(bucket, { headers: { Range: 'bytes=0-6' } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['head', 'get(range, pinned)', 'head', 'get(range, pinned)', 'get']);
});

test('deleted between head() and get(): 404', async () => {
  const { bucket, calls } = mockBucket(V1, replaceWith(null));
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=0-6' } });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(body).error, 'hashdb_not_published');
  assert.deepEqual(calls, ['head', 'get(range, pinned)']);
});

test('missing object: 404 for GET, Range GET and HEAD', async () => {
  for (const init of [{}, { headers: { Range: 'bytes=0-6' } }, { method: 'HEAD' }]) {
    const { bucket } = mockBucket(null);
    const { res } = await request(bucket, init);
    assert.equal(res.status, 404);
  }
});

test('empty object: Range is ignored, full 200', async () => {
  const { bucket } = mockBucket(version('eeee', '', '2026-11-03T00:00:00Z'));
  const { res, body } = await request(bucket, { headers: { Range: 'bytes=0-' } });
  assert.equal(res.status, 200);
  assert.equal(body, '');
});

test('sidecars use their own keys and content types, with the same Range handling', async () => {
  const routes: [string, string, string][] = [
    ['/hashdb.sha256', ENV_KEYS.HASHDB_SHA256_KEY, 'text/plain; charset=utf-8'],
    ['/hashdb.json', ENV_KEYS.HASHDB_META_KEY, 'application/json; charset=utf-8'],
  ];
  for (const [path, key, contentType] of routes) {
    const { bucket, keys } = mockBucket(V1);
    const { res, body } = await request(bucket, { headers: { Range: 'bytes=0-6' } }, path);
    assert.equal(res.status, 206);
    assert.equal(body, 'version');
    assert.equal(res.headers.get('content-type'), contentType);
    assert.equal(res.headers.get('content-disposition'), null);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
    assert.deepEqual(keys, [key, key]);
  }
});
