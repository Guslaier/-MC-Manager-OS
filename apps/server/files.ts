import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileEntry, FileListing } from "@mcm/contracts";

/**
 * Canonical storage root for ALL server files: the container-side WSL distro
 * filesystem (`/server` inside `MC-Manager-OS`), reached from Windows over UNC
 * (`\\wsl.localhost\<distro>\server`). No PC-local or operator-picked folder is
 * ever used, so this is the single root every file op is confined to. On a native
 * Linux host the SRS 2.2 default is `~/.mc-manager` (MCM_DATA_DIR still overrides).
 */
const DATA_ROOT = path.resolve(
  process.env.MCM_DATA_DIR ??
    (process.platform === "win32" ? path.join(process.cwd(), "data") : path.join(os.homedir(), ".mc-manager")),
);

/** `wsl` when DATA_ROOT targets the distro filesystem, `host` for a Windows-local root. */
export function storageMode(): "wsl" | "host" {
  return DATA_ROOT.replace(/\\/g, "/").startsWith("//wsl.") ? "wsl" : "host";
}

export class PathTraversalError extends Error {
  constructor(relPath: string) {
    super(`path escapes data root: ${relPath}`);
    this.name = "PathTraversalError";
  }
}

export function dataRoot(): string {
  return DATA_ROOT;
}

/**
 * Creates the canonical DATA_ROOT if it does not exist yet and verifies it is a
 * usable directory. Every file operation is confined to DATA_ROOT, so a first run
 * where the folder was never created would otherwise surface as an opaque 500
 * (`scandir ... ENOENT`) on the very first `/api/files` call. Callers treat a
 * failure as non-fatal: the root is resolved the same way as before, only the
 * missing-directory case changes (created instead of erroring).
 */
export async function ensureDataRoot(): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const stat = await fs.stat(DATA_ROOT);
  if (!stat.isDirectory()) {
    throw new Error(`data root is not a directory: ${DATA_ROOT}`);
  }
}

/**
 * Strips the internal DATA_ROOT prefix from error messages so clients see
 * only the relative path (e.g. `scandir 'srv_xxx'` instead of `scandir '\\wsl.localhost\...\srv_xxx'`).
 */
export function sanitizePath(text: string): string {
  if (!text) return text;
  const root = DATA_ROOT;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  const rootPosix = root.replace(/\\/g, "/");
  const rootPosixWithSep = rootPosix.endsWith("/") ? rootPosix : rootPosix + "/";
  const rootEscaped = root.replace(/\\/g, "\\\\");
  const rootEscapedWithSep = rootEscaped + "\\\\";

  return text
    .split(rootEscapedWithSep).join("")
    .split(rootEscaped).join("")
    .split(rootWithSep).join("")
    .split(rootPosixWithSep).join("")
    .split(root).join("");
}

/**
 * Resolves a client-supplied relative path and rejects any lexical escape
 * (`..`, absolute paths, drive letters). Storage is single-rooted, so every path
 * is confined to the canonical DATA_ROOT with no per-server override.
 */
export function resolveSafe(relPath: string): string {
  const target = path.resolve(DATA_ROOT, relPath || ".");
  const rootWithSep = DATA_ROOT.endsWith(path.sep) ? DATA_ROOT : DATA_ROOT + path.sep;
  if (target !== DATA_ROOT && !target.startsWith(rootWithSep)) {
    throw new PathTraversalError(relPath);
  }
  return target;
}

/**
 * Confines `relPath` to `scopeRel` (both relative to DATA_ROOT). Resolves first,
 * so `server/a/../b` is rejected even though its string prefix looks in-scope.
 */
export function assertWithinScope(scopeRel: string, relPath: string): void {
  const scope = resolveSafe(scopeRel);
  const target = resolveSafe(relPath);
  const sep = scope.endsWith(path.sep) ? scope : scope + path.sep;
  if (target !== scope && !target.startsWith(sep)) {
    throw new PathTraversalError(relPath);
  }
}

export async function listDir(relPath: string): Promise<FileListing> {
  const abs = resolveSafe(relPath);
  try {
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      const stat = await fs.stat(path.join(abs, dirent.name));
      entries.push({
        name: dirent.name,
        type: dirent.isDirectory() ? "dir" : "file",
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    return { path: relPath || ".", entries };
  } catch (err) {
    if (err instanceof Error) {
      err.message = sanitizePath(err.message);
    }
    throw err;
  }
}

export async function readFileText(relPath: string): Promise<string> {
  try {
    return await fs.readFile(resolveSafe(relPath), "utf8");
  } catch (err) {
    if (err instanceof Error) {
      err.message = sanitizePath(err.message);
    }
    throw err;
  }
}

export async function writeFileText(relPath: string, content: string): Promise<void> {
  const abs = resolveSafe(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/**
 * Largest total one upload may reach, shared as a size ceiling by the raw
 * upload route and by software downloads. Defaults to 8 GiB so multi-GB
 * modpacks/worlds fit; override with MCM_MAX_UPLOAD_BYTES. ponytail: still one
 * global cap, no per-user quotas.
 */
export const MAX_UPLOAD_BYTES = Number(process.env.MCM_MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024 * 1024);

/**
 * Per-request ceiling for the raw upload route only. A single chunk is never
 * large (the client slices 1 MiB at a time), so this bounds RAM per request
 * without capping the whole file: chunks accumulate into a file that may grow
 * up to MAX_UPLOAD_BYTES. Override with MCM_MAX_UPLOAD_CHUNK_BYTES.
 */
export const MAX_UPLOAD_CHUNK_BYTES = Number(process.env.MCM_MAX_UPLOAD_CHUNK_BYTES ?? 32 * 1024 * 1024);

export interface UploadTarget {
  abs: string;
  existingBytes: number;
}

/** Resolves an upload target through resolveSafe and reports existing size (for resume). */
export async function resolveUploadTarget(relPath: string): Promise<UploadTarget> {
  const abs = resolveSafe(relPath);
  let existingBytes = 0;
  try {
    existingBytes = (await fs.stat(abs)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { abs, existingBytes };
}

/** True when something (file or directory) already exists at the resolved path. */
export async function entryExists(relPath: string): Promise<boolean> {
  try {
    await fs.stat(resolveSafe(relPath));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Picks a non-colliding sibling name for the `keep_both` upload policy: inserts
 * ` (n)` before the extension, e.g. `world.zip` -> `world (1).zip`. Returns the
 * input unchanged when the parent directory does not exist yet (no collision).
 */
export async function nextAvailableName(relPath: string): Promise<string> {
  const dir = path.posix.dirname(relPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir === "." ? resolveSafe("") : resolveSafe(dir));
  } catch {
    return relPath;
  }
  const base = path.posix.basename(relPath);
  const lower = new Set(entries.map((e) => e.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return relPath;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; n < 10_000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!lower.has(candidate.toLowerCase())) return dir === "." ? candidate : `${dir}/${candidate}`;
  }
  return relPath;
}

/**
 * Appends or resumes binary data.
 * - `offset === 0` writes a fresh file (safe restart of an aborted upload).
 * - `offset === undefined` appends (single-shot upload).
 * - any other `offset` must equal the current file size; a mismatch throws
 *   RangeError so a retried chunk can never overwrite earlier bytes.
 * Returns the resulting total size in bytes.
 */
export async function appendChunk(relPath: string, data: Buffer, offset?: number): Promise<number> {
  const { abs, existingBytes } = await resolveUploadTarget(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (offset === 0) {
    await fs.writeFile(abs, data);
    return data.length;
  }
  if (offset !== undefined && offset !== existingBytes) {
    throw new RangeError(`offset_mismatch: expected ${existingBytes} bytes, received offset ${offset}`);
  }
  await fs.appendFile(abs, data);
  return existingBytes + data.length;
}

export async function deleteEntry(relPath: string): Promise<void> {
  if (!relPath || relPath === "." || relPath === "/") {
    throw new PathTraversalError(relPath);
  }
  await fs.rm(resolveSafe(relPath), { recursive: true, force: true });
}

export interface ExportEntry {
  name: string;
  data: Buffer;
}

/**
 * Recursively collects every file under DATA_ROOT as archive entries. Read-only:
 * nothing on disk is modified or removed.
 */
export async function collectDataFiles(): Promise<ExportEntry[]> {
  const entries: ExportEntry[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) await walk(childAbs, childRel);
      else entries.push({ name: childRel, data: await fs.readFile(childAbs) });
    }
  }
  try {
    await walk(DATA_ROOT, "");
  } catch (err) {
    // A missing data root is an empty export, not a failure.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return entries;
}

export class TargetExistsError extends Error {
  constructor(relPath: string) {
    super(`target already exists: ${relPath}`);
    this.name = "TargetExistsError";
  }
}

/**
 * Renames/moves one entry inside DATA_ROOT. Both sides go through resolveSafe,
 * so neither can escape the root. Refuses to overwrite an existing target and
 * refuses to touch the root itself.
 * ponytail: same-volume rename only; a cross-device move would need a copy step.
 */
export async function renameEntry(fromRel: string, toRel: string): Promise<void> {
  if (!fromRel || fromRel === "." || fromRel === "/") throw new PathTraversalError(fromRel);
  if (!toRel || toRel === "." || toRel === "/") throw new PathTraversalError(toRel);
  const fromAbs = resolveSafe(fromRel);
  const toAbs = resolveSafe(toRel);
  if (fromAbs === toAbs) return;
  try {
    await fs.access(toAbs);
    throw new TargetExistsError(toRel);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  await fs.rename(fromAbs, toAbs);
}

/** Removes a path if it exists; returns whether anything was removed. */
export async function removeIfExists(relPath: string): Promise<boolean> {
  const abs = resolveSafe(relPath);
  try {
    await fs.access(abs);
  } catch {
    return false;
  }
  await fs.rm(abs, { recursive: true, force: true });
  return true;
}

// --- Canonical storage root --------------------------------------------------
// Storage is single-rooted container-side: DATA_ROOT is the distro's `/server`
// directory, so one server's files live at `<DATA_ROOT>/<id>` == `/server/<id>`. The
// former operator-pinned external host folder, its validation, and the host browse
// bridge were retired: no path can now redirect a server's files or the runc jar bind
// outside this root, and a server record needs no per-server root override.

/** Absolute data dir for a server: `<DATA_ROOT>/<id>`, i.e. `/server/<id>`. */
export function serverRootAbs(record: { id: string }): string {
  return path.join(DATA_ROOT, record.id);
}

// --- Live storage measurement (async, cached) --------------------------------
// The metrics and world routes report real storage numbers. A directory walk is
// I/O heavy, so results are cached for a short TTL and concurrent callers share
// one in-flight walk (single-flight). Read-only: nothing on disk is modified.

export interface DirMeasurement {
  sizeBytes: number;
  files: number;
  modifiedAt: string | null;
}

const DIR_MEASURE_TTL_MS = 60_000;
const dirMeasureCache = new Map<string, { at: number; value: DirMeasurement | null }>();
const dirMeasureInflight = new Map<string, Promise<DirMeasurement | null>>();

/**
 * Recursively measures one directory under DATA_ROOT: total file bytes, file
 * count, and newest file mtime. Unreadable entries are skipped so one locked
 * file does not fail the whole walk. Returns null when the directory itself
 * cannot be read (e.g. it does not exist yet). Cached for `DIR_MEASURE_TTL_MS`
 * with single-flight so polling never re-walks the same tree concurrently.
 */
export async function measureDir(relDir: string): Promise<DirMeasurement | null> {
  const key = relDir || ".";
  const cached = dirMeasureCache.get(key);
  if (cached && Date.now() - cached.at < DIR_MEASURE_TTL_MS) return cached.value;

  const inflight = dirMeasureInflight.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<DirMeasurement | null> => {
    let sizeBytes = 0;
    let files = 0;
    let newestMs = 0;
    let readable = false;
    async function walk(abs: string): Promise<void> {
      let dirents;
      try {
        dirents = await fs.readdir(abs, { withFileTypes: true });
      } catch {
        return; // unreadable directory: skip it, keep the rest of the walk
      }
      readable = true;
      for (const dirent of dirents) {
        const childAbs = path.join(abs, dirent.name);
        if (dirent.isDirectory()) {
          await walk(childAbs);
          continue;
        }
        try {
          const stat = await fs.stat(childAbs);
          sizeBytes += stat.size;
          files += 1;
          if (stat.mtimeMs > newestMs) newestMs = stat.mtimeMs;
        } catch {
          // unreadable file: skip it
        }
      }
    }

    try {
      await walk(resolveSafe(relDir));
    } catch {
      return null;
    }
    if (!readable) return null;
    return { sizeBytes, files, modifiedAt: newestMs > 0 ? new Date(newestMs).toISOString() : null };
  })();

  dirMeasureInflight.set(key, run);
  try {
    const value = await run;
    dirMeasureCache.set(key, { at: Date.now(), value });
    return value;
  } finally {
    dirMeasureInflight.delete(key);
  }
}

export interface RootStatfs {
  freeBytes: number;
  totalBytes: number;
}

/**
 * Volume free/total bytes for the filesystem holding DATA_ROOT, via statfs.
 * Returns null when the platform or filesystem does not report it.
 */
export async function dataRootStatfs(): Promise<RootStatfs | null> {
  try {
    const s = await fs.statfs(DATA_ROOT, { bigint: true });
    const blockSize = Number(s.bsize);
    return { freeBytes: Number(s.bavail) * blockSize, totalBytes: Number(s.blocks) * blockSize };
  } catch {
    return null;
  }
}

// --- EULA --------------------------------------------------------------------
// eula.txt is generated by Minecraft on first boot. The operator must agree, so
// this service only READS the state and writes the file when the user explicitly
// confirms it - it never accepts the EULA on their behalf.

export type EulaState = "accepted" | "declined" | "missing";

const EULA_FILE = "eula.txt";

/** Reads a server's EULA state from `<relDir>/eula.txt`; missing/unreadable is "missing". */
export async function readEula(relDir: string): Promise<EulaState> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveSafe(`${relDir}/${EULA_FILE}`), "utf8");
  } catch {
    return "missing";
  }
  const match = /^\s*eula\s*=\s*(true|false)\s*$/im.exec(raw);
  return match ? (match[1].toLowerCase() === "true" ? "accepted" : "declined") : "missing";
}

/** Writes `<relDir>/eula.txt` with the operator's explicit decision, preserving the header. */
export async function writeEula(relDir: string, accepted: boolean): Promise<void> {
  const abs = resolveSafe(`${relDir}/${EULA_FILE}`);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    "#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\n" +
      `eula=${accepted ? "true" : "false"}\n`,
    "utf8",
  );
}
