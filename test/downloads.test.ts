// Unit tests for src/routes/downloads.ts (and the src/lib/r2-serve.ts logic
// behind it), run against a mock R2 bucket (test/r2-mock.ts).
//
//   npm test
//
// Covers the Range, If-Range and conditional-request (304) logic, plus what
// `wrangler dev` can't trigger on demand: the object being replaced or
// deleted between head() and get(), and which R2 calls each kind of request
// makes (each one is a Class B operation).
// test/downloads-dev.sh runs end-to-end checks against a local R2 bucket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import downloadsRoutes from '../src/routes/downloads.ts';
import { mockBucket, version, type Store, type Version } from './r2-mock.ts';

const BODY = 'version-one-0123456789'; // 22 bytes
const V1 = version('aaaa', BODY, '2026-11-01T00:00:00Z');
const V2 = version('bbbb', 'VERSION-TWO-abcdefghijklmnop', '2026-11-02T00:00:00Z'); // 28 bytes

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
  assert.equal(res.headers.get('cache-control'), 'public, no-cache');
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

test('conditional GET: 304 when the client copy is current, otherwise the full 200', async (t) => {
  const lastModified = V1.uploaded.toUTCString();
  const oneSecondEarlier = new Date(V1.uploaded.getTime() - 1000).toUTCString();
  const cases: [Record<string, string>, number][] = [
    [{ 'If-None-Match': '"aaaa"' }, 304],
    [{ 'If-None-Match': 'W/"aaaa"' }, 304], // If-None-Match compares weakly
    [{ 'If-None-Match': '"zzzz", "aaaa"' }, 304],
    [{ 'If-None-Match': '*' }, 304],
    [{ 'If-None-Match': '"zzzz"' }, 200],
    [{ 'If-Modified-Since': lastModified }, 304],
    [{ 'If-Modified-Since': oneSecondEarlier }, 200],
    [{ 'If-Modified-Since': 'not-a-date' }, 200],
    [{ 'If-None-Match': '"zzzz"', 'If-Modified-Since': lastModified }, 200], // If-None-Match wins
  ];
  for (const [headers, status] of cases) {
    await t.test(JSON.stringify(headers), async () => {
      const { bucket } = mockBucket(V1);
      const { res, body } = await request(bucket, { headers });
      assert.equal(res.status, status);
      if (status === 304) {
        assert.equal(body, '');
        assert.equal(res.headers.get('etag'), '"aaaa"');
        assert.equal(res.headers.get('last-modified'), lastModified);
        assert.equal(res.headers.get('cache-control'), 'public, no-cache');
      } else {
        assert.equal(body, BODY);
      }
    });
  }
});

test('conditional GET: one head() for a 304, head() then get() for a changed object', async () => {
  const current = mockBucket(V1);
  await request(current.bucket, { headers: { 'If-None-Match': '"aaaa"' } });
  assert.deepEqual(current.calls, ['head']);
  const changed = mockBucket(V1);
  await request(changed.bucket, { headers: { 'If-None-Match': '"zzzz"' } });
  assert.deepEqual(changed.calls, ['head', 'get']);
});

test('HEAD with a current If-None-Match: 304', async () => {
  const { bucket, calls } = mockBucket(V1);
  const { res } = await request(bucket, { method: 'HEAD', headers: { 'If-None-Match': '"aaaa"' } });
  assert.equal(res.status, 304);
  assert.deepEqual(calls, ['head']);
});

test('a current If-None-Match wins over Range; a stale one leaves Range alone', async () => {
  const current = await request(mockBucket(V1).bucket, {
    headers: { Range: 'bytes=0-6', 'If-None-Match': '"aaaa"' },
  });
  assert.equal(current.res.status, 304);
  const stale = await request(mockBucket(V1).bucket, {
    headers: { Range: 'bytes=0-6', 'If-None-Match': '"zzzz"' },
  });
  assert.equal(stale.res.status, 206);
  assert.equal(stale.body, 'version');
});

test('after a publish, a cache revalidating with the old ETag gets the new build', async () => {
  const { bucket } = mockBucket(V2);
  const { res, body } = await request(bucket, { headers: { 'If-None-Match': '"aaaa"' } });
  assert.equal(res.status, 200);
  assert.equal(body, 'VERSION-TWO-abcdefghijklmnop');
  assert.equal(res.headers.get('etag'), '"bbbb"');
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
    assert.equal(res.headers.get('cache-control'), 'public, no-cache');
    assert.deepEqual(keys, [key, key]);
  }
});
