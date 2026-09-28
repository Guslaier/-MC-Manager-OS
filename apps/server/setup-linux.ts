// Linux / WSL-native setup and prerequisite check for MC-Manager OS.
//
// Safety contract:
//  - Default mode is --check (never installs anything, exit 1 when something is missing).
//  - Privileged package installation happens ONLY with the explicit "--apply --yes" opt-in.
//  - Every external command is an argv array passed to spawnSync; no shell, no interpolation.
//  - On Windows the script refuses and exits 2 without touching anything (use the WSL path there).
//
// Usage (inside the Linux distro/host, from the repo root):
//   npm run setup:linux                # same as --check
//   npx tsx apps/server/setup-linux.ts --check
//   npx tsx apps/server/setup-linux.ts --apply --yes
//   npx tsx apps/server/setup-linux.ts --bootstrap-rootfs                 # dry-run plan (default)
//   npx tsx apps/server/setup-linux.ts --bootstrap-rootfs --apply --yes   # download + extract rootfs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

type Component = "node" | "npm" | "runc" | "java";

interface PkgManager {
  id: string;
  /** argv that refreshes package metadata (optional). */
  refresh?: string[];
  /** argv (minus packages) that installs packages. */
  install: (pkgs: string[]) => string[];
  /** distro package name per component. */
  pkgs: Record<Component, string[]>;
}

const PKG_MANAGERS: PkgManager[] = [
  {
    id: "apt-get",
    refresh: ["apt-get", "update"],
    install: (p) => ["apt-get", "install", "-y", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["openjdk-17-jre-headless"] },
  },
  {
    id: "dnf",
    install: (p) => ["dnf", "install", "-y", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["java-17-openjdk-headless"] },
  },
  {
    id: "yum",
    install: (p) => ["yum", "install", "-y", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["java-17-openjdk-headless"] },
  },
  {
    id: "apk",
    install: (p) => ["apk", "add", "--no-cache", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["openjdk17-jre"] },
  },
  {
    id: "pacman",
    refresh: ["pacman", "-Sy"],
    install: (p) => ["pacman", "-S", "--noconfirm", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["jre17-openjdk"] },
  },
  {
    id: "zypper",
    install: (p) => ["zypper", "--non-interactive", "install", ...p],
    pkgs: { node: ["nodejs", "npm"], npm: [], runc: ["runc"], java: ["java-17-openjdk-headless"] },
  },
];

const CHECK_ONLY = !process.argv.includes("--apply");
const CONFIRMED = process.argv.includes("--yes");
const BOOTSTRAP = process.argv.includes("--bootstrap-rootfs");
const ROOTFS = process.env.MCM_WSL_ROOTFS ?? "/var/lib/mcm/rootfs";
const CGROUP_CONTROLLERS = "/sys/fs/cgroup/cgroup.controllers";
const CGROUP_V2_MOUNT = "/sys/fs/cgroup";

// Official Alpine minirootfs used to bootstrap MCM_WSL_ROOTFS. Same release line as
// provisioning.ts (Windows/WSL). The SHA256 is deliberately NOT defaulted: it must be
// provided explicitly so an unverified tarball is never extracted.
const DEFAULT_ALPINE_TAR_URL =
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.4-x86_64.tar.gz";
const ALPINE_HOSTS = ["dl-cdn.alpinelinux.org", "dl-4.alpinelinux.org"];
const SHA256_RE = /^[0-9a-f]{64}$/;

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Runs an argv array directly (no shell). Returns null when the binary is absent. */
function run(argv: string[]): { status: number; out: string } | null {
  const res = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 30_000 });
  if (res.error) return null;
  return { status: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
}

function detectManager(): PkgManager | null {
  for (const m of PKG_MANAGERS) {
    if (run([m.id, "--version"])) return m;
  }
  return null;
}

function nodeVersion(): string | null {
  const v = run(["node", "--version"]);
  return v?.status === 0 ? firstLine(v.out) : null;
}

function npmVersion(): string | null {
  const v = run(["npm", "--version"]);
  return v?.status === 0 ? firstLine(v.out) : null;
}

function runcVersion(): string | null {
  const v = run(["runc", "--version"]);
  return v?.status === 0 ? firstLine(v.out) : null;
}

/**
 * Host JRE discovery. Debian/RHEL place the JRE in `/usr/lib/jvm/<name>/bin/java`
 * (e.g. java-17-openjdk-amd64); Alpine uses `/usr/lib/jvm/java-17-openjdk/bin/java`.
 * Returns the resolved binary path so callers never guess a distro-specific dirname.
 */
function javaBinary(): string | null {
  const jvmRoot = "/usr/lib/jvm";
  if (existsSync(jvmRoot)) {
    for (const entry of readdirSync(jvmRoot)) {
      const candidate = path.join(jvmRoot, entry, "bin", "java");
      if (existsSync(candidate)) return candidate;
    }
  }
  const pathJava = run(["java", "-version"]);
  return pathJava?.status === 0 ? "java" : null;
}

function javaVersion(binary: string): string | null {
  const v = run([binary, "-version"]);
  return v?.status === 0 ? firstLine(v.out) : null;
}

function cgroupV2(): { ok: boolean; detail: string } {
  try {
    const controllers = readFileSync(CGROUP_CONTROLLERS, "utf8").trim();
    if (!controllers) return { ok: false, detail: `${CGROUP_CONTROLLERS} is empty: not a cgroup v2 unified hierarchy` };
    const mounted = existsSync(CGROUP_V2_MOUNT);
    return { ok: mounted, detail: `cgroup v2 controllers: ${controllers}` };
  } catch {
    return {
      ok: false,
      detail: `${CGROUP_CONTROLLERS} not readable: boot with cgroup v2 (unified) and run as root`,
    };
  }
}

function rootfsState(): { ok: boolean; detail: string } {
  if (!existsSync(ROOTFS)) {
    return {
      ok: false,
      detail: `rootfs template missing at ${ROOTFS}: untar an Alpine/minirootfs there, or set MCM_WSL_ROOTFS`,
    };
  }
  if (!statSync(ROOTFS).isDirectory()) {
    return { ok: false, detail: `${ROOTFS} exists but is not a directory` };
  }
  const shell = path.join(ROOTFS, "bin", "sh");
  if (!existsSync(shell)) {
    return {
      ok: false,
      detail: `${ROOTFS} has no bin/sh: the rootfs template is incomplete (untar a full minirootfs again)`,
    };
  }
  const hasOsRelease = existsSync(path.join(ROOTFS, "etc", "os-release"));
  const hasApk = existsSync(path.join(ROOTFS, "sbin", "apk"));
  return {
    ok: true,
    detail: `${ROOTFS} (bin/sh present${hasOsRelease ? ", /etc/os-release" : ", /etc/os-release MISSING"}${hasApk ? ", apk" : ", no apk"})`,
  };
}

/**
 * Rootfs bootstrap source. The tarball URL is overridable but must be HTTPS on a
 * verified Alpine mirror; the SHA256 is mandatory (fail closed) so an unverified
 * tarball is never extracted into the rootfs template.
 */
function bootstrapSource(): { url: string; sha: string } {
  const url = (process.env.MCM_ALPINE_TAR_URL ?? DEFAULT_ALPINE_TAR_URL).trim();
  const sha = (process.env.MCM_ALPINE_SHA256 ?? "").trim().toLowerCase();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MCM_ALPINE_TAR_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`MCM_ALPINE_TAR_URL must use https: ${url}`);
  if (!ALPINE_HOSTS.includes(parsed.hostname)) {
    throw new Error(`MCM_ALPINE_TAR_URL host ${parsed.hostname} is not in the verified allowlist (${ALPINE_HOSTS.join(", ")})`);
  }
  if (!parsed.pathname.endsWith(".tar.gz")) throw new Error(`MCM_ALPINE_TAR_URL must point at a .tar.gz minirootfs: ${url}`);
  if (!SHA256_RE.test(sha)) {
    throw new Error(
      "MCM_ALPINE_SHA256 must be set to the 64-hex SHA256 of the Alpine minirootfs (fail closed, no unverified download)",
    );
  }
  return { url, sha };
}

/** True when the rootfs directory holds anything besides "." / ".." (never overwrite it). */
function rootfsNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Extracts an Alpine minirootfs tarball (gzip-wrapped ustar) directly into `dest`.
 * Regular files, directories, symlinks and hardlinks are created; device, FIFO and
 * any other exotic entry type is refused. Both the entry path and every link target
 * are confined to `dest`, so a crafted tarball can never write or link outside the
 * rootfs directory.
 */
function extractMiniRootfs(tarGzPath: string, dest: string): { files: number; dirs: number } {
  const tar = gunzipSync(readFileSync(tarGzPath));
  const destination = path.resolve(dest);
  let offset = 0;
  let files = 0;
  let dirs = 0;
  // Resolves a tar entry to an absolute path and rejects anything outside `destination`.
  const confine = (label: string, abs: string): string => {
    if (abs !== destination && !abs.startsWith(destination + path.sep)) {
      throw new Error(`tar entry escapes the rootfs directory: ${label}`);
    }
    return abs;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const name = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid tar entry size for ${name}`);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const linkname = header.subarray(157, 257).toString("utf8").replace(/\0.*$/, "");
    const dataStart = offset + 512;
    const next = dataStart + Math.ceil(size / 512) * 512;

    if (!name) {
      offset = next;
      continue;
    }
    const target = confine(name, path.resolve(destination, name));
    if (typeflag === "5" || (size === 0 && name.endsWith("/"))) {
      mkdirSync(target, { recursive: true });
      dirs += 1;
    } else if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, tar.subarray(dataStart, dataStart + size));
      files += 1;
    } else if (typeflag === "2") {
      // Symlink. The stored target can be absolute (container-root-relative) or relative
      // to the entry's own directory; the resolved in-rootfs path is validated, but the
      // link itself keeps its original target so it resolves inside the container.
      if (!linkname) throw new Error(`tar symlink ${name} has an empty target`);
      const resolvedRel = linkname.startsWith("/")
        ? linkname.slice(1)
        : path.join(path.dirname(name), linkname);
      confine(name, path.resolve(destination, resolvedRel));
      mkdirSync(path.dirname(target), { recursive: true });
      rmSync(target, { force: true });
      symlinkSync(linkname, target);
      files += 1;
    } else if (typeflag === "1") {
      // Hardlink. The target names another entry that must already exist in the rootfs.
      if (!linkname) throw new Error(`tar hardlink ${name} has an empty target`);
      const linkRel = linkname.startsWith("/") ? linkname.slice(1) : linkname;
      const linkSource = confine(name, path.resolve(destination, linkRel));
      if (!existsSync(linkSource)) {
        throw new Error(`tar hardlink ${name} points at a missing entry: ${linkname}`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      rmSync(target, { force: true });
      linkSync(linkSource, target);
      files += 1;
    } else {
      throw new Error(`unsupported tar entry type '${typeflag}' for ${name}: only files, directories, symlinks and hardlinks are extracted`);
    }
    offset = next;
  }
  return { files, dirs };
}

/** Streams the tarball to disk (never buffered whole) and returns its SHA256. */
async function downloadTarball(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  if (!res.body) throw new Error(`empty response body for ${url}`);
  const hash = createHash("sha256");
  const out = createWriteStream(dest);
  let bytes = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      hash.update(buf);
      bytes += buf.length;
      if (!out.write(buf)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
  } finally {
    out.end();
  }
  await new Promise<void>((resolve, reject) => {
    out.once("close", () => resolve());
    out.once("error", reject);
  });
  if (bytes === 0) throw new Error(`download produced 0 bytes from ${url}`);
  return hash.digest("hex");
}

/**
 * Prepares ROOTFS from a verified Alpine minirootfs tarball. Never clobbers a
 * non-empty existing rootfs, verifies the SHA256 before extracting anything, and
 * reports the plan only in dry-run mode (no download, no write).
 */
async function bootstrapRootfs(): Promise<void> {
  log("MC-Manager OS - rootfs bootstrap");
  log(`rootfs: ${ROOTFS}`);

  if (rootfsNonEmpty(ROOTFS)) {
    log("");
    log(`[refused] ${ROOTFS} already exists and is not empty; it is never overwritten.`);
    log("  Move or remove it yourself first if you really want a fresh template, then re-run.");
    process.exitCode = 1;
    return;
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (!isRoot) {
    log("");
    log("[error] bootstrapping the rootfs needs root; re-run as root (or with sudo)");
    process.exitCode = 1;
    return;
  }

  let config: { url: string; sha: string };
  try {
    config = bootstrapSource();
  } catch (err) {
    log("");
    log(`[error] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  log(`source: ${config.url}`);
  log(`expected sha256: ${config.sha}`);

  if (CHECK_ONLY) {
    log("");
    log("[plan] would download the tarball, verify its sha256, and extract it into the rootfs directory");
    log("[hint] re-run with --bootstrap-rootfs --apply --yes to perform the download and extraction");
    log("[result] dry-run complete - nothing was downloaded or written");
    process.exitCode = 0;
    return;
  }
  if (!CONFIRMED) {
    log("");
    log("[refused] --apply requires --yes: this downloads a tarball and writes it as root.");
    process.exitCode = 2;
    return;
  }

  const tmp = path.join(os.tmpdir(), `mcm-rootfs-${Date.now()}.tar.gz`);
  try {
    let actual: string;
    try {
      actual = await downloadTarball(config.url, tmp);
    } catch (err) {
      log(`[error] download failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (actual !== config.sha) {
      log(`[error] sha256 mismatch: expected ${config.sha}, got ${actual}; nothing was extracted`);
      process.exitCode = 1;
      return;
    }

    mkdirSync(ROOTFS, { recursive: true });
    try {
      const counts = extractMiniRootfs(tmp, ROOTFS);
      log(`[ok] extracted ${counts.files} files and ${counts.dirs} directories into ${ROOTFS}`);
      log(`[result] ${rootfsState().detail}`);
    } catch (err) {
      log(`[error] extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  } finally {
    // The downloaded tarball is a temporary artifact and is never left behind.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort cleanup */
    }
  }
  log("[hint] re-run without --bootstrap-rootfs to confirm the prerequisites");
  process.exitCode = 0;
}

/** Refuses early on Windows: the native path is Linux-only; Windows uses the WSL bridge. */
function refuseOnWindows(): boolean {
  if (process.platform === "win32") {
    log("[refused] setup:linux is Linux-only.");
    log("  This host is Windows. Use the WSL2 path instead: MCM_RUNTIME_MODE=wsl with the");
    log("  distro provisioning steps (/api/provision), or run this command INSIDE the distro:");
    log("  wsl -d MC-Manager-OS -u root -- bash -lc \"cd /mnt/c/<repo> && npx tsx apps/server/setup-linux.ts --check\"");
    process.exitCode = 2;
    return true;
  }
  return false;
}

function envLeakWarnings(): string[] {
  const warnings: string[] = [];
  const dataDir = process.env.MCM_DATA_DIR ?? "";
  if (dataDir.startsWith("\\\\") || dataDir.startsWith("//")) {
    warnings.push(
      `MCM_DATA_DIR='${dataDir}' is a Windows UNC path; it cannot be used on Linux. Unset it to get ~/.mc-manager.`,
    );
  }
  if ((process.env.MCM_RUNTIME_MODE ?? "").toLowerCase() === "wsl") {
    warnings.push("MCM_RUNTIME_MODE=wsl is Windows-only; use 'auto' or 'native' on Linux.");
  }
  return warnings;
}

function main(): void {
  if (refuseOnWindows()) return;

  // Opt-in rootfs bootstrap is a separate, self-contained mode: it never runs the
  // prerequisite check and performs no privileged action unless --apply --yes is given.
  if (BOOTSTRAP) {
    void bootstrapRootfs().catch((err) => {
      log(`[error] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
    return;
  }

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const manager = detectManager();
  const node = nodeVersion();
  const npm = npmVersion();
  const runc = runcVersion();
  const jvm = javaBinary();
  const java = jvm ? javaVersion(jvm) : null;
  const cgroup = cgroupV2();
  const rootfs = rootfsState();

  log(`MC-Manager OS - Linux native prerequisites (${CHECK_ONLY ? "check/dry-run" : "apply"})`);
  log(`host: ${process.platform} | uid=${isRoot ? "0 (root)" : String(process.getuid?.() ?? "unknown")} | package manager: ${manager?.id ?? "none detected"}`);
  log("");

  const missing: Component[] = [];
  const report = (label: string, ok: boolean, detail: string): void => {
    log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
  };

  report("node", Boolean(node), node ?? "not found on PATH (install nodejs)");
  report("npm", Boolean(npm), npm ?? "not found on PATH (install npm)");
  report("runc", Boolean(runc), runc ?? "not found on PATH (container runtime is required)");
  report("java", Boolean(java), java ? `${java} (${jvm})` : "no JRE found under /usr/lib/jvm and java not on PATH");
  report("cgroup v2", cgroup.ok, cgroup.detail);
  report("rootfs", rootfs.ok, rootfs.detail);
  if (!isRoot) log("[warn] not running as root: runc needs root (or a root-owned user namespace) to start containers");

  if (!node) missing.push("node");
  if (!npm) missing.push("npm");
  if (!runc) missing.push("runc");
  if (!java) missing.push("java");

  const leaks = envLeakWarnings();
  for (const w of leaks) log(`[warn] environment leak: ${w}`);

  const hardened = missing.length === 0 && cgroup.ok && rootfs.ok && isRoot && leaks.length === 0;

  if (missing.length > 0 || !cgroup.ok || !rootfs.ok) {
    log("");
    log("--- actionable fixes ---");
    for (const c of missing) {
      if (!manager) {
        log(`[fix] ${c}: no supported package manager found; install ${c} manually (apt/dnf/yum/apk/pacman/zypper supported)`);
        continue;
      }
      const pkgs = manager.pkgs[c];
      if (pkgs.length === 0) {
        log(`[fix] ${c}: provided by the '${manager.id}' package set for node (install nodejs + npm)`);
        continue;
      }
      log(`[fix] ${c}: ${[...manager.install(pkgs)].join(" ")}`);
    }
    if (!cgroup.ok) log("[fix] cgroup v2: boot the kernel with unified cgroup hierarchy (WSL2: cgroup2 is default; do not add systemd.unified_cgroup_hierarchy=0)");
    if (!rootfs.ok) {
      log(`[fix] rootfs: untar a minirootfs into ${ROOTFS} (e.g. alpine-minirootfs tarball), then re-run this check`);
      log("[fix] rootfs: or bootstrap it with '--bootstrap-rootfs --apply --yes' (requires MCM_ALPINE_SHA256; see srs.md 2.2)");
    }
    if (leaks.length > 0) log("[fix] env: unset MCM_DATA_DIR (or point it at a real Linux path) and set MCM_RUNTIME_MODE=auto");
  }

  if (CHECK_ONLY) {
    log("");
    log(hardened ? "[result] all prerequisites present" : "[result] prerequisites missing - see fixes above (no changes were made)");
    if (missing.length > 0 && manager) {
      log(`[hint] to install them after reviewing the commands above, re-run with --apply --yes`);
    }
    process.exitCode = hardened ? 0 : 1;
    return;
  }

  // ---- apply mode (explicit opt-in: --apply --yes) ----
  if (!CONFIRMED) {
    log("");
    log("[refused] --apply requires --yes: this installs system packages as root.");
    process.exitCode = 2;
    return;
  }
  if (missing.length === 0) {
    log("");
    log("[result] nothing to install; package manager left untouched");
    process.exitCode = hardened ? 0 : 1;
    return;
  }
  if (!manager) {
    log("[error] no supported package manager found; cannot install automatically");
    log("[error] install manually: nodejs, npm, runc and a JRE 17+ (see the check output above)");
    process.exitCode = 1;
    return;
  }

  const pkgs = [...new Set(missing.flatMap((c) => manager.pkgs[c]))];
  const prefix = isRoot ? [] : run(["sudo", "--version"]) ? ["sudo"] : null;
  if (prefix === null) {
    log("[error] not root and no sudo available: re-run this script as root (or install sudo)");
    process.exitCode = 1;
    return;
  }

  const steps: string[][] = [];
  if (manager.refresh) steps.push(manager.refresh);
  steps.push(manager.install(pkgs));

  log("");
  for (const step of steps) {
    const argv = [...prefix, ...step];
    log(`[run] ${argv.join(" ")}`);
    const res = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
    if (res.status !== 0) {
      log(`[error] command failed with exit code ${res.status ?? "unknown"}: ${argv.join(" ")}`);
      process.exitCode = 1;
      return;
    }
  }

  log("");
  log("[result] packages installed; re-run without --apply to confirm (cgroup v2 is never auto-modified; the rootfs is only touched by the explicit --bootstrap-rootfs mode)");
  process.exitCode = 0;
}

main();
