import { gunzipSync, gzipSync } from "node:zlib";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Minimal, dependency-free NBT (Named Binary Tag) reader/writer for vanilla Java
 * Edition `level.dat`. The file is a gzip stream wrapping a single big-endian NBT
 * root compound. This module is deliberately lossless: every tag is decoded into a
 * generic tree and re-encoded byte-for-byte in structure, so editing one nested
 * value (a gamerule) can never drop or reorder unrelated world data.
 *
 * Only the tag types a real `level.dat` uses are implemented; an unknown tag id is
 * a hard error rather than a silent skip, so a corrupt/unsupported file is refused
 * instead of being rewritten into something the game cannot load.
 */

/** NBT tag ids (Java Edition, big-endian). */
export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

export type TagId = (typeof TAG)[keyof typeof TAG];

/** A decoded NBT value. `type` is the tag id; `value` is the JS representation. */
export type NbtValue =
  | { type: typeof TAG.Byte; value: number }
  | { type: typeof TAG.Short; value: number }
  | { type: typeof TAG.Int; value: number }
  | { type: typeof TAG.Long; value: bigint }
  | { type: typeof TAG.Float; value: number }
  | { type: typeof TAG.Double; value: number }
  | { type: typeof TAG.ByteArray; value: number[] }
  | { type: typeof TAG.String; value: string }
  | { type: typeof TAG.List; value: { elementType: TagId; items: NbtValue[] } }
  | { type: typeof TAG.Compound; value: Map<string, NbtValue> }
  | { type: typeof TAG.IntArray; value: number[] }
  | { type: typeof TAG.LongArray; value: bigint[] };

/** A named tag, as stored inside a compound or as the root. */
export interface NbtTag {
  name: string;
  value: NbtValue;
}

/** Raised when a buffer is not a well-formed NBT document. */
export class NbtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NbtError";
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new NbtError(`unexpected end of NBT data at offset ${this.offset} (need ${n} bytes)`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }

  i8(): number {
    this.need(1);
    return this.buf.readInt8(this.offset++);
  }

  i16(): number {
    this.need(2);
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  /** NBT strings are a big-endian u16 length followed by modified-UTF8 bytes. */
  str(): string {
    const len = this.u16();
    this.need(len);
    const v = this.buf.toString("utf8", this.offset, this.offset + len);
    this.offset += len;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }
}

function readPayload(reader: Reader, type: TagId): NbtValue {
  switch (type) {
    case TAG.Byte:
      return { type: TAG.Byte, value: reader.i8() };
    case TAG.Short:
      return { type: TAG.Short, value: reader.i16() };
    case TAG.Int:
      return { type: TAG.Int, value: reader.i32() };
    case TAG.Long:
      return { type: TAG.Long, value: reader.i64() };
    case TAG.Float:
      return { type: TAG.Float, value: reader.f32() };
    case TAG.Double:
      return { type: TAG.Double, value: reader.f64() };
    case TAG.ByteArray: {
      const len = reader.i32();
      if (len < 0) throw new NbtError(`negative byte-array length ${len}`);
      return { type: TAG.ByteArray, value: [...reader.bytes(len)] };
    }
    case TAG.String:
      return { type: TAG.String, value: reader.str() };
    case TAG.List: {
      const elementType = reader.u8() as TagId;
      const len = reader.i32();
      if (len < 0) throw new NbtError(`negative list length ${len}`);
      const items: NbtValue[] = [];
      for (let i = 0; i < len; i += 1) items.push(readPayload(reader, elementType));
      return { type: TAG.List, value: { elementType, items } };
    }
    case TAG.Compound: {
      const map = new Map<string, NbtValue>();
      for (;;) {
        const childType = reader.u8() as TagId;
        if (childType === TAG.End) break;
        const name = reader.str();
        map.set(name, readPayload(reader, childType));
      }
      return { type: TAG.Compound, value: map };
    }
    case TAG.IntArray: {
      const len = reader.i32();
      if (len < 0) throw new NbtError(`negative int-array length ${len}`);
      const out: number[] = [];
      for (let i = 0; i < len; i += 1) out.push(reader.i32());
      return { type: TAG.IntArray, value: out };
    }
    case TAG.LongArray: {
      const len = reader.i32();
      if (len < 0) throw new NbtError(`negative long-array length ${len}`);
      const out: bigint[] = [];
      for (let i = 0; i < len; i += 1) out.push(reader.i64());
      return { type: TAG.LongArray, value: out };
    }
    default:
      throw new NbtError(`unsupported NBT tag id ${type}`);
  }
}

/** Decodes a raw (already decompressed) NBT document into its root tag. */
export function parseNbt(buf: Buffer): NbtTag {
  const reader = new Reader(buf);
  const type = reader.u8() as TagId;
  if (type === TAG.End) throw new NbtError("empty NBT document (root tag is TAG_End)");
  const name = reader.str();
  const value = readPayload(reader, type);
  return { name, value };
}

function writeString(out: number[], s: string): void {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length > 0xffff) throw new NbtError(`string too long for NBT (${bytes.length} bytes)`);
  out.push((bytes.length >> 8) & 0xff, bytes.length & 0xff);
  for (const b of bytes) out.push(b);
}

function writeI64(out: number[], v: bigint): void {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(v);
  for (const b of buf) out.push(b);
}

function writeI32(out: number[], v: number): void {
  out.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
}

function writePayload(out: number[], value: NbtValue): void {
  switch (value.type) {
    case TAG.Byte:
      out.push(value.value & 0xff);
      break;
    case TAG.Short:
      out.push((value.value >> 8) & 0xff, value.value & 0xff);
      break;
    case TAG.Int:
      writeI32(out, value.value);
      break;
    case TAG.Long:
      writeI64(out, value.value);
      break;
    case TAG.Float: {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(value.value);
      for (const b of buf) out.push(b);
      break;
    }
    case TAG.Double: {
      const buf = Buffer.alloc(8);
      buf.writeDoubleBE(value.value);
      for (const b of buf) out.push(b);
      break;
    }
    case TAG.ByteArray:
      writeI32(out, value.value.length);
      for (const b of value.value) out.push(b & 0xff);
      break;
    case TAG.String:
      writeString(out, value.value);
      break;
    case TAG.List:
      out.push(value.value.elementType);
      writeI32(out, value.value.items.length);
      for (const item of value.value.items) writePayload(out, item);
      break;
    case TAG.Compound:
      for (const [name, child] of value.value) {
        out.push(child.type);
        writeString(out, name);
        writePayload(out, child);
      }
      out.push(TAG.End);
      break;
    case TAG.IntArray:
      writeI32(out, value.value.length);
      for (const n of value.value) writeI32(out, n);
      break;
    case TAG.LongArray:
      writeI32(out, value.value.length);
      for (const n of value.value) writeI64(out, n);
      break;
    default:
      throw new NbtError(`cannot encode unsupported tag`);
  }
}

/** Encodes a root tag back into a raw (uncompressed) NBT document. */
export function encodeNbt(root: NbtTag): Buffer {
  const out: number[] = [];
  out.push(root.value.type);
  writeString(out, root.name);
  writePayload(out, root.value);
  return Buffer.from(out);
}

/** Reads a gzip-compressed `level.dat` and returns its root tag. */
export function readLevelDat(absPath: string): NbtTag {
  let raw: Buffer;
  try {
    raw = readFileSync(absPath);
  } catch (err) {
    throw new NbtError(`cannot read level.dat: ${String(err)}`);
  }
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(raw);
  } catch (err) {
    throw new NbtError(`level.dat is not valid gzip: ${String(err)}`);
  }
  return parseNbt(decompressed);
}

/**
 * Writes a root tag back to `level.dat` atomically: gzip the encoded document,
 * write a sibling temp file, then rename it over the target so a crash mid-write
 * cannot truncate the world's level.dat.
 */
export function writeLevelDatAtomic(absPath: string, root: NbtTag): void {
  const compressed = gzipSync(encodeNbt(root));
  const tmp = `${absPath}.tmp-${process.pid.toString(36)}`;
  writeFileSync(tmp, compressed);
  renameSync(tmp, absPath);
}

/** Returns the compound map for a named child, or null when absent/not a compound. */
export function compoundChild(parent: NbtValue, name: string): Map<string, NbtValue> | null {
  if (parent.type !== TAG.Compound) return null;
  const child = parent.value.get(name);
  return child && child.type === TAG.Compound ? child.value : null;
}

/** Returns the string value of a named child, or null when absent/not a string. */
export function stringChild(parent: NbtValue, name: string): string | null {
  if (parent.type !== TAG.Compound) return null;
  const child = parent.value.get(name);
  return child && child.type === TAG.String ? child.value : null;
}
