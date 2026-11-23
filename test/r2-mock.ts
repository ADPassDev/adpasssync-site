// A mock R2 bucket binding for the route tests (test/downloads.test.ts,
// test/media.test.ts). Not a test file itself: `npm test` only runs *.test.ts.

export type Version = { etag: string; bytes: Uint8Array; uploaded: Date };
export type Store = { cur: Version | null };
type GetOptions = { range?: { offset: number; length: number }; onlyIf?: { etagMatches?: string } };

export function version(etag: string, text: string | Uint8Array, uploaded: string): Version {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return { etag, bytes, uploaded: new Date(uploaded) };
}

// Stands in for an R2Bucket binding holding one object, and records each call.
// afterHead runs after every head() and may replace or delete the stored
// object, which simulates an upload landing mid-request.
export function mockBucket(initial: Version | null, afterHead?: (n: number, store: Store) => void) {
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
