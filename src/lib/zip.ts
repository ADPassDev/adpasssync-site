// Minimal "store" (no compression) ZIP builder.
//
// Why hand-rolled? A two-file portal download (MSI + license-key.txt) doesn't
// justify pulling in a compression dependency, and Workers ship Web Crypto +
// TypedArrays which is all we need. Files are buffered in memory; the Workers
// 128 MB memory ceiling is the practical upper bound on installer size.

type ZipEntry = {
  name: string;
  data: Uint8Array;
  crc32: number;
  // Offset of the local file header in the final archive — filled in by build().
  offset: number;
};

const TEXT_ENCODER = new TextEncoder();

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

export type ZipInput = { name: string; data: Uint8Array | string };

/** Build a stored (uncompressed) ZIP archive from the given entries. */
export function buildZip(inputs: ZipInput[]): Uint8Array {
  const entries: ZipEntry[] = inputs.map((i) => {
    const data = typeof i.data === 'string' ? TEXT_ENCODER.encode(i.data) : i.data;
    return { name: i.name, data, crc32: crc32(data), offset: 0 };
  });

  // Compute total size to allocate one buffer up front.
  let localSize = 0;
  for (const e of entries) {
    localSize += 30 + TEXT_ENCODER.encode(e.name).byteLength + e.data.byteLength;
  }
  let centralSize = 0;
  for (const e of entries) {
    centralSize += 46 + TEXT_ENCODER.encode(e.name).byteLength;
  }
  const total = localSize + centralSize + 22;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;

  // Local file headers + file data.
  for (const e of entries) {
    e.offset = p;
    const nameBytes = TEXT_ENCODER.encode(e.name);
    dv.setUint32(p, 0x04034b50, true); // local file header signature
    dv.setUint16(p + 4, 20, true); // version needed
    dv.setUint16(p + 6, 0, true); // general purpose bit flag
    dv.setUint16(p + 8, 0, true); // compression method = stored
    dv.setUint16(p + 10, 0, true); // last mod file time
    dv.setUint16(p + 12, 0, true); // last mod file date
    dv.setUint32(p + 14, e.crc32, true);
    dv.setUint32(p + 18, e.data.byteLength, true); // compressed size
    dv.setUint32(p + 22, e.data.byteLength, true); // uncompressed size
    dv.setUint16(p + 26, nameBytes.byteLength, true);
    dv.setUint16(p + 28, 0, true); // extra field length
    p += 30;
    out.set(nameBytes, p);
    p += nameBytes.byteLength;
    out.set(e.data, p);
    p += e.data.byteLength;
  }

  // Central directory.
  const centralStart = p;
  for (const e of entries) {
    const nameBytes = TEXT_ENCODER.encode(e.name);
    dv.setUint32(p, 0x02014b50, true); // central dir signature
    dv.setUint16(p + 4, 20, true); // version made by
    dv.setUint16(p + 6, 20, true); // version needed
    dv.setUint16(p + 8, 0, true); // general purpose bit flag
    dv.setUint16(p + 10, 0, true); // compression method
    dv.setUint16(p + 12, 0, true); // last mod time
    dv.setUint16(p + 14, 0, true); // last mod date
    dv.setUint32(p + 16, e.crc32, true);
    dv.setUint32(p + 20, e.data.byteLength, true);
    dv.setUint32(p + 24, e.data.byteLength, true);
    dv.setUint16(p + 28, nameBytes.byteLength, true);
    dv.setUint16(p + 30, 0, true); // extra field len
    dv.setUint16(p + 32, 0, true); // comment len
    dv.setUint16(p + 34, 0, true); // disk number start
    dv.setUint16(p + 36, 0, true); // internal file attributes
    dv.setUint32(p + 38, 0, true); // external file attributes
    dv.setUint32(p + 42, e.offset, true); // relative offset of local header
    p += 46;
    out.set(nameBytes, p);
    p += nameBytes.byteLength;
  }
  const centralLen = p - centralStart;

  // End of central directory.
  dv.setUint32(p, 0x06054b50, true);
  dv.setUint16(p + 4, 0, true); // disk number
  dv.setUint16(p + 6, 0, true); // disk where central dir starts
  dv.setUint16(p + 8, entries.length, true);
  dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, centralLen, true);
  dv.setUint32(p + 16, centralStart, true);
  dv.setUint16(p + 20, 0, true); // comment length

  return out;
}
