import type { ChildProcess } from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CANONICAL_JAR_NAME } from "@mcm/contracts";
import type { ContainerMetrics, EngineProbe, JavaVersion, ResourceStatus, ServerRecord } from "@mcm/contracts";
import { MAX_UPLOAD_BYTES, serverRootAbs } from "./files.js";
import { buildContainerCommand } from "./script.js";

// Engine boundary: every runc/WSL2/docker interaction in this service must route
// through this module. It reports host capability honestly and never reports a
// successful container operation that did not actually happen.

export interface ContainerSpec {
  id: string;
  image: string;
  command: string[];
  memoryMb: number;
  cpuCores: number;
  gamePort: number;
  /** The server record whose scriptRun is tokenised into the container argv. */
  server: ServerRecord;
}

/** JVM directory prefix apk installs per Java major version (shared with java.ts). */
export const JVM_DIR_PREFIX: Record<JavaVersion, string> = {
  "8": "java-1.8-openjdk",
  "17": "java-17-openjdk",
  "21": "java-21-openjdk",
};

export interface Engine {
  probe(): EngineProbe;
  /**
   * Starts a container. Returns null when the host cannot run containers, so the
   * caller can surface an explicit "engine unavailable" error instead of a fake success.
   */
  runContainer(spec: ContainerSpec): ChildProcess | null;
  /** Reaps container state; returns false when there was nothing to tear down. */
  removeContainer(id: string): boolean;
}

const RUNC_BINARY = "runc";
const DOCKER_BINARY = "docker";
const WSL_BINARY = "wsl";
const DEFAULT_WSL_DISTRO = "MC-Manager-OS";
const DEFAULT_WSL_BUNDLE_DIR = "/var/lib/mcm/bundles";
const DEFAULT_WSL_RUNC_ROOT = "/var/lib/mcm/runc-state";
/** Native Linux executes runc directly on the host; Windows routes through the WSL bridge. */
const IS_WIN = process.platform === "win32";
/** cfs period in microseconds; one full core == quota/period. */
const CFS_PERIOD_US = 100000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const OCI_CAPS = [
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_FSETID",
  "CAP_KILL",
  "CAP_MKNOD",
  "CAP_NET_BIND_SERVICE",
  "CAP_NET_RAW",
  "CAP_SETFCAP",
  "CAP_SETGID",
  "CAP_SETPCAP",
  "CAP_SETUID",
  "CAP_SYS_CHROOT",
  "CAP_AUDIT_WRITE",
];

/** Raised when a runtime exists but this exact request cannot be honoured safely. */
export class EngineError extends Error {}

/**
 * Minimal PATH lookup; avoids shelling out to `which`/`where`.
 * WSL interop injects the Windows drive mounts (`/mnt/c/...`) into a distro PATH, which
 * would let Linux "find" a Windows-only `docker.exe` and silently pick a runtime it cannot
 * drive. Those entries are skipped off win32 so runtime selection stays honest (SRS 2.2).
 */
function findOnPath(binary: string): string | null {
  const onWin = process.platform === "win32";
  const exts = onWin ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    // Off Windows, `/mnt/<drive>/...` is always a Windows binary exposed through interop.
    if (!onWin && /^\/mnt\/[a-z]\//i.test(dir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function detectEngine(): { runc: string | null; docker: string | null } {
  return { runc: findOnPath(RUNC_BINARY), docker: findOnPath(DOCKER_BINARY) };
}

/**
 * Selected runtime family. `auto` prefers native docker+runc, then the WSL bridge.
 * `runc` is an explicit, strict request for the host-runc runtime and never falls back.
 */
function configuredMode(): "auto" | "native" | "wsl" | "runc" {
  const raw = (process.env.MCM_RUNTIME_MODE ?? "auto").trim().toLowerCase();
  return raw === "native" || raw === "wsl" || raw === "runc" ? raw : "auto";
}

export function wslDistro(): string {
  return process.env.MCM_WSL_DISTRO ?? DEFAULT_WSL_DISTRO;
}

interface WslProbe {
  ok: boolean;
  wslPath: string | null;
  distro: string;
  runcVersion: string | null;
  cgroup2: boolean;
  reason: string;
}

/**
 * Runs one command inside the WSL distro as root WITHOUT a shell, so no value is
 * ever concatenated into a command line - array args only.
 */
function wslExec(
  wslPath: string,
  args: string[],
  distro: string,
  opts: { input?: string } = {},
): ReturnType<typeof spawnSync> {
  // Native Linux has no wsl.exe bridge: the argv are already plain POSIX commands,
  // so run them directly on the host. Windows keeps the exact WSL path below.
  if (!IS_WIN) return spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 60000, input: opts.input });
  return spawnSync(wslPath, ["-d", distro, "-u", "root", "-e", ...args], {
    encoding: "utf8",
    timeout: 60000,
    input: opts.input,
  });
}

/**
 * Runs one array-argv command as root in the configured distro. Returns null when
 * wsl.exe is absent, so callers can report that honestly instead of throwing.
 */
export function wslRun(args: string[]): ReturnType<typeof spawnSync> | null {
  // On a Linux host there is no distro hop, so return a real result instead of null.
  if (!IS_WIN) return spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: 60000 });
  const wslPath = findOnPath(WSL_BINARY);
  if (!wslPath) return null;
  return wslExec(wslPath, args, wslDistro());
}

function firstLine(text: string | Buffer | null | undefined): string {
  return String(text ?? "").split("\n")[0]?.trim() ?? "";
}

/** Probes the real WSL distro: runc availability plus the cgroup v2 unified hierarchy. */
function probeWsl(): WslProbe {
  const distro = wslDistro();
  const wslPath = findOnPath(WSL_BINARY);
  if (!wslPath) {
    return { ok: false, wslPath: null, distro, runcVersion: null, cgroup2: false, reason: "wsl.exe not found on PATH" };
  }
  const runc = wslExec(wslPath, ["runc", "--version"], distro);
  if (runc.status !== 0) {
    const detail = String(runc.stderr || runc.error || "no such distro or runc not installed").trim();
    return {
      ok: false,
      wslPath,
      distro,
      runcVersion: null,
      cgroup2: false,
      reason: `runc unavailable inside WSL distro ${distro}: ${detail}`,
    };
  }
  const runcVersion = firstLine(runc.stdout) || "unknown";
  const cg = wslExec(wslPath, ["cat", "/sys/fs/cgroup/cgroup.controllers"], distro);
  const cgroup2 = cg.status === 0 && Boolean(String(cg.stdout ?? "").trim());
  if (!cgroup2) {
    return {
      ok: false,
      wslPath,
      distro,
      runcVersion,
      cgroup2: false,
      reason: `cgroup v2 unified hierarchy not available in ${distro}; runc resource limits need it`,
    };
  }
  // runc has no image store: without a prepared rootfs template there is nothing
  // honest to run, so the probe must not advertise `available`.
  const rawRootfs = process.env.MCM_WSL_ROOTFS ?? "";
  if (!rawRootfs) {
    return {
      ok: false,
      wslPath,
      distro,
      runcVersion,
      cgroup2: true,
      reason: `WSL distro ${distro} has ${runcVersion} (cgroup v2) but MCM_WSL_ROOTFS is unset; runc has no image store, so lifecycle stays refused`,
    };
  }
  const template = toWslPath(rawRootfs);
  if (template.startsWith("/mnt/")) {
    return {
      ok: false,
      wslPath,
      distro,
      runcVersion,
      cgroup2: true,
      reason: `MCM_WSL_ROOTFS (${template}) is on a Windows drive mount; runc needs the distro's own POSIX filesystem`,
    };
  }
  const rootfsCheck = wslExec(wslPath, ["test", "-d", template], distro);
  if (rootfsCheck.status !== 0) {
    return {
      ok: false,
      wslPath,
      distro,
      runcVersion,
      cgroup2: true,
      reason: `MCM_WSL_ROOTFS (${template}) is not a directory inside ${distro}; prepare a rootfs template first`,
    };
  }
  return {
    ok: true,
    wslPath,
    distro,
    runcVersion,
    cgroup2: true,
    reason: `${runcVersion} in WSL distro ${distro} (cgroup v2, rootfs ready)`,
  };
}

/**
 * Native Linux ladder (SRS 2.2): runc runs on the host, so there is no distro to
 * probe. It mirrors probeWsl's honesty checks (runc + cgroup v2 + prepared rootfs)
 * and reuses MCM_WSL_ROOTFS/BUNDLE_DIR/RUNC_ROOT - the operator provides the rootfs,
 * because runc has no image store and this service never downloads one.
 */
function probeLinux(): EngineProbe {
  const runc = findOnPath(RUNC_BINARY);
  if (!runc) {
    return {
      available: false,
      installed: false,
      runtimePath: null,
      mode: "none",
      reason: "no runc on PATH: install runc and provide a prepared rootfs (MCM_WSL_ROOTFS) to enable lifecycle",
    };
  }
  const version = spawnSync(runc, ["--version"], { encoding: "utf8", timeout: 60000 });
  if (version.status !== 0) {
    const detail = firstLine(version.stderr) || `exit ${version.status}`;
    return { available: false, installed: true, runtimePath: runc, mode: "none", reason: `runc at ${runc} is not usable: ${detail}` };
  }
  const runcVersion = firstLine(version.stdout) || "unknown";
  let cgroup2 = false;
  try {
    cgroup2 = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim().length > 0;
  } catch {
    cgroup2 = false;
  }
  if (!cgroup2) {
    return {
      available: false,
      installed: true,
      runtimePath: runc,
      mode: "none",
      runcVersion,
      reason: "cgroup v2 unified hierarchy is not available on the host; runc resource limits need it",
    };
  }
  const rawRootfs = process.env.MCM_WSL_ROOTFS ?? "";
  if (!rawRootfs) {
    return {
      available: false,
      installed: true,
      runtimePath: runc,
      mode: "none",
      runcVersion,
      reason: `${runcVersion} on host (cgroup v2) but MCM_WSL_ROOTFS is unset; runc has no image store, so lifecycle stays refused`,
    };
  }
  const template = toWslPath(rawRootfs);
  if (!existsSync(template)) {
    return {
      available: false,
      installed: true,
      runtimePath: runc,
      mode: "none",
      runcVersion,
      reason: `MCM_WSL_ROOTFS (${template}) is not a directory on this host; prepare a rootfs template first`,
    };
  }
  return {
    available: true,
    installed: true,
    runtimePath: runc,
    mode: "runc",
    runcVersion,
    reason: `${runcVersion} on Linux host (cgroup v2, rootfs ready)`,
  };
}

/**
 * Converts a Windows path to the POSIX path the distro sees.
 * - UNC `\\wsl.localhost\<distro>\x` (or the `\\wsl$\<distro>\x` form) is the distro's OWN
 *   filesystem, so it maps to `/x` - never `/mnt/...` (which runc rejects).
 * - A drive path `C:\a\b` maps to the Windows-drive mount `/mnt/c/a/b`.
 * - POSIX input passes through unchanged.
 */
export function toWslPath(input: string): string {
  const unc = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/.exec(input);
  if (unc) return `/${unc[1].replace(/\\/g, "/")}`;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(input);
  if (!match) return input;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

/** Native docker+runc ladder, kept verbatim so Windows/Linux behaviour is preserved. */
function probeNative(): EngineProbe {
  const { runc, docker } = detectEngine();
  if (!runc && !docker) {
    return {
      available: false,
      installed: false,
      runtimePath: null,
      mode: "none",
      reason:
        "no runc/docker container runtime on PATH: install a WSL2 distro plus runc (Linux mode) or Docker Desktop exposing runc (Windows mode); server lifecycle stays disabled until then",
    };
  }
  if (!runc) {
    return {
      available: false,
      installed: true,
      runtimePath: docker,
      mode: "none",
      reason: `docker found at ${docker} but runc is missing; enable runc (WSL2 distro or Docker Desktop engine) - refusing to guess a working container path`,
    };
  }
  if (!docker) {
    return {
      available: false,
      installed: true,
      runtimePath: runc,
      mode: "none",
      reason: `runc found at ${runc} but no docker CLI to drive it; lifecycle disabled`,
    };
  }
  return { available: true, installed: true, runtimePath: docker, mode: "native", reason: `docker at ${docker}` };
}

export function probeEngine(): EngineProbe {
  const mode = configuredMode();
  const native = detectEngine();
  const nativeOk = Boolean(native.runc && native.docker);
  if (mode === "native") return probeNative();
  if (mode === "runc") {
    // Strict request: host runc only, never a silent docker or WSL fallback.
    if (IS_WIN) {
      return {
        available: false,
        installed: false,
        runtimePath: null,
        mode: "none",
        reason: "MCM_RUNTIME_MODE=runc requested but host runc mode is Linux-only",
      };
    }
    return probeLinux();
  }
  // `auto`: a real docker+runc pair on PATH (Windows interop mounts are already
  // filtered out of findOnPath) may drive native mode; otherwise fall through.
  if (nativeOk) return probeNative();

  if (!IS_WIN) {
    // Linux: docker native mode above already covers docker+runc. Without docker the
    // host runc ladder applies; the WSL bridge is meaningless here and is refused.
    if (mode === "wsl") {
      return { available: false, installed: false, runtimePath: null, mode: "none", reason: "MCM_RUNTIME_MODE=wsl requested but WSL mode is Windows-only" };
    }
    return probeLinux();
  }

  // Native docker+runc is unavailable (or explicitly disabled): try the explicit WSL bridge.
  const wsl = probeWsl();
  if (wsl.ok) {
    return {
      available: true,
      installed: true,
      runtimePath: wsl.wslPath,
      mode: "wsl",
      distro: wsl.distro,
      runcVersion: wsl.runcVersion,
      reason: `${wsl.reason}; docker not used`,
    };
  }
  if (mode === "wsl") {
    return {
      available: false,
      installed: false,
      runtimePath: wsl.wslPath,
      mode: "none",
      distro: wsl.distro,
      runcVersion: null,
      reason: `MCM_RUNTIME_MODE=wsl requested but the bridge is unusable: ${wsl.reason}`,
    };
  }
  if (native.docker || native.runc) {
    const base = probeNative();
    return { ...base, distro: wsl.distro, reason: `${base.reason}; WSL fallback unusable: ${wsl.reason}` };
  }
  return {
    available: false,
    installed: false,
    runtimePath: wsl.wslPath,
    mode: "none",
    distro: wsl.distro,
    runcVersion: null,
    reason: `no usable container runtime: ${wsl.reason}`,
  };
}

function assertId(id: string): void {
  if (!ID_RE.test(id)) throw new EngineError(`invalid server id: ${JSON.stringify(id)}`);
}

function assertResources(memoryMb: number, cpuCores: number, gamePort: number): void {
  if (!Number.isInteger(memoryMb) || memoryMb < 64 || memoryMb > 65536) {
    throw new EngineError(`invalid memoryMb: ${String(memoryMb)}`);
  }
  if (!Number.isInteger(cpuCores) || cpuCores < 1 || cpuCores > 64) {
    throw new EngineError(`invalid cpuCores: ${String(cpuCores)}`);
  }
  if (!Number.isInteger(gamePort) || gamePort < 1 || gamePort > 65535) {
    throw new EngineError(`invalid gamePort: ${String(gamePort)}`);
  }
}

/** Rejects runtime paths that resolve onto a Windows drive mount, which runc cannot use. */
function insideDistroPath(name: string, value: string): string {
  if (!value.startsWith("/")) {
    throw new EngineError(`${name} must be an absolute Linux path: ${JSON.stringify(value)}`);
  }
  if (value.startsWith("/mnt/")) {
    throw new EngineError(
      `${name} (${value}) is on a Windows drive mount; runc needs the distro's own POSIX filesystem (use e.g. /var/lib/mcm/...)`,
    );
  }
  return value;
}

/**
 * Minimal OCI runtime spec for a runc bundle. The network namespace is deliberately
 * OMITTED so the container shares the WSL network stack and a bound game port stays
 * reachable from Windows (runc alone cannot publish ports).
 */
export function ociConfig(spec: ContainerSpec): string {
  // Java mode = a jar AND a JRE were both selected. Only then do we bind the JRE
  // into the container view and run from /data; otherwise the container is the
  // same plain busybox shell it always was.
  const record = spec.server;
  const isBedrock = record.serverType === "bedrock";
  const javaMode = Boolean(record.jarFile) && !isBedrock;
  const defaultCommand = isBedrock ? ["./bedrock_server"] : ["/bin/sh"];
  const args = spec.command.length > 0 ? spec.command : defaultCommand;
  // Heavy-modpack optimization: when enabled (default; only an explicit false opts out)
  // the container's RLIMIT_NOFILE is raised to 65535 hard/soft so large modpacks are not
  // starved of open file handles. Disabled falls back to the historic 1024 hard/soft.
  const nofileLimit = record.optimizeHeavyModpack === false ? 1024 : 65535;
  const env = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=xterm"];
  if (isBedrock) {
    env.push("LD_LIBRARY_PATH=.");
  }
  return JSON.stringify({
    ociVersion: "1.0.2",
    process: {
      terminal: false,
      user: { uid: 0, gid: 0 },
      args,
      env,
      cwd: javaMode || isBedrock ? "/data" : "/",
      capabilities: {
        bounding: OCI_CAPS,
        effective: OCI_CAPS,
        inheritable: OCI_CAPS,
        permitted: OCI_CAPS,
        ambient: OCI_CAPS,
      },
      rlimits: [{ type: "RLIMIT_NOFILE", hard: nofileLimit, soft: nofileLimit }],
    },
    root: { path: "rootfs", readonly: false },
    hostname: spec.id,
    mounts: [
      { destination: "/proc", type: "proc", source: "proc" },
      {
        destination: "/dev",
        type: "tmpfs",
        source: "tmpfs",
        options: ["nosuid", "strictatime", "mode=755", "size=65536k"],
      },
      {
        destination: "/dev/pts",
        type: "devpts",
        source: "devpts",
        options: ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"],
      },
      {
        destination: "/dev/shm",
        type: "tmpfs",
        source: "shm",
        options: ["nosuid", "noexec", "nodev", "mode=1777", "size=65536k"],
      },
      { destination: "/sys", type: "sysfs", source: "sysfs", options: ["nosuid", "noexec", "nodev", "ro"] },
      // Java mode: the JRE lives in the distro (musl apk package), so it is
      // bound in read-only alongside its shared libs. /data is the server's whole
      // canonical directory (/server/<id> inside the distro), bound directly.
      ...(javaMode
        ? [
            // The rootfs /etc is empty, so DNS must be supplied or the game jar
            // download hangs on unresolvable hostnames. Inside WSL that is the WSL
            // resolv.conf; on a native Linux host it is the host's own file.
            {
              destination: "/etc/resolv.conf",
              type: "bind",
              source: IS_WIN ? "/mnt/wsl/resolv.conf" : "/etc/resolv.conf",
              options: ["rbind", "nosuid", "nodev"],
            },
            // The JRE's lib/security/cacerts symlinks into /etc/ssl/certs/java;
            // without it every HTTPS download fails with an empty trust store.
            {
              destination: "/etc/ssl/certs/java",
              type: "bind",
              source: "/etc/ssl/certs/java",
              options: ["rbind", "nosuid", "nodev"],
            },
            // The server's ONE live filesystem. Source is the canonical distro dir
            // (/server/<id>), derived from the canonical DATA_ROOT, never /mnt/*.
            {
              destination: "/data",
              type: "bind",
              source: toWslPath(serverRootAbs(record)),
              options: ["rbind", "nosuid", "nodev"],
            },
            { destination: "/usr/lib/jvm", type: "bind", source: "/usr/lib/jvm", options: ["rbind", "nosuid", "nodev"] },
            { destination: "/usr/lib", type: "bind", source: "/usr/lib", options: ["rbind", "nosuid", "nodev"] },
            { destination: "/lib", type: "bind", source: "/lib", options: ["rbind", "nosuid", "nodev"] },
          ]
        : isBedrock
        ? [
            {
              destination: "/etc/resolv.conf",
              type: "bind",
              source: IS_WIN ? "/mnt/wsl/resolv.conf" : "/etc/resolv.conf",
              options: ["rbind", "nosuid", "nodev"],
            },
            {
              destination: "/data",
              type: "bind",
              source: toWslPath(serverRootAbs(record)),
              options: ["rbind", "nosuid", "nodev"],
            },
          ]
        : []),
    ],
    linux: {
      namespaces: ["pid", "ipc", "uts", "mount", "cgroup"].map((type) => ({ type })),
      resources: {
        memory: { limit: spec.memoryMb * 1024 * 1024 },
        cpu: { quota: spec.cpuCores * CFS_PERIOD_US, period: CFS_PERIOD_US },
      },
    },
  });
}

/**
 * Materialises a runc bundle (rootfs + config.json) inside the distro, as root.
 * The rootfs is copied from MCM_WSL_ROOTFS once; later starts reuse the populated
 * bundle. runc has no image store, so a missing template is an explicit refusal.
 */
function prepareWslBundle(spec: ContainerSpec, wslPath: string, distro: string): string {
  const bundleRoot = insideDistroPath(
    "MCM_WSL_BUNDLE_DIR",
    process.env.MCM_WSL_BUNDLE_DIR ?? DEFAULT_WSL_BUNDLE_DIR,
  );
  const rawRootfs = process.env.MCM_WSL_ROOTFS ?? "";
  if (!rawRootfs) {
    throw new EngineError(
      "no rootfs configured: set MCM_WSL_ROOTFS to a prepared Alpine/OCI rootfs directory inside the distro (runc has no image store) - lifecycle stays refused",
    );
  }
  const record = spec.server;
  const isBedrock = record.serverType === "bedrock";
  const bedrockTemplate = "/var/lib/mcm/rootfs-bedrock";
  let template = insideDistroPath("MCM_WSL_ROOTFS", toWslPath(rawRootfs));
  if (isBedrock) {
    const checkBedrock = wslExec(wslPath, ["test", "-d", bedrockTemplate], distro);
    if (checkBedrock.status === 0) {
      template = bedrockTemplate;
    }
  }

  const bundleDir = `${bundleRoot}/${spec.id}`;
  const rootfsAbs = `${bundleDir}/rootfs`;
  const dataDirAbs = toWslPath(serverRootAbs(record));
  const jarAbs = path.join(serverRootAbs(record), record.jarFile ?? CANONICAL_JAR_NAME);

  // The canonical server dir is the bind source for /data, so it must exist before
  // runc mounts it (runc refuses a missing bind source). Created here, not staged.
  const mkData = wslExec(wslPath, ["mkdir", "-p", dataDirAbs], distro);
  if (mkData.status !== 0) throw new EngineError(`cannot create canonical server dir ${dataDirAbs}: ${firstLine(mkData.stderr)}`);
  const mk = wslExec(wslPath, ["mkdir", "-p", rootfsAbs], distro);
  if (mk.status !== 0) throw new EngineError(`cannot create bundle dir ${bundleDir}: ${firstLine(mk.stderr)}`);
  const populated = wslExec(wslPath, ["test", "-e", `${rootfsAbs}/bin`], distro);
  if (populated.status !== 0) {
    const cp = wslExec(wslPath, ["cp", "-a", `${template}/.`, `${rootfsAbs}/`], distro);
    if (cp.status !== 0) throw new EngineError(`cannot populate rootfs from ${template}: ${firstLine(cp.stderr)}`);
  }

  if (isBedrock) {
    // Bedrock binds /data; ensure destination exists
    const mkBinds = wslExec(wslPath, ["mkdir", "-p", `${rootfsAbs}/data`], distro);
    if (mkBinds.status !== 0) {
      throw new EngineError(`cannot create bind destinations in ${rootfsAbs}: ${firstLine(mkBinds.stderr)}`);
    }
    // Make sure bedrock_server is marked executable if present
    wslExec(wslPath, ["chmod", "+x", `${dataDirAbs}/bedrock_server`], distro);
  } else if (record.jarFile) {
    // runc binds the distro JRE and /data into the container view; those mount
    // destinations must exist in the bundle rootfs before runc starts.
    const mkBinds = wslExec(wslPath, ["mkdir", "-p", `${rootfsAbs}/usr`, `${rootfsAbs}/usr/lib`, `${rootfsAbs}/usr/lib/jvm`, `${rootfsAbs}/data`, `${rootfsAbs}/etc/ssl/certs/java`], distro);
    if (mkBinds.status !== 0) {
      throw new EngineError(`cannot create bind destinations in ${rootfsAbs}: ${firstLine(mkBinds.stderr)}`);
    }
    // Fail fast if the requested JRE is not actually present in the distro view,
    // rather than launching a container that dies with "java: not found".
    const jre = wslExec(
      wslPath,
      ["/bin/sh", "-c", 'ls -d $1 2>/dev/null | head -n1', "mcm", `/usr/lib/jvm/${JVM_DIR_PREFIX[record.javaVersion]}*/bin/java`],
      distro,
    );
    if (jre.status !== 0 || !firstLine(jre.stdout)) {
      throw new EngineError(
        `java_not_installed: no JRE for java ${record.javaVersion} in the distro; provision it with POST /api/java before starting`,
      );
    }
    // The JVM directory name differs per distro (Alpine `java-17-openjdk` vs Debian
    // `java-17-openjdk-amd64`), so trust the glob that just resolved over the
    // JVM_DIR_PREFIX literal in the launch argv. No-op on the verified Windows path.
    const resolvedJava = firstLine(jre.stdout);
    if (resolvedJava && spec.command[0]?.startsWith("/usr/lib/jvm/") && spec.command[0].endsWith("/java")) {
      spec.command[0] = resolvedJava;
    }
    // ociConfig binds the whole canonical dir (/server/<id>) as /data, so the launch
    // jar is just a file inside it. It is only stat'd here: a missing or implausible
    // file is refused before runc starts rather than launching a container that dies
    // with a class-not-found error.
    const src = toWslPath(jarAbs);
    const stat = wslExec(wslPath, ["stat", "-c", "%s", src], distro);
    const size = Number.parseInt(firstLine(stat.stdout), 10);
    if (stat.status !== 0 || !Number.isFinite(size) || size < 1024 || size > MAX_UPLOAD_BYTES) {
      throw new EngineError(
        `server_jar_unavailable: ${jarAbs} is missing or out of range (${firstLine(stat.stderr) || String(size)})`,
      );
    }
  }
  const write = wslExec(wslPath, ["/bin/sh", "-c", 'cat > "$1"', "mcm", `${bundleDir}/config.json`], distro, {
    input: ociConfig(spec),
  });
  if (write.status !== 0) throw new EngineError(`cannot write config.json for ${spec.id}: ${firstLine(write.stderr)}`);
  return bundleDir;
}

function runContainerDocker(spec: ContainerSpec): ChildProcess {
  const image = process.env.MCM_SERVER_IMAGE ?? "itzg/minecraft-server";
  return spawn(
    DOCKER_BINARY,
    [
      "run",
      "--rm",
      "-i",
      "--name",
      spec.id,
      "-p",
      `${spec.gamePort}:25565`,
      "--memory",
      `${spec.memoryMb}m`,
      "--cpus",
      String(spec.cpuCores),
      image,
      ...spec.command,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
}

function runContainerWsl(spec: ContainerSpec, probe: EngineProbe): ChildProcess {
  assertId(spec.id);
  assertResources(spec.memoryMb, spec.cpuCores, spec.gamePort);
  const wslPath = probe.runtimePath ?? findOnPath(WSL_BINARY);
  if (IS_WIN && !wslPath) throw new EngineError("wsl.exe disappeared between probe and run");
  const distro = probe.distro ?? wslDistro();
  const bundleDir = prepareWslBundle(spec, wslPath ?? RUNC_BINARY, distro);
  const stateRoot = insideDistroPath(
    "MCM_WSL_RUNC_ROOT",
    process.env.MCM_WSL_RUNC_ROOT ?? DEFAULT_WSL_RUNC_ROOT,
  );
  wslExec(wslPath ?? RUNC_BINARY, ["mkdir", "-p", stateRoot], distro);
  // Ensure any previous or zombie container with the same ID is reaped before running
  wslExec(wslPath ?? RUNC_BINARY, ["runc", "--root", stateRoot, "kill", spec.id, "KILL"], distro);
  wslExec(wslPath ?? RUNC_BINARY, ["runc", "--root", stateRoot, "delete", "--force", spec.id], distro);
  const argv = ["--root", stateRoot, "run", "-b", bundleDir, spec.id];
  // Windows: hop into the distro via wsl.exe. Native Linux: runc is the process itself.
  return probe.mode === "runc"
    ? spawn(probe.runtimePath ?? RUNC_BINARY, argv, { stdio: ["pipe", "pipe", "pipe"] })
    : spawn(wslPath as string, ["-d", distro, "-u", "root", "-e", "runc", ...argv], { stdio: ["pipe", "pipe", "pipe"] });
}

function runContainer(spec: ContainerSpec): ChildProcess | null {
  const probe = probeEngine();
  if (!probe.available) {
    console.warn(`[engine] refusing to start server ${spec.id}: ${probe.reason}`);
    return null;
  }
  // `wsl` and `runc` share the runc bundle lifecycle; native docker is separate.
  if (probe.mode === "wsl" || probe.mode === "runc") return runContainerWsl(spec, probe);
  return runContainerDocker(spec);
}

/** Reaps runc container state (in the distro or on the host); stops native docker containers. */
export function removeContainer(id: string): boolean {
  const probe = probeEngine();
  if (!ID_RE.test(id)) return false;
  // Native docker runs with a client-side CLI: killing the CLI leaves the container
  // alive, so stop it by name here (single choke point for stop/restart/force-kill).
  if (probe.mode === "native") {
    return spawnSync(DOCKER_BINARY, ["stop", "-t", "10", id], { encoding: "utf8", timeout: 60000 }).status === 0;
  }
  if (probe.mode !== "wsl" && probe.mode !== "runc") return false;
  const wslPath = probe.runtimePath ?? findOnPath(WSL_BINARY) ?? RUNC_BINARY;
  if (IS_WIN && !findOnPath(WSL_BINARY)) return false;
  const stateRoot = insideDistroPath(
    "MCM_WSL_RUNC_ROOT",
    process.env.MCM_WSL_RUNC_ROOT ?? DEFAULT_WSL_RUNC_ROOT,
  );
  const distro = probe.distro ?? wslDistro();
  wslExec(wslPath, ["runc", "--root", stateRoot, "kill", id, "KILL"], distro);
  const res = wslExec(wslPath, ["runc", "--root", stateRoot, "delete", "--force", id], distro);
  if (res.status !== 0 && !String(res.stderr).toLowerCase().includes("does not exist")) {
    console.warn(`[engine] runc delete ${id} failed: ${firstLine(res.stderr)}`);
  }
  return res.status === 0;
}

/** Converts docker's human size suffix (e.g. "123.4MiB") to whole MiB. */
function parseMemoryToMb(value: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)?$/i.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "B").toUpperCase().replace("IB", "B");
  const factor: Record<string, number> = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 };
  return Math.round(amount * (factor[unit] ?? 1) * 100) / 100;
}

/**
 * Samples a running container via `docker stats --no-stream`. When no runtime or
 * no container is present it returns the declared limits with source "declared"
 * and a reason - never a fabricated usage number.
 */
export function containerMetrics(serverId: string, memoryLimitMb: number, cpuCores: number): ContainerMetrics {
  const base = { serverId, memoryLimitMb, cpuCores };
  const probe = probeEngine();
  if (!probe.available) {
    return { ...base, running: false, source: "declared", cpuPercent: null, memoryMb: null, reason: probe.reason };
  }
  if (probe.mode !== "native") {
    // WSL runc mode has no `docker stats` source; report limits without inventing usage.
    return {
      ...base,
      running: false,
      source: "declared",
      cpuPercent: null,
      memoryMb: null,
      reason: `${probe.reason}; live metrics need the docker native runtime (no docker stats source in runc mode)`,
    };
  }
  const out = spawnSync(DOCKER_BINARY, ["stats", "--no-stream", "--format", "{{json .}}", serverId], {
    encoding: "utf8",
  });
  if (out.status !== 0) {
    return {
      ...base,
      running: false,
      source: "declared",
      cpuPercent: null,
      memoryMb: null,
      reason: (out.stderr || "container not running").toString().trim(),
    };
  }
  try {
    const line = out.stdout.trim().split("\n").pop() ?? "{}";
    const parsed = JSON.parse(line) as { CPUPerc?: string; MemUsage?: string };
    const memoryUsage = (parsed.MemUsage ?? "").split("/")[0] ?? "";
    const rawCpu = Number.parseFloat((parsed.CPUPerc ?? "").replace("%", "")) || 0;
    const cores = Math.max(1, cpuCores || 1);
    const cpuPercent = Math.min(100, Math.round((rawCpu / cores) * 100) / 100);
    return {
      ...base,
      running: true,
      source: "docker-stats",
      cpuPercent,
      cpuRawPercent: rawCpu,
      memoryMb: parseMemoryToMb(memoryUsage),
    };
  } catch (err) {
    return { ...base, running: true, source: "declared", cpuPercent: null, memoryMb: null, reason: `unparsable stats: ${String(err)}` };
  }
}

/** Promisified `execFile` that never rejects: returns a zero/non-zero exit code. */
function execFileAsync(file: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const errCode = (err as NodeJS.ErrnoException | null)?.code;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err ? (typeof errCode === "number" ? errCode : 1) : 0 });
    });
  });
}

/** Linux USER_HZ: /proc stat utime/stime are expressed in 1/100 s ticks. */
const PROC_CLOCK_TICKS = 100;
/** Previous (ticks, timestamp) per serverId, for the CPU delta between samples. */
const wslCpuState = new Map<string, { ticks: number; at: number }>();

/**
 * Samples a WSL runc container from the kernel: `runc state <id>` yields the
 * container pid, then `/proc/<pid>/stat` and `/proc/<pid>/status` give CPU ticks
 * and RSS. Every value comes from the kernel; nothing is fabricated, and the id
 * is gated by ID_RE with array args only (no shell, no interpolation).
 */
async function sampleWslMetrics(serverId: string, memoryLimitMb: number, cpuCores: number): Promise<ContainerMetrics> {
  const base = { serverId, memoryLimitMb, cpuCores };
  const declared = (reason: string): ContainerMetrics => ({
    ...base,
    running: false,
    source: "declared",
    cpuPercent: null,
    memoryMb: null,
    reason,
  });
  if (!ID_RE.test(serverId)) return declared(`invalid container id: ${serverId}`);
  const wslPath = IS_WIN ? findOnPath(WSL_BINARY) : null;
  if (IS_WIN && !wslPath) return declared("wsl.exe not found on PATH");
  const distro = wslDistro();
  const stateRoot = process.env.MCM_WSL_RUNC_ROOT ?? DEFAULT_WSL_RUNC_ROOT;
  const runcPath = findOnPath(RUNC_BINARY) ?? RUNC_BINARY;
  // Windows hops into the distro, where wsl.exe `-e` needs the binary token (args[0])
  // repeated in the argv. Native Linux spawns the binary itself, so args[0] IS the
  // program name already passed to execFileAsync and must not be repeated.
  const file = IS_WIN ? (wslPath as string) : runcPath;
  const wrap = (args: string[]): string[] => (IS_WIN ? ["-d", distro, "-u", "root", "-e", ...args] : args.slice(1));

  const state = await execFileAsync(file, wrap([RUNC_BINARY, "--root", stateRoot, "state", serverId]));
  if (state.code !== 0) return declared(state.stderr.trim() || "container not running");

  let pid = 0;
  try {
    pid = Number((JSON.parse(state.stdout) as { pid?: number }).pid) || 0;
  } catch (err) {
    return declared(`unparsable runc state: ${String(err)}`);
  }
  if (pid <= 0) return declared("runc state has no live pid");

  // Native Linux reads the host procfs directly; Windows goes through the distro.
  const proc = await execFileAsync(IS_WIN ? (wslPath as string) : "cat", wrap(["cat", `/proc/${pid}/stat`, `/proc/${pid}/status`]));
  if (proc.code !== 0) return declared(proc.stderr.trim() || "cannot read container /proc");

  const now = Date.now();
  // /proc/<pid>/stat field 2 (comm) may contain spaces/parens, so slice after the last ")".
  const statLine = proc.stdout.split("\n").find((line) => line.includes(")")) ?? "";
  const fields = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return declared("cannot parse /proc stat");

  const rssMatch = /^VmRSS:\s+(\d+)\s+kB/m.exec(proc.stdout);
  const memoryMb = rssMatch ? Math.round((Number(rssMatch[1]) / 1024) * 100) / 100 : null;

  const ticks = utime + stime;
  const prev = wslCpuState.get(serverId);
  wslCpuState.set(serverId, { ticks, at: now });
  let cpuPercent: number | null = null;
  let cpuRawPercent: number | null = null;
  if (prev && now > prev.at) {
    const raw = ((ticks - prev.ticks) / PROC_CLOCK_TICKS / ((now - prev.at) / 1000)) * 100;
    cpuRawPercent = raw > 0 ? Math.round(raw * 100) / 100 : 0;
    const cores = Math.max(1, cpuCores || 1);
    cpuPercent = raw > 0 ? Math.min(100, Math.round((raw / cores) * 100) / 100) : 0;
  }

  return { ...base, running: true, source: "procfs", cpuPercent, cpuRawPercent, memoryMb, sampledAt: new Date(now).toISOString() };
}

const LIVE_TTL_MS = 2000;
const liveCache = new Map<string, { at: number; value: ContainerMetrics }>();
const liveInflight = new Map<string, Promise<ContainerMetrics>>();

/**
 * Live container metrics with a 2s TTL and single-flight. Native keeps the
 * existing synchronous `docker stats` path; WSL runc samples the kernel procfs.
 * Concurrent pollers share one in-flight sample so hot polling never spawns
 * blocking processes.
 */
export async function containerMetricsLive(
  serverId: string,
  memoryLimitMb: number,
  cpuCores: number,
): Promise<ContainerMetrics> {
  const probe = probeEngine();
  if (!probe.available || probe.mode === "native") {
    return containerMetrics(serverId, memoryLimitMb, cpuCores);
  }
  const cached = liveCache.get(serverId);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.value;
  const inflight = liveInflight.get(serverId);
  if (inflight) return inflight;

  const run = sampleWslMetrics(serverId, memoryLimitMb, cpuCores);
  liveInflight.set(serverId, run);
  try {
    const value = await run;
    liveCache.set(serverId, { at: Date.now(), value });
    return value;
  } finally {
    liveInflight.delete(serverId);
  }
}

export const engine: Engine = { probe: probeEngine, runContainer, removeContainer };

export function resourceStatus(): ResourceStatus {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpuCount: os.cpus().length,
    loadAvg1m: Math.round(os.loadavg()[0] * 100) / 100,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    uptimeSeconds: Math.round(os.uptime()),
  };
}
