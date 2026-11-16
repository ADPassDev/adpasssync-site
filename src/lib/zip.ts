// ZIP helpers for the portal download.
//
// The download is the published release package (built by the product repo's
// installer/Publish-Release.ps1) with the customer's license-key.txt and a
// README.txt added. Rather than unpack and rebuild a ~45 MB archive inside a
// Worker, we append to it:
//
//   [original entries, byte-for-byte] [new entries] [central directory] [EOCD]
//
// The original central-directory records are copied unchanged. Their local
// header offsets stay valid because nothing before them moves, and the new
// records follow them. Only the archive's tail (the old central directory) is
// read into memory; the entry data streams straight from R2 to the client.
//
// Scope: single-disk archives without ZIP64 records, which is what .NET's
// ZipFile.CreateFromDirectory (used by the publish script) writes for anything
// under 4 GiB. Anything else is rejected rather than guessed at.

const TEXT_ENCODER = new TextEncoder();
const UTF8 = new TextDecoder('utf-8');

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

// "Version made by" / "version needed": 2.0, MS-DOS attributes. The same
// values the release zip's own entries carry.
const ZIP_VERSION = 20;
const FLAG_UTF8_NAME = 0x0800;

/** Reading this many bytes from the end of an archive always includes the EOCD record. */
export const ZIP_TAIL_BYTES = EOCD_SIZE + MAX_COMMENT_LENGTH;

export class ZipFormatError extends Error {
  override name = 'ZipFormatError';
}

// Standard CRC-32 (polynomial 0xEDB88320).
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Location of an archive's central directory, from its end-of-central-directory record. */
export type ZipDirectory = {
  /** Offset of the first central-directory record, which is also where entry data ends. */
  cdOffset: number;
  cdSize: number;
  entryCount: number;
  comment: Uint8Array;
};

/** One central-directory record, kept as raw bytes so it can be copied verbatim. */
export type ZipCentralRecord = {
  name: string;
  bytes: Uint8Array;
};

export type ZipEntryInput = { name: string; data: Uint8Array | string };

export type ZipAppendPlan = {
  /** Send bytes [0, keepLength) of the original archive unchanged... */
  keepLength: number;
  /** ...then these: the new entries, the rebuilt central directory and the EOCD record. */
  trailer: Uint8Array;
  /** keepLength + trailer.byteLength: the Content-Length of the result. */
  totalLength: number;
};

/**
 * Finds the end-of-central-directory record in `tail`, the last
 * `tail.byteLength` bytes of an archive that is `archiveSize` bytes long.
 */
export function readZipDirectory(tail: Uint8Array, archiveSize: number): ZipDirectory {
  const tailStart = archiveSize - tail.byteLength;
  if (tailStart < 0) throw new ZipFormatError('tail is longer than the archive');
  const dv = view(tail);
  const lowest = Math.max(0, tail.byteLength - ZIP_TAIL_BYTES);

  // The EOCD record is last in the file and its comment runs to the very end,
  // so scan backwards for a signature whose comment length fits exactly.
  for (let p = tail.byteLength - EOCD_SIZE; p >= lowest; p--) {
    if (dv.getUint32(p, true) !== SIG_EOCD) continue;
    const commentLength = dv.getUint16(p + 20, true);
    if (p + EOCD_SIZE + commentLength !== tail.byteLength) continue;

    const disk = dv.getUint16(p + 4, true);
    const cdDisk = dv.getUint16(p + 6, true);
    const entriesOnDisk = dv.getUint16(p + 8, true);
    const entryCount = dv.getUint16(p + 10, true);
    const cdSize = dv.getUint32(p + 12, true);
    const cdOffset = dv.getUint32(p + 16, true);

    const zip64Locator = p >= 20 && dv.getUint32(p - 20, true) === SIG_ZIP64_EOCD_LOCATOR;
    if (zip64Locator || entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipFormatError('ZIP64 archives are not supported');
    }
    if (disk !== 0 || cdDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ZipFormatError('multi-disk archives are not supported');
    }
    // Rejects prepended data (self-extractors) and anything between the
    // central directory and the EOCD, either of which would make the
    // "keep everything before the central directory" step wrong.
    if (cdOffset + cdSize !== tailStart + p) {
      throw new ZipFormatError('central directory does not end at the EOCD record');
    }
    return { cdOffset, cdSize, entryCount, comment: tail.slice(p + EOCD_SIZE) };
  }
  throw new ZipFormatError('end of central directory record not found');
}

/** Splits the central directory `bytes` (exactly `dir.cdSize` long) into its records. */
export function readCentralDirectory(dir: ZipDirectory, bytes: Uint8Array): ZipCentralRecord[] {
  if (bytes.byteLength !== dir.cdSize) {
    throw new ZipFormatError(`central directory is ${bytes.byteLength} bytes, expected ${dir.cdSize}`);
  }
  const dv = view(bytes);
  const records: ZipCentralRecord[] = [];
  let p = 0;
  while (p < bytes.byteLength) {
    if (p + CENTRAL_HEADER_SIZE > bytes.byteLength || dv.getUint32(p, true) !== SIG_CENTRAL_HEADER) {
      throw new ZipFormatError(`bad central directory record at offset ${dir.cdOffset + p}`);
    }
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const localHeaderOffset = dv.getUint32(p + 42, true);
    const end = p + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) {
      throw new ZipFormatError(`central directory record at offset ${dir.cdOffset + p} is truncated`);
    }
    if (localHeaderOffset >= dir.cdOffset) {
      throw new ZipFormatError(`entry at offset ${localHeaderOffset} lies outside the entry data`);
    }
    const name = UTF8.decode(bytes.subarray(p + CENTRAL_HEADER_SIZE, p + CENTRAL_HEADER_SIZE + nameLength));
    records.push({ name, bytes: bytes.subarray(p, end) });
    p = end;
  }
  if (records.length !== dir.entryCount) {
    throw new ZipFormatError(`central directory has ${records.length} records, EOCD says ${dir.entryCount}`);
  }
  return records;
}

/**
 * Plans appending `additions` (stored, uncompressed) to an archive. An original
 * entry whose name matches an addition (case-insensitively) is left out of the
 * new central directory, so the added file replaces it; its bytes stay in the
 * kept data, unreferenced.
 */
export function planZipAppend(
  dir: ZipDirectory,
  records: ZipCentralRecord[],
  additions: ZipEntryInput[],
  modified: Date,
): ZipAppendPlan {
  const replaced = new Set(additions.map((a) => a.name.toLowerCase()));
  const kept = records.filter((r) => !replaced.has(r.name.toLowerCase()));
  const { time, date } = dosDateTime(modified);

  const files = additions.map((a) => {
    const data = typeof a.data === 'string' ? TEXT_ENCODER.encode(a.data) : a.data;
    return {
      name: TEXT_ENCODER.encode(a.name),
      data,
      crc: crc32(data),
      flags: /^[\x20-\x7e]*$/.test(a.name) ? 0 : FLAG_UTF8_NAME,
    };
  });

  let localSize = 0;
  for (const f of files) localSize += LOCAL_HEADER_SIZE + f.name.byteLength + f.data.byteLength;
  let centralSize = 0;
  for (const r of kept) centralSize += r.bytes.byteLength;
  for (const f of files) centralSize += CENTRAL_HEADER_SIZE + f.name.byteLength;

  const entryCount = kept.length + files.length;
  const newCdOffset = dir.cdOffset + localSize;
  const totalLength = newCdOffset + centralSize + EOCD_SIZE + dir.comment.byteLength;
  if (entryCount >= 0xffff || totalLength >= 0xffffffff) {
    throw new ZipFormatError('appending would need ZIP64');
  }

  const trailer = new Uint8Array(totalLength - dir.cdOffset);
  const dv = view(trailer);
  let p = 0;

  const localOffsets: number[] = [];
  for (const f of files) {
    localOffsets.push(dir.cdOffset + p);
    dv.setUint32(p, SIG_LOCAL_HEADER, true);
    dv.setUint16(p + 4, ZIP_VERSION, true); // version needed to extract
    dv.setUint16(p + 6, f.flags, true);
    dv.setUint16(p + 8, 0, true); // compression: stored
    dv.setUint16(p + 10, time, true);
    dv.setUint16(p + 12, date, true);
    dv.setUint32(p + 14, f.crc, true);
    dv.setUint32(p + 18, f.data.byteLength, true); // compressed size
    dv.setUint32(p + 22, f.data.byteLength, true); // uncompressed size
    dv.setUint16(p + 26, f.name.byteLength, true);
    dv.setUint16(p + 28, 0, true); // extra field length
    trailer.set(f.name, p + LOCAL_HEADER_SIZE);
    trailer.set(f.data, p + LOCAL_HEADER_SIZE + f.name.byteLength);
    p += LOCAL_HEADER_SIZE + f.name.byteLength + f.data.byteLength;
  }

  // Central directory: the original records first, so archive listings show
  // the release files before the per-customer ones.
  for (const r of kept) {
    trailer.set(r.bytes, p);
    p += r.bytes.byteLength;
  }
  files.forEach((f, i) => {
    dv.setUint32(p, SIG_CENTRAL_HEADER, true);
    dv.setUint16(p + 4, ZIP_VERSION, true); // version made by
    dv.setUint16(p + 6, ZIP_VERSION, true); // version needed to extract
    dv.setUint16(p + 8, f.flags, true);
    dv.setUint16(p + 10, 0, true); // compression: stored
    dv.setUint16(p + 12, time, true);
    dv.setUint16(p + 14, date, true);
    dv.setUint32(p + 16, f.crc, true);
    dv.setUint32(p + 20, f.data.byteLength, true);
    dv.setUint32(p + 24, f.data.byteLength, true);
    dv.setUint16(p + 28, f.name.byteLength, true);
    // Extra field, comment, disk number, internal and external attributes: all 0.
    dv.setUint32(p + 42, localOffsets[i]!, true);
    trailer.set(f.name, p + CENTRAL_HEADER_SIZE);
    p += CENTRAL_HEADER_SIZE + f.name.byteLength;
  });

  dv.setUint32(p, SIG_EOCD, true);
  dv.setUint16(p + 4, 0, true); // this disk
  dv.setUint16(p + 6, 0, true); // disk where the central directory starts
  dv.setUint16(p + 8, entryCount, true);
  dv.setUint16(p + 10, entryCount, true);
  dv.setUint32(p + 12, centralSize, true);
  dv.setUint32(p + 16, newCdOffset, true);
  dv.setUint16(p + 20, dir.comment.byteLength, true);
  trailer.set(dir.comment, p + EOCD_SIZE);

  return { keepLength: dir.cdOffset, trailer, totalLength };
}

/** MS-DOS date and time fields, in UTC, with 2-second resolution. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}
