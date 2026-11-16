// Tests for src/lib/zip.ts. Run with `npm test`.
//
// The fixtures were written by Python's zipfile module, not by the code under
// test, and every result is checked by an independent reader below that walks
// the central directory, checks each local header, and inflates entries with
// node:zlib to verify their CRC-32.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import {
  ZIP_TAIL_BYTES,
  ZipFormatError,
  crc32,
  planZipAppend,
  readCentralDirectory,
  readZipDirectory,
  type ZipEntryInput,
} from '../src/lib/zip.ts';

// a.txt + b.bin (deflated), archive comment "release comment, kept verbatim".
const WITH_COMMENT = b64(
  'UEsDBBQAAAAIAPEFcF0szHgoDAAAAPQBAAAFAAAAYS50eHRLzCnISEwcJUYSAQBQSwMEFAAAAAgA8QVwXWwruMMnAQAAAAoAAAUAAABiLmJpbmNgZGJmYWVj5+Dk4ubh5eMXEBQSFhEVE5eQlJKWkZWTV1BUUlZRVVPX0NTS1tHV0zcwNDI2MTUzt7C0sraxtbN3cHRydnF1c/fw9PL28fXzDwgMCg4JDQuPiIyKjomNi09ITEpOSU1Lz8jMys7JzcsvKCwqLiktK6+orKquqa2rb2hsam5pbWvv6Ozq7unt658wcdLkKVOnTZ8xc9bsOXPnzV+wcNHiJUuXLV+xctXqNWvXrd+wcdPmLVu3bd+xc9fuPXv37T9w8NDhI0ePHT9x8tTpM2fPnb9w8dLlK1evXb9x89btO3fv3X/w8NHjJ0+fPX/x8tXrN2/fvf/w8dPnL1+/ff/x89fvP3///WcY9f+o/0f9P+r/Uf+P+n/U/6P+H2H+BwBQSwECFAMUAAAACADxBXBdLMx4KAwAAAD0AQAABQAAAAAAAAAAAAAAgAEAAAAAYS50eHRQSwECFAMUAAAACADxBXBdbCu4wycBAAAACgAABQAAAAAAAAAAAAAAgAEvAAAAYi5iaW5QSwUGAAAAAAIAAgBmAAAAeQEAAB4AcmVsZWFzZSBjb21tZW50LCBrZXB0IHZlcmJhdGlt',
);
// readme.TXT + keep.txt (deflated), no comment.
const WITH_README = b64(
  'UEsDBBQAAAAIAPEFcF229drUDAAAAAoAAAAKAAAAcmVhZG1lLlRYVMvPSVEoSk1MyU0FAFBLAwQUAAAACADxBXBd9MfPowkAAAAHAAAACAAAAGtlZXAudHh0y05NLVDITQUAUEsBAhQDFAAAAAgA8QVwXbb12tQMAAAACgAAAAoAAAAAAAAAAAAAAIABAAAAAHJlYWRtZS5UWFRQSwECFAMUAAAACADxBXBd9MfPowkAAAAHAAAACAAAAAAAAAAAAAAAgAE0AAAAa2VlcC50eHRQSwUGAAAAAAIAAgBuAAAAYwAAAAAA',
);
// A zero-entry archive: just the 22-byte end-of-central-directory record.
const EMPTY = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);

const ADDITIONS: ZipEntryInput[] = [
  { name: 'license-key.txt', data: '{"payload":{},"signature":""}\n' },
  { name: 'README.txt', data: 'Account: jane@example.com\r\n' },
];
const WHEN = new Date('2026-11-16T01:02:03Z');

function b64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/** Runs the same steps as the Worker: read the tail, the directory, plan, splice. */
function append(archive: Uint8Array, additions = ADDITIONS): Uint8Array {
  const tail = archive.subarray(Math.max(0, archive.length - ZIP_TAIL_BYTES));
  const dir = readZipDirectory(tail, archive.length);
  const records = readCentralDirectory(dir, archive.subarray(dir.cdOffset, dir.cdOffset + dir.cdSize));
  const plan = planZipAppend(dir, records, additions, WHEN);
  assert.equal(plan.keepLength, dir.cdOffset);
  assert.equal(plan.totalLength, plan.keepLength + plan.trailer.byteLength);
  const out = new Uint8Array(plan.totalLength);
  out.set(archive.subarray(0, plan.keepLength));
  out.set(plan.trailer, plan.keepLength);
  return out;
}

type Entry = { name: string; data: Uint8Array; time: number; date: number };

/** Independent reader: EOCD -> central directory -> local headers -> data, CRC-checked. */
function readArchive(bytes: Uint8Array): { entries: Entry[]; comment: string } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const e = bytes.length - 22 - lastCommentLength(bytes);
  assert.equal(dv.getUint32(e, true), 0x06054b50, 'EOCD signature');
  const count = dv.getUint16(e + 10, true);
  const cdSize = dv.getUint32(e + 12, true);
  const cdOffset = dv.getUint32(e + 16, true);
  assert.equal(cdOffset + cdSize, e, 'central directory ends at the EOCD');
  const entries: Entry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central header signature');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const n = dv.getUint16(p + 28, true);
    const m = dv.getUint16(p + 30, true);
    const k = dv.getUint16(p + 32, true);
    const lh = dv.getUint32(p + 42, true);
    const name = Buffer.from(bytes.subarray(p + 46, p + 46 + n)).toString('utf8');
    assert.equal(dv.getUint32(lh, true), 0x04034b50, `local header signature for ${name}`);
    const ln = dv.getUint16(lh + 26, true);
    const lm = dv.getUint16(lh + 28, true);
    assert.equal(Buffer.from(bytes.subarray(lh + 30, lh + 30 + ln)).toString('utf8'), name, 'local name');
    const raw = bytes.subarray(lh + 30 + ln + lm, lh + 30 + ln + lm + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    assert.equal(data.length, usize, `size of ${name}`);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    entries.push({ name, data, time: dv.getUint16(p + 12, true), date: dv.getUint16(p + 14, true) });
    p += 46 + n + m + k;
  }
  return { entries, comment: Buffer.from(bytes.subarray(e + 22)).toString('latin1') };
}

function lastCommentLength(bytes: Uint8Array): number {
  for (let p = bytes.length - 22; p >= 0; p--) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + p, 22);
    if (dv.getUint32(0, true) === 0x06054b50 && p + 22 + dv.getUint16(20, true) === bytes.length) {
      return dv.getUint16(20, true);
    }
  }
  throw new Error('no EOCD');
}

const text = (d: Uint8Array) => Buffer.from(d).toString('utf8');

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('appends after the original entries and keeps them byte-for-byte', () => {
  const before = readArchive(WITH_COMMENT);
  const out = append(WITH_COMMENT);
  const after = readArchive(out);

  assert.deepEqual(after.entries.map((e) => e.name), ['a.txt', 'b.bin', 'license-key.txt', 'README.txt']);
  for (const [i, e] of before.entries.entries()) assert.deepEqual(after.entries[i]!.data, e.data);
  const dir = readZipDirectory(WITH_COMMENT.subarray(WITH_COMMENT.length - 60), WITH_COMMENT.length);
  assert.deepEqual(out.subarray(0, dir.cdOffset), WITH_COMMENT.subarray(0, dir.cdOffset));
  assert.equal(text(after.entries[2]!.data), ADDITIONS[0]!.data);
  assert.equal(text(after.entries[3]!.data), ADDITIONS[1]!.data);
});

test('keeps the archive comment', () => {
  assert.equal(readArchive(append(WITH_COMMENT)).comment, 'release comment, kept verbatim');
});

test('stamps new entries with the given time (UTC, 2-second resolution)', () => {
  const added = readArchive(append(WITH_COMMENT)).entries[3]!;
  assert.equal(added.time, (1 << 11) | (2 << 5) | 1); // 01:02:02
  assert.equal(added.date, ((2026 - 1980) << 9) | (11 << 5) | 16);
});

test('an added file replaces an original entry with the same name, ignoring case', () => {
  const after = readArchive(append(WITH_README));
  assert.deepEqual(after.entries.map((e) => e.name), ['keep.txt', 'license-key.txt', 'README.txt']);
  assert.equal(text(after.entries[2]!.data), ADDITIONS[1]!.data);
});

test('works on an empty archive', () => {
  const after = readArchive(append(EMPTY));
  assert.deepEqual(after.entries.map((e) => e.name), ['license-key.txt', 'README.txt']);
});

test('marks non-ASCII names as UTF-8', () => {
  const out = append(EMPTY, [{ name: 'lïcense.txt', data: 'x' }]);
  const dv = new DataView(out.buffer);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);
  assert.equal(readArchive(out).entries[0]!.name, 'lïcense.txt');
});

test('skips an EOCD look-alike whose comment length does not reach the end', () => {
  // Same archive, but the comment now contains a fake EOCD record claiming a
  // 0-byte comment, which therefore cannot be the last record in the file.
  const fake = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
  const dirEnd = WITH_README.length - 22;
  const comment = new Uint8Array([...fake, 0x21, 0x21]);
  const archive = new Uint8Array(WITH_README.length + comment.length);
  archive.set(WITH_README);
  archive.set(comment, WITH_README.length);
  new DataView(archive.buffer).setUint16(dirEnd + 20, comment.length, true);
  const dir = readZipDirectory(archive, archive.length);
  assert.equal(dir.comment.length, comment.length);
  assert.equal(dir.entryCount, 2);
});

test('rejects ZIP64 archives', () => {
  const e = WITH_README.length - 22;
  const z64 = new Uint8Array(56 + 20);
  const dv = new DataView(z64.buffer);
  dv.setUint32(0, 0x06064b50, true); // ZIP64 EOCD record
  dv.setUint32(56, 0x07064b50, true); // ZIP64 EOCD locator
  const archive = new Uint8Array([...WITH_README.subarray(0, e), ...z64, ...WITH_README.subarray(e)]);
  assert.throws(() => readZipDirectory(archive, archive.length), /ZIP64/);
});

test('rejects data prepended to the archive (self-extractor)', () => {
  const archive = new Uint8Array([0x4d, 0x5a, ...new Array<number>(510).fill(0), ...WITH_README]);
  assert.throws(() => readZipDirectory(archive, archive.length), /does not end at the EOCD/);
});

test('rejects a truncated archive', () => {
  const archive = WITH_README.subarray(0, WITH_README.length - 1);
  assert.throws(() => readZipDirectory(archive, archive.length), ZipFormatError);
});

test('rejects a central directory whose record count disagrees with the EOCD', () => {
  const tail = WITH_README;
  const dir = readZipDirectory(tail, tail.length);
  assert.throws(
    () => readCentralDirectory({ ...dir, entryCount: 3 }, tail.subarray(dir.cdOffset, dir.cdOffset + dir.cdSize)),
    /3/,
  );
});
