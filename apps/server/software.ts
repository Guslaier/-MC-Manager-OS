import fs from "node:fs/promises";
import path from "node:path";
import type { ChmodResult, SoftwareEntry, SoftwareKind, SoftwareListing } from "@mcm/contracts";
import { CANONICAL_JAR_NAME } from "@mcm/contracts";
import { MAX_UPLOAD_BYTES, resolveSafe } from "./files.js";

// Software boundary: every download/upload of Alpine rootfs, JRE, server .jar or
// .sh script lands under DATA_ROOT/software/<kind>/. Nothing here ever runs a
// container: it only prepares the files the engine will later bind into one.

export const SOFTWARE_KINDS: SoftwareKind[] = ["rootfs", "jre", "core", "script"];

/** Allowed extensions per kind. Rejection is explicit, never a silent rename. */
const ALLOWED_EXT: Record<SoftwareKind, string[]> = {
  rootfs: [".tar", ".tar.gz", ".tgz", ".apk", ".tar.xz"],
  jre: [".tar.gz", ".tgz", ".tar"],
  core: [".jar", ".zip"],
  script: [".sh"],
};

export function isSoftwareKind(value: unknown): value is SoftwareKind {
  return typeof value === "string" && (SOFTWARE_KINDS as string[]).includes(value);
}

export function softwareRoot(kind: SoftwareKind): string {
  return `software/${kind}`;
}

/**
 * Reduces a client/URL supplied name to a safe basename and enforces the
 * extension allow-list for the kind. Traversal, separators and query noise are
 * stripped rather than trusted; a wrong extension is an error.
 */
export function sanitizeFilename(kind: SoftwareKind, raw: string): string {
  const decoded = decodeURIComponent(raw.split("?")[0].split("#")[0]);
  const base = path.basename(decoded);
  if (!base || base === "." || base === ".." || base !== decoded.replace(/\\/g, "/").split("/").pop()) {
    throw new Error(`invalid_filename: ${raw}`);
  }
  const lower = base.toLowerCase();
  if (!ALLOWED_EXT[kind].some((ext) => lower.endsWith(ext))) {
    throw new Error(`extension_not_allowed: ${kind} accepts ${ALLOWED_EXT[kind].join(", ")}`);
  }
  return base;
}

/** Extracts a file name from an http(s) URL; other schemes are refused. */
export function filenameFromUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`unsupported_url_scheme: ${parsed.protocol}`);
  }
  const name = path.basename(parsed.pathname);
  if (!name) throw new Error("url_has_no_filename");
  return name;
}

export interface DownloadResult {
  kind: SoftwareKind;
  path: string;
  filename: string;
  bytes: number;
  executable: boolean;
}

/** A .jar must be a ZIP archive; the first 4 bytes decide, extension alone is not proof. */
export function isJarArchive(data: Buffer): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/**
 * Downloads a file into software/<kind>/. Size is checked against the declared
 * Content-Length first and against the received buffer second, so a lying header
 * cannot exceed the cap. `.sh` files are marked executable immediately.
 */
export async function downloadSoftware(
  kind: SoftwareKind,
  url: string,
  filename?: string,
  targetDir?: string,
): Promise<DownloadResult> {
  const rawName = filename ?? filenameFromUrl(url);
  // The canonical Fabric installer endpoint ends in ".../server/jar" with no
  // file extension. A core download is a jar by definition, so append the
  // extension rather than reject the URL; the PK-magic check below still proves
  // the body really is a ZIP/JAR.
  const candidate = kind === "core" && path.extname(rawName.split("?")[0]) === "" ? `${rawName}.jar` : rawName;
  const name = sanitizeFilename(kind, candidate);
  const relPath = `${targetDir ?? softwareRoot(kind)}/${name}`;
  const abs = resolveSafe(relPath);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`download_failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new Error(`too_large: ${declared} > ${MAX_UPLOAD_BYTES} bytes`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_UPLOAD_BYTES) throw new Error(`too_large: ${data.length} > ${MAX_UPLOAD_BYTES} bytes`);
  if (kind === "core" && !isJarArchive(data)) {
    throw new Error(`invalid_jar_content: response is not a ZIP/JAR archive (PK magic missing)`);
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);

  let executable = false;
  if (kind === "script") executable = (await setExecutable(relPath, true)).executable;
  return { kind, path: relPath, filename: name, bytes: data.length, executable };
}

/** Result of canonicalising a server core jar to server/<id>/server.jar. */
export interface StagedJar {
  /** Data-root relative path of the canonical file. */
  path: string;
  filename: string;
  /** Set when a canonical and a legacy jar coexist, so neither was moved. */
  conflict?: string;
}

/** True when the file at `abs` begins with the ZIP/JAR (PK\x03\x04) magic. */
async function isJarAt(abs: string): Promise<boolean> {
  try {
    const handle = await fs.open(abs, "r");
    try {
      const head = Buffer.alloc(8);
      await handle.read(head, 0, head.length, 0);
      return isJarArchive(head);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/**
 * Canonicalises a server core jar to server/<id>/server.jar without data loss.
 * The source is renamed only when the destination is absent; when a canonical and a
 * legacy jar both exist, both are kept and the canonical one wins, reported as an
 * explicit conflict rather than a silent overwrite.
 */
export async function stageCanonicalJar(
  serverDir: string,
  sourceRel: string,
  sourceName: string,
): Promise<StagedJar> {
  const destRel = `${serverDir}/${CANONICAL_JAR_NAME}`;
  const srcAbs = resolveSafe(sourceRel);
  const destAbs = resolveSafe(destRel);
  if (path.resolve(destAbs) === path.resolve(srcAbs)) return { path: destRel, filename: CANONICAL_JAR_NAME };
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  if ((await isJarAt(destAbs)) && (await isJarAt(srcAbs))) {
    return {
      path: destRel,
      filename: CANONICAL_JAR_NAME,
      conflict: `${CANONICAL_JAR_NAME} already exists; kept it and left ${sourceName} untouched - delete one to change the launch jar`,
    };
  }
  await fs.rm(destAbs, { force: true });
  await fs.rename(srcAbs, destAbs);
  return { path: destRel, filename: CANONICAL_JAR_NAME };
}

/**
 * Toggles the POSIX exec bit. Windows has no such bit, so the requested state is
 * reported honestly as unenforced there instead of pretending it worked.
 */
export async function setExecutable(relPath: string, executable: boolean): Promise<ChmodResult> {
  const abs = resolveSafe(relPath);
  const before = ((await fs.stat(abs)).mode & 0o111) !== 0;
  if (before === executable) return { path: relPath, executable, changed: false };
  await fs.chmod(abs, executable ? 0o755 : 0o644);
  const onWindows = process.platform === "win32";
  return {
    path: relPath,
    executable,
    changed: !onWindows,
    note: onWindows ? "windows_has_no_posix_exec_bit" : undefined,
  };
}

/** Lists installed software for one kind; a missing directory is simply empty. */
export async function listSoftware(kind: SoftwareKind): Promise<SoftwareListing> {
  const abs = resolveSafe(softwareRoot(kind));
  let dirents: Array<{ name: string; isFile(): boolean }> = [];
  try {
    dirents = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const entries: SoftwareEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const stat = await fs.stat(path.join(abs, dirent.name));
    entries.push({
      kind,
      name: dirent.name,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      executable: (stat.mode & 0o111) !== 0,
    });
  }
  return { kind, entries };
}

// Self-check: run with MCM_SOFTWARE_SELFCHECK=1 npx tsx apps/server/software.ts
if (process.env.MCM_SOFTWARE_SELFCHECK === "1") {
  const assert = (condition: boolean, message: string): void => {
    console.log(`${condition ? "ok" : "FAIL"}: ${message}`);
    if (!condition) process.exitCode = 1;
  };
  const rejects = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  assert(sanitizeFilename("core", "server.jar") === "server.jar", "plain jar name kept");
  assert(sanitizeFilename("core", "../../etc/passwd.jar") === "passwd.jar", "traversal reduced to basename");
  assert(rejects(() => sanitizeFilename("core", "evil.sh")), "wrong extension rejected");
  assert(rejects(() => sanitizeFilename("script", "run.bat")), "bat rejected for script kind");
  assert(rejects(() => filenameFromUrl("file:///c:/x.jar")), "non-http scheme rejected");
  assert(filenameFromUrl("https://cdn.example.com/build/tools/jre.tar.gz") === "jre.tar.gz", "url filename extracted");
  assert(SOFTWARE_KINDS.length === 4, "four software kinds declared");
  assert(isJarArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])) === true, "zip magic accepted");
  assert(isJarArchive(Buffer.from("<html>not a jar")) === false, "html refused as jar");
  assert(isJarArchive(Buffer.from([0x50, 0x4b])) === false, "truncated header refused");
}
