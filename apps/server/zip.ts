import { PassThrough, Transform, Writable } from "node:stream";
import type { Readable } from "node:stream";
// Promise-based pipeline; the `node:stream` export requires a trailing callback.
import { pipeline } from "node:stream/promises";
import { createDeflateRaw, deflateRawSync } from "node:zlib";

// Minimal ZIP (deflate) writer built on node:zlib, so export needs no extra
// dependency. ponytail: whole archive is buffered in memory and has no zip64
// support - switch to a streaming writer if the data root can exceed ~4 GiB.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC32 step so a streamed entry can be hashed chunk by chunk. */
function crc32Update(state: number, buf: Buffer): number {
  let c = state;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c;
}

function crc32(buf: Buffer): number {
  return (crc32Update(0xffffffff, buf) ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Builds an in-memory ZIP archive using deflate compression. */
export function createZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x0021, 12); // mod date (1980-01-01, valid DOS date)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory signature
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42); // offset of local header
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

// --- Streaming ZIP writer (no whole-archive buffering) ------------------------

/**
 * One lazily-opened entry of a streaming archive: `open()` is called only when
 * the writer reaches this entry, so at most one file's bytes are in flight.
 */
export interface ZipStreamEntry {
  name: string;
  sizeBytes: number;
  open: () => Readable;
}

/** Resolves once the chunk has been flushed, so a fast reader cannot be outrun. */
function writeChunk(out: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** Compresses and emits one entry, returning its CRC + sizes for the central directory. */
async function streamEntry(out: Writable, entry: ZipStreamEntry): Promise<{ crc: number; compressed: number; uncompressed: number }> {
  let crc = 0xffffffff;
  let uncompressed = 0;
  let compressed = 0;
  const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  // Bit 3 = sizes/CRC live in a trailing data descriptor; bit 11 = UTF-8 name.
  local.writeUInt16LE(0x0808, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt16LE(nameBuf.length, 26);
  await writeChunk(out, local);
  await writeChunk(out, nameBuf);

  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      crc = crc32Update(crc, chunk);
      uncompressed += chunk.length;
      cb(null, chunk);
    },
  });
  // A Writable, not a Transform: pipeline resolves on 'finish' and there is no
  // unread readable side that could stall the deflate stream on large entries.
  const counter = new Writable({
    write(chunk: Buffer, _enc, cb) {
      compressed += chunk.length;
      writeChunk(out, chunk).then(() => cb(), cb);
    },
  });
  await pipeline(entry.open(), meter, createDeflateRaw(), counter);

  const finalCrc = (crc ^ 0xffffffff) >>> 0;
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(finalCrc, 4);
  descriptor.writeUInt32LE(compressed, 8);
  descriptor.writeUInt32LE(uncompressed, 12);
  await writeChunk(out, descriptor);

  return { crc: finalCrc, compressed, uncompressed };
}

/**
 * Streams a ZIP produced from lazily-opened entries directly into `out`, so a
 * multi-GB folder download never has to be buffered. `out` is not ended here.
 * ponytail: still no zip64 - a single entry or the archive above ~4 GiB needs a
 * zip64 switch, which is out of scope while the upload cap bounds inputs.
 */
export async function writeZipToWritable(out: Writable, entries: AsyncIterable<ZipStreamEntry>): Promise<void> {
  const central: Buffer[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const localOffset = offset;
    const { crc, compressed, uncompressed } = await streamEntry(out, entry);
    offset += 30 + nameBuf.length + compressed + 16;

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x0021, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed, 20);
    dir.writeUInt32LE(uncompressed, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(localOffset, 42);
    central.push(dir, nameBuf);
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeChunk(out, centralBuf);
  await writeChunk(out, end);
}

/** Adapts `writeZipToWritable` to a Readable that can be piped straight to a response. */
export function createZipStream(entries: AsyncIterable<ZipStreamEntry>): Readable {
  const out = new PassThrough();
  void writeZipToWritable(out, entries)
    .then(() => out.end())
    .catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))));
  return out;
}
