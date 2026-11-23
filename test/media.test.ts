// Unit tests for src/routes/media.ts, run against a mock R2 bucket
// (test/r2-mock.ts). The Range and conditional-request logic it shares with
// /downloads/* is covered in depth by test/downloads.test.ts; these check what
// /media/* adds: which names are looked up, the headers a <video> needs, and
// that a bad name never costs an R2 call.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import mediaRoutes from '../src/routes/media.ts';
import { mockBucket, version } from './r2-mock.ts';

const BYTES = new Uint8Array(1000).map((_, i) => i % 251);
const VIDEO = version('vvvv', BYTES, '2026-11-22T00:00:00Z');

async function request(
  bucket: object,
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) {
  const res = await mediaRoutes.fetch(new Request(`http://localhost${path}`, init), {
    MEDIA_BUCKET: bucket,
  });
  return { res, body: new Uint8Array(await res.arrayBuffer()) };
}

test('GET: the whole video, inline, with the headers a <video> needs', async () => {
  const { bucket, calls, keys } = mockBucket(VIDEO);
  const { res, body } = await request(bucket, '/installation-walkthrough.mp4');
  assert.equal(res.status, 200);
  assert.deepEqual(body, BYTES);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-length'), '1000');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('etag'), '"vvvv"');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(
    res.headers.get('content-disposition'),
    'inline; filename="installation-walkthrough.mp4"',
  );
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls, ['get']);
  assert.deepEqual(keys, ['installation-walkthrough.mp4']);
});

test('Range GET: 206 with Content-Range, as a <video> seek sends', async () => {
  const { bucket, calls } = mockBucket(VIDEO);
  const { res, body } = await request(bucket, '/installation-walkthrough.mp4', {
    headers: { Range: 'bytes=900-' },
  });
  assert.equal(res.status, 206);
  assert.deepEqual(body, BYTES.slice(900));
  assert.equal(res.headers.get('content-range'), 'bytes 900-999/1000');
  assert.equal(res.headers.get('content-length'), '100');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls, ['head', 'get(range, pinned)']);
});

test('Range past the end: 416 with the size', async () => {
  const { bucket } = mockBucket(VIDEO);
  const { res } = await request(bucket, '/installation-walkthrough.mp4', {
    headers: { Range: 'bytes=1000-' },
  });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */1000');
});

test('HEAD: headers only, without reading the object', async () => {
  const { bucket, calls } = mockBucket(VIDEO);
  const { res, body } = await request(bucket, '/installation-walkthrough.mp4', { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(body.length, 0);
  assert.equal(res.headers.get('content-length'), '1000');
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(calls, ['head']);
});

test('conditional GET with the current ETag: 304', async () => {
  const { bucket, calls } = mockBucket(VIDEO);
  const { res, body } = await request(bucket, '/installation-walkthrough.mp4', {
    headers: { 'If-None-Match': '"vvvv"' },
  });
  assert.equal(res.status, 304);
  assert.equal(body.length, 0);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  assert.deepEqual(calls, ['head']);
});

test('content type comes from the extension', async (t) => {
  const cases: Array<[string, string]> = [
    ['/installation-walkthrough.webm', 'video/webm'],
    ['/installation-walkthrough.en.vtt', 'text/vtt; charset=utf-8'],
    ['/v2_intro.mp4', 'video/mp4'],
  ];
  for (const [path, type] of cases) {
    await t.test(path, async () => {
      const { bucket, keys } = mockBucket(VIDEO);
      const { res } = await request(bucket, path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), type);
      assert.deepEqual(keys, [path.slice(1)]);
    });
  }
});

test('missing object: JSON 404', async () => {
  const { bucket, calls } = mockBucket(null);
  for (const method of ['GET', 'HEAD']) {
    const { res, body } = await request(bucket, '/nothing-here.mp4', { method });
    assert.equal(res.status, 404);
    if (method === 'GET') {
      assert.equal(JSON.parse(new TextDecoder().decode(body)).error, 'not_found');
    }
  }
  assert.deepEqual(calls, ['get', 'head']);
});

test('names that are not media files: 404 without touching R2', async (t) => {
  const bad = [
    '/installation-walkthrough.MP4', // upper case
    '/Installation-walkthrough.mp4',
    '/installation-walkthrough.html',
    '/installation-walkthrough.svg',
    '/installation-walkthrough.mp4.exe',
    '/installation-walkthrough', // no extension
    '/.mp4',
    '/.hidden.mp4',
    '/a..mp4',
    '/a--b.mp4',
    '/-a.mp4',
    '/a%2Fb.mp4', // decodes to a/b.mp4
    '/a%22b.mp4', // a quote would break out of Content-Disposition
    '/a%20b.mp4',
    '/caf%C3%A9.mp4',
    `/${'a'.repeat(125)}.mp4`, // 129 characters
    '/sub/dir.mp4',
    '/',
  ];
  for (const path of bad) {
    await t.test(path, async () => {
      const { bucket, calls } = mockBucket(VIDEO);
      const { res } = await request(bucket, path);
      assert.equal(res.status, 404);
      assert.deepEqual(calls, []);
    });
  }
});

test('the longest accepted name is 128 characters', async () => {
  const { bucket, keys } = mockBucket(VIDEO);
  const name = `${'a'.repeat(124)}.mp4`;
  const { res } = await request(bucket, `/${name}`);
  assert.equal(res.status, 200);
  assert.deepEqual(keys, [name]);
});
