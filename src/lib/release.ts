// The published release, read from the adpasssync-releases R2 bucket.
//
// The product repo's installer/Publish-Release.ps1 is the only writer, and the
// adpasssync-downloads Worker serves the same bucket publicly under
// /downloads/installer/. Layout:
//
//   latest.json          manifest of the current release (60 s edge TTL)
//   v<release>/<file>    immutable artifacts; exactly one is the bundled
//                        package (type "zip"): both MSIs, both guides and
//                        SHA256SUMS.txt
//
// latest.json is uploaded last, so every file it names is already in place.

import type { Env } from '../types';
import {
  ZIP_TAIL_BYTES,
  planZipAppend,
  readCentralDirectory,
  readZipDirectory,
  type ZipCentralRecord,
  type ZipDirectory,
  type ZipEntryInput,
} from './zip';

export type ReleaseFile = {
  name: string;
  type: string;
  product_version: string | null;
  size: number | null;
  sha256: string | null;
  signed: boolean | null;
};

export type Release = {
  version: string;
  released_at: string | null;
  files: ReleaseFile[];
};

/** The release package opened and ready to stream, with its zip directory already read. */
export type ReleasePackage = {
  release: Release;
  file: ReleaseFile;
  key: string;
  etag: string;
  dir: ZipDirectory;
  records: ZipCentralRecord[];
};

/** The release can't be served: no manifest, no package, or the package is missing or unreadable. */
export class ReleaseUnavailableError extends Error {
  override name = 'ReleaseUnavailableError';
}

// The version and the package's file name end up in an R2 key and in a
// Content-Disposition header, so both are held to a plain character set.
// Publish-Release.ps1 versions (e.g. 0.9.4.0) and file names fit easily.
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const FILE_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,199}$/;

export async function loadLatestRelease(env: Env): Promise<Release> {
  const obj = await env.RELEASES_BUCKET.get(env.RELEASE_MANIFEST_KEY);
  if (!obj) {
    throw new ReleaseUnavailableError(`no release manifest at ${env.RELEASE_MANIFEST_KEY}`);
  }
  let raw: unknown;
  try {
    raw = await obj.json();
  } catch (e) {
    throw new ReleaseUnavailableError(`release manifest is not valid JSON: ${String(e)}`);
  }
  return parseRelease(raw);
}

/**
 * Validates a parsed latest.json. Unknown fields are ignored, and so are file
 * entries without a string name and type: only the package is ever served,
 * and releasePackageFile checks that one strictly.
 */
export function parseRelease(raw: unknown): Release {
  const m = raw as { version?: unknown; released_at?: unknown; files?: unknown } | null;
  if (!m || typeof m !== 'object') throw new ReleaseUnavailableError('release manifest is not an object');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) {
    throw new ReleaseUnavailableError(`release manifest has an invalid version: ${JSON.stringify(m.version)}`);
  }
  if (!Array.isArray(m.files)) throw new ReleaseUnavailableError('release manifest has no files list');
  const files = m.files.flatMap((f: unknown): ReleaseFile[] => {
    const o = f as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.name !== 'string' || typeof o.type !== 'string') return [];
    return [
      {
        name: o.name,
        type: o.type,
        product_version: typeof o.product_version === 'string' ? o.product_version : null,
        size: typeof o.size === 'number' && Number.isSafeInteger(o.size) && o.size >= 0 ? o.size : null,
        sha256: typeof o.sha256 === 'string' ? o.sha256 : null,
        signed: typeof o.signed === 'boolean' ? o.signed : null,
      },
    ];
  });
  return {
    version: m.version,
    released_at: typeof m.released_at === 'string' ? m.released_at : null,
    files,
  };
}

/** The bundled download (type "zip") of a release. */
export function releasePackageFile(release: Release): ReleaseFile {
  const zips = release.files.filter((f) => f.type === 'zip');
  if (zips.length !== 1) {
    throw new ReleaseUnavailableError(
      `release ${release.version} lists ${zips.length} packages of type "zip", expected 1`,
    );
  }
  const pkg = zips[0]!;
  if (!FILE_NAME_RE.test(pkg.name)) {
    throw new ReleaseUnavailableError(`release ${release.version} package has an invalid name`);
  }
  return pkg;
}

/** R2 key of a release file. The "installer/" in its public URL is routing only. */
export function releaseObjectKey(release: Release, file: ReleaseFile): string {
  return `v${release.version}/${file.name}`;
}

/**
 * Loads latest.json and opens its package: checks the object exists and reads
 * its zip directory, so that a broken release fails here, before the caller
 * issues a license or records a download.
 */
export async function openLatestReleasePackage(env: Env): Promise<ReleasePackage> {
  const release = await loadLatestRelease(env);
  const file = releasePackageFile(release);
  const key = releaseObjectKey(release, file);
  const bucket = env.RELEASES_BUCKET;

  const head = await bucket.head(key);
  if (!head) throw new ReleaseUnavailableError(`no R2 object at ${key}`);

  // Every read below is pinned to this etag, so the pieces of the response
  // can never come from two different uploads of the same key.
  const tailLength = Math.min(ZIP_TAIL_BYTES, head.size);
  const tailStart = head.size - tailLength;
  const tail = await readRange(bucket, key, head.etag, tailStart, tailLength);
  const dir = readZipDirectory(tail, head.size);
  const cd =
    dir.cdOffset >= tailStart
      ? tail.subarray(dir.cdOffset - tailStart, dir.cdOffset - tailStart + dir.cdSize)
      : await readRange(bucket, key, head.etag, dir.cdOffset, dir.cdSize);
  const records = readCentralDirectory(dir, cd);

  return { release, file, key, etag: head.etag, dir, records };
}

/**
 * Streams the package with `additions` appended as new zip entries (see
 * planZipAppend). The original entry data goes from R2 to the client without
 * being buffered, and the stream carries the result's exact length.
 */
export async function streamReleasePackage(
  env: Env,
  ctx: ExecutionContext,
  pkg: ReleasePackage,
  additions: ZipEntryInput[],
  now: Date,
): Promise<ReadableStream<Uint8Array>> {
  const plan = planZipAppend(pkg.dir, pkg.records, additions, now);

  let source: ReadableStream<Uint8Array> | null = null;
  if (plan.keepLength > 0) {
    const obj = await env.RELEASES_BUCKET.get(pkg.key, {
      range: { offset: 0, length: plan.keepLength },
      onlyIf: { etagMatches: pkg.etag },
    });
    if (!obj || !('body' in obj)) {
      throw new ReleaseUnavailableError(`${pkg.key} changed or disappeared while it was being read`);
    }
    source = obj.body;
  }

  // FixedLengthStream sets Content-Length, and errors the response if the
  // byte count comes out different instead of sending a corrupt archive.
  const { readable, writable } = new FixedLengthStream(plan.totalLength);
  const pump = (async () => {
    if (source) await source.pipeTo(writable, { preventClose: true });
    const writer = writable.getWriter();
    await writer.write(plan.trailer);
    await writer.close();
  })();
  ctx.waitUntil(
    pump.catch((err) => console.error(`streaming ${pkg.key} failed`, err)),
  );
  return readable;
}

async function readRange(
  bucket: R2Bucket,
  key: string,
  etag: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const obj = await bucket.get(key, { range: { offset, length }, onlyIf: { etagMatches: etag } });
  if (!obj || !('body' in obj)) {
    throw new ReleaseUnavailableError(`${key} changed or disappeared while it was being read`);
  }
  return new Uint8Array(await obj.arrayBuffer());
}
