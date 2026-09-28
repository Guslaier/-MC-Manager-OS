import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import type { Readable } from "node:stream";
import type { ArchiveFormat, ArchiveTask, ExtractConflictPolicy } from "@mcm/contracts";
import { assertWithinScope, dataRoot, resolveSafe } from "./files.js";
import type { ZipStreamEntry } from "./zip.js";

// Native, dependency-free archive handling for the Manage file view. Everything
// is confined to the single canonical root: an archive entry may never resolve
// outside the requested destination directory, symlinks are never materialised,
// and both the compressed input and the decompressed total are size-capped so a
// zip-bomb cannot exhaust disk or RAM.

/** Ceiling on the compressed archive we are willing to open. MCM_MAX_ARCHIVE_BYTES. */
export const MAX_ARCHIVE_BYTES = Number(process.env.MCM_MAX_ARCHIVE_BYTES ?? 2 * 1024 * 1024 * 1024);
/** Ceiling on the total uncompressed bytes one extraction may write. MCM_MAX_EXTRACT_BYTES. */
export const MAX_EXTRACT_BYTES = Number(process.env.MCM_MAX_EXTRACT_BYTES ?? 8 * 1024 * 1024 * 1024);
/** Ceiling on the number of entries parsed from one archive. MCM_MAX_ARCHIVE_ENTRIES. */
export const MAX_ARCHIVE_ENTRIES = Number(process.env.MCM_MAX_ARCHIVE_ENTRIES ?? 200_000);

const TASK_RETENTION_MS = 10 * 60 * 1000;
const TASKS: Map<string, ArchiveTask> = new Map();

export class ArchiveFormatError extends Error {
  constructor(name: string) {
    super(`unsupported archive format: ${name}`);
    this.name = "ArchiveFormatError";
  }
}

/** Raised when an entry name or link target tries to escape the destination. */
export class ArchiveEntryError extends Error {
  constructor(entry: string, detail: string) {
    super(`unsafe archive entry "${entry}": ${detail}`);
    this.name = "ArchiveEntryError";
  }
}

/** Detects a supported format from the file name, or null when it is not an archive. */
export function detectFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".jar")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return null;
}

export function isArchiveName(name: string): boolean {
  return detectFormat(name) !== null;
}

// --- Entry name safety -------------------------------------------------------

/**
 * Normalises an archive entry path to a forward-slash relative path. Interior
 * `a/..` segments are folded, but anything that would climb above the archive
 * root (`..` at depth 0), an absolute path, a drive letter, or a NUL byte is
 * rejected. The caller still funnels the result through `assertWithinScope`.
 */
function normalizeEntryName(raw: string): string {
  const cleaned = raw.replace(/\\/g, "/");
  const segments = cleaned.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment.includes("\0")) throw new ArchiveEntryError(raw, "NUL byte in name");
    if (segment === "..") {
      if (out.length === 0) throw new ArchiveEntryError(raw, "escapes archive root");
      out.pop();
      continue;
    }
    if (/^[a-zA-Z]:$/.test(segment)) throw new ArchiveEntryError(raw, "drive-letter segment");
    out.push(segment);
  }
  if (out.length === 0) throw new ArchiveEntryError(raw, "empty path");
  return out.join("/");
}

/**
 * Refuses a destination whose parent chain (below `rootAbs`) contains a symlink,
 * so a pre-existing link cannot redirect a write outside the canonical root.
 */
async function assertNoSymlinkAncestors(absFile: string, rootAbs: string): Promise<void> {
  const chain: string[] = [];
  let current = path.dirname(absFile);
  while (current.length > rootAbs.length && current !== rootAbs) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const dir of chain.reverse()) {
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (stat.isSymbolicLink()) throw new ArchiveEntryError(dir, "symlinked parent directory");
  }
}

// --- ZIP reader (central-directory driven, memory bounded) -------------------

interface ZipRecord {
  name: string;
  dir: boolean;
  symlink: boolean;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

function zip64Extra(extra: Buffer, want: { compressed: boolean; uncompressed: boolean; offset: boolean }): number[] {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    const body = extra.subarray(pos + 4, pos + 4 + size);
    if (id === 0x0001) {
      const values: number[] = [];
      let cursor = 0;
      // The order of fields present is fixed by which base fields were saturated.
      if (want.uncompressed && cursor + 8 <= body.length) {
        values.push(Number(body.readBigUInt64LE(cursor)));
        cursor += 8;
      }
      if (want.compressed && cursor + 8 <= body.length) {
        values.push(Number(body.readBigUInt64LE(cursor)));
        cursor += 8;
      }
      if (want.offset && cursor + 8 <= body.length) {
        values.push(Number(body.readBigUInt64LE(cursor)));
        cursor += 8;
      }
      return values;
    }
    pos += 4 + size;
  }
  return [];
}

async function readAt(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  await handle.read(buf, 0, length, position);
  return buf;
}

/** Locates the central directory (zip64 aware) and returns one record per entry. */
async function readCentralDirectory(handle: fs.FileHandle, size: number): Promise<{ records: ZipRecord[]; close: () => Promise<void> }> {
  const tailLen = Math.min(size, 65_557);
  const tailStart = size - tailLen;
  const tail = await readAt(handle, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveFormatError("zip (end-of-central-directory not found)");

  let totalEntries = tail.readUInt16LE(eocd + 10);
  let centralSize = tail.readUInt32LE(eocd + 12);
  let centralOffset = tail.readUInt32LE(eocd + 16);

  if (centralOffset === 0xffffffff || totalEntries === 0xffff || centralSize === 0xffffffff) {
    const locatorPos = tailStart + eocd - 20;
    if (locatorPos >= 0) {
      const locator = await readAt(handle, locatorPos, 20);
      if (locator.readUInt32LE(0) === 0x07064b50) {
        const z64Offset = Number(locator.readBigUInt64LE(8));
        const z64 = await readAt(handle, z64Offset, 56);
        if (z64.readUInt32LE(0) === 0x06064b50) {
          totalEntries = Number(z64.readBigUInt64LE(32));
          centralSize = Number(z64.readBigUInt64LE(40));
          centralOffset = Number(z64.readBigUInt64LE(48));
        }
      }
    }
  }

  if (totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw new ArchiveFormatError(`zip (${totalEntries} entries exceeds ${MAX_ARCHIVE_ENTRIES})`);
  }
  const central = await readAt(handle, centralOffset, centralSize);

  const records: ZipRecord[] = [];
  let cursor = 0;
  while (cursor + 46 <= central.length && central.readUInt32LE(cursor) === 0x02014b50) {
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    let compressedSize = central.readUInt32LE(cursor + 20);
    let uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLen = central.readUInt16LE(cursor + 28);
    const extraLen = central.readUInt16LE(cursor + 30);
    const commentLen = central.readUInt16LE(cursor + 32);
    const externalAttr = central.readUInt32LE(cursor + 38);
    let localOffset = central.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const rawName = central.subarray(nameStart, nameStart + nameLen);
    const extra = central.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);

    const name = rawName.toString(flags & 0x0800 ? "utf8" : "latin1");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const z = zip64Extra(extra, {
        compressed: compressedSize === 0xffffffff,
        uncompressed: uncompressedSize === 0xffffffff,
        offset: localOffset === 0xffffffff,
      });
      let idx = 0;
      if (uncompressedSize === 0xffffffff) uncompressedSize = z[idx++] ?? 0;
      if (compressedSize === 0xffffffff) compressedSize = z[idx++] ?? 0;
      if (localOffset === 0xffffffff) localOffset = z[idx++] ?? 0;
    }

    const unixMode = externalAttr >>> 16;
    const symlink = (unixMode & 0xf000) === 0xa000;
    records.push({
      name,
      dir: name.endsWith("/") || (unixMode & 0xf000) === 0x4000,
      symlink,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });

    cursor = nameStart + nameLen + extraLen + commentLen;
  }

  return { records, close: async () => handle.close() };
}

/** Opens the compressed bytes of one zip entry on demand (never the whole archive). */
async function openZipEntryData(handle: fs.FileHandle, record: ZipRecord): Promise<Buffer> {
  const local = await readAt(handle, record.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) throw new ArchiveFormatError(`zip (bad local header for ${record.name})`);
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const dataStart = record.localOffset + 30 + nameLen + extraLen;
  const raw = await readAt(handle, dataStart, record.compressedSize);
  if (record.method === 0) return raw;
  if (record.method === 8) return inflateRawSync(raw);
  throw new ArchiveFormatError(`zip (unsupported compression method ${record.method})`);
}

// --- TAR reader (ustar/pax headers) -----------------------------------------

interface TarRecord {
  name: string;
  dir: boolean;
  symlink: boolean;
  size: number;
  dataStart: number;
}

function octal(buf: Buffer): number {
  const text = buf.toString("latin1").replace(/\0/g, "").trim();
  if (text === "") return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readTarRecords(tar: Buffer): TarRecord[] {
  const records: TarRecord[] = [];
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const bodyEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / 512) * 512;

    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = `${prefix}/${name}`;

    if (typeflag === "L") {
      longName = tar.subarray(dataStart, bodyEnd).toString("utf8").replace(/\0.*$/, "");
      offset = next;
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      offset = next;
      continue;
    }
    if (longName !== null) {
      name = longName;
      longName = null;
    }

    if (records.length >= MAX_ARCHIVE_ENTRIES) {
      throw new ArchiveFormatError(`tar (more than ${MAX_ARCHIVE_ENTRIES} entries)`);
    }
    records.push({
      name,
      dir: typeflag === "5" || name.endsWith("/"),
      symlink: typeflag === "1" || typeflag === "2",
      size,
      dataStart,
    });
    offset = next;
  }
  return records;
}

// --- Opened archive abstraction ---------------------------------------------

interface OpenedEntry {
  name: string;
  dir: boolean;
  read: () => Promise<Buffer>;
}

interface OpenedArchive {
  format: ArchiveFormat;
  entries: OpenedEntry[];
  close: () => Promise<void>;
}

/** Opens an archive for reading, capping the compressed size before any parse. */
export async function openArchive(relPath: string): Promise<OpenedArchive> {
  const format = detectFormat(relPath);
  if (!format) throw new ArchiveFormatError(relPath);
  const abs = resolveSafe(relPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new ArchiveFormatError(`${relPath} (not a file)`);
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new ArchiveFormatError(`${relPath} (${stat.size} bytes exceeds ${MAX_ARCHIVE_BYTES})`);
  }

  if (format === "zip") {
    const handle = await fs.open(abs, "r");
    const { records, close } = await readCentralDirectory(handle, stat.size);
    const entries: OpenedEntry[] = records.map((record) => ({
      name: record.name,
      dir: record.dir,
      read: async () => (record.symlink ? Buffer.alloc(0) : openZipEntryData(handle, record)),
    }));
    return { format, entries, close };
  }

  const compressed = await fs.readFile(abs);
  const tar = format === "tar.gz" ? gunzipSync(compressed) : compressed;
  if (tar.length > MAX_EXTRACT_BYTES) throw new ArchiveFormatError(`${relPath} (uncompressed size exceeds extraction limit)`);
  const entries: OpenedEntry[] = readTarRecords(tar).map((record) => ({
    name: record.name,
    dir: record.dir,
    read: async () => tar.subarray(record.dataStart, record.dataStart + record.size),
  }));
  return { format, entries, close: async () => undefined };
}

// --- Background extraction ---------------------------------------------------

function pruneTasks(): void {
  const cutoff = Date.now() - TASK_RETENTION_MS;
  for (const task of [...TASKS.values()]) {
    if (task.status !== "extracting" && task.finishedAt && Date.parse(task.finishedAt) < cutoff) {
      TASKS.delete(task.id);
    }
  }
}

async function runExtraction(task: ArchiveTask, relPath: string, destinationRel: string, policy: ExtractConflictPolicy): Promise<void> {
  let archive: OpenedArchive | null = null;
  try {
    archive = await openArchive(relPath);
    task.format = archive.format;
    const files = archive.entries.filter((entry) => !entry.dir);
    task.totalEntries = files.length;
    const rootAbs = dataRoot();
    const destAbs = resolveSafe(destinationRel);
    await fs.mkdir(destAbs, { recursive: true });
    let written = 0;

    for (const entry of archive.entries) {
      let entryRel: string;
      try {
        entryRel = normalizeEntryName(entry.name);
      } catch (err) {
        task.warnings.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (entry.dir) {
        const dirRel = path.posix.join(destinationRel, entryRel);
        assertWithinScope(destinationRel, dirRel);
        await fs.mkdir(resolveSafe(dirRel), { recursive: true });
        continue;
      }

      const fullRel = path.posix.join(destinationRel, entryRel);
      // Lexical confinement first, then a real symlink check on the parent chain.
      assertWithinScope(destinationRel, fullRel);
      const absFile = resolveSafe(fullRel);
      await assertNoSymlinkAncestors(absFile, rootAbs);

      const data = await entry.read();
      if (written + data.length > MAX_EXTRACT_BYTES) {
        throw new ArchiveFormatError(`extraction would exceed ${MAX_EXTRACT_BYTES} bytes`);
      }

      let exists = false;
      try {
        await fs.access(absFile);
        exists = true;
      } catch {
        exists = false;
      }
      if (exists && policy === "skip") {
        task.skippedEntries += 1;
        continue;
      }

      await fs.mkdir(path.dirname(absFile), { recursive: true });
      await fs.writeFile(absFile, data);
      written += data.length;
      task.bytesWritten = written;
      task.extractedEntries += 1;
    }

    task.status = "done";
    task.finishedAt = new Date().toISOString();
  } catch (err) {
    task.status = "error";
    task.error = err instanceof Error ? err.message : String(err);
    task.finishedAt = new Date().toISOString();
  } finally {
    if (archive) await archive.close();
  }
}

export interface StartExtractionRequest {
  /** Archive path relative to the canonical root. */
  relPath: string;
  /** Destination directory relative to the canonical root; defaults to the archive's folder. */
  destinationRel?: string;
  policy?: ExtractConflictPolicy;
}

/**
 * Validates the request synchronously, then runs the extraction in the
 * background so the HTTP call returns immediately with a pollable task. No
 * completion is ever faked: the task only reports `done` after every entry has
 * been written.
 */
export async function startExtraction(request: StartExtractionRequest): Promise<ArchiveTask> {
  pruneTasks();
  const relPath = String(request.relPath ?? "");
  if (!relPath) throw new ArchiveFormatError("(empty path)");
  const format = detectFormat(relPath);
  if (!format) throw new ArchiveFormatError(relPath);
  const abs = resolveSafe(relPath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new ArchiveFormatError(`${relPath} (not a file)`);
  if (stat.size > MAX_ARCHIVE_BYTES) {
    throw new ArchiveFormatError(`${relPath} (${stat.size} bytes exceeds ${MAX_ARCHIVE_BYTES})`);
  }

  const destinationRel = request.destinationRel && request.destinationRel !== "." ? request.destinationRel : path.posix.dirname(relPath);
  // Confine the requested destination to the root before any write is scheduled.
  resolveSafe(destinationRel);

  const task: ArchiveTask = {
    id: randomUUID(),
    path: relPath,
    destination: destinationRel,
    format,
    policy: request.policy === "skip" ? "skip" : "overwrite",
    status: "extracting",
    extractedEntries: 0,
    skippedEntries: 0,
    totalEntries: 0,
    bytesWritten: 0,
    startedAt: new Date().toISOString(),
    warnings: [],
  };
  TASKS.set(task.id, task);
  void runExtraction(task, relPath, destinationRel, task.policy);
  return task;
}

export function getArchiveTask(id: string): ArchiveTask | undefined {
  return TASKS.get(id);
}

export function listArchiveTasks(): ArchiveTask[] {
  return [...TASKS.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

// --- Scoped folder ZIP streaming --------------------------------------------

/**
 * Lazily walks a directory into zip entries: file contents are opened as a
 * stream when the writer reaches them, so a large folder is never buffered
 * whole in memory. `baseName` becomes the archive's top-level folder name.
 */
export async function* walkZipEntries(absDir: string, baseName: string): AsyncGenerator<ZipStreamEntry> {
  async function* walk(abs: string, rel: string): AsyncGenerator<ZipStreamEntry> {
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      // A symlink is never followed, so a folder download cannot leak outside it.
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        yield* walk(childAbs, childRel);
        continue;
      }
      if (!dirent.isFile()) continue;
      const stat = await fs.stat(childAbs);
      yield {
        name: childRel,
        sizeBytes: stat.size,
        open: (): Readable => createReadStream(childAbs),
      };
    }
  }
  yield* walk(absDir, baseName);
}
