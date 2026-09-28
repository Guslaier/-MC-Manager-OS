import { spawnSync } from "node:child_process";
import type { JavaInstallReport, JavaVersion } from "@mcm/contracts";
import { JAVA_VERSIONS } from "@mcm/contracts";
import { JVM_DIR_PREFIX, wslRun } from "./engine.js";

const IS_WIN = process.platform === "win32";

// Java boundary (REQ-4.2). Only the Alpine repos are trusted: the JRE is pulled
// with apk inside the WSL distro, so it is always the musl build. A portable or
// glibc JDK tarball is never fetched - there is deliberately no code path for it.

/** Alpine package per Java major version (names verified against the distro repos). */
export const JAVA_PACKAGES: Record<JavaVersion, string> = {
  "8": "openjdk8-jre",
  "17": "openjdk17-jre",
  "21": "openjdk21-jre",
};

/** Constant shell fragment (no interpolation) that prints the first JVM java path. */
const JAVA_PROBE = "ls -d /usr/lib/jvm/*/bin/java 2>/dev/null | head -n1";

/** Host package-manager hints per Java major (examples only; names vary by distro). */
const LINUX_JAVA_HINT: Record<JavaVersion, string> = {
  "8": "openjdk-8-jre-headless / java-1.8.0-openjdk-headless",
  "17": "openjdk-17-jre-headless / java-17-openjdk-headless",
  "21": "openjdk-21-jre-headless / java-21-openjdk-headless",
};

export function isJavaVersion(value: unknown): value is JavaVersion {
  return typeof value === "string" && (JAVA_VERSIONS as string[]).includes(value);
}

function firstLine(text: string | Buffer | null | undefined): string {
  return String(text ?? "").split("\n")[0]?.trim() ?? "";
}

/**
 * Reports the real install state for one version. `installed` is only true when
 * `apk info -e` confirms the package AND `java -version` actually printed something.
 */
export function javaState(version: JavaVersion): JavaInstallReport {
  const packageName = JAVA_PACKAGES[version];
  const base = { version, packageName, installed: false, versionOutput: null };
  if (!IS_WIN) return javaStateHost(version, base);
  const has = wslRun(["/sbin/apk", "info", "-e", packageName]);
  if (!has) return { ...base, reason: "wsl.exe not found on PATH: cannot inspect the Alpine distro" };
  if (has.status !== 0) {
    return { ...base, reason: `${packageName} is not installed in the distro (run POST /api/java to provision it)` };
  }
  const probe = wslRun(["/bin/sh", "-c", JAVA_PROBE]);
  const found = firstLine(probe?.stdout);
  if (!found) {
    return { ...base, reason: `${packageName} installed but no java binary under /usr/lib/jvm` };
  }
  const run = wslRun(["/bin/sh", "-c", `"${found}" -version 2>&1 | head -n1`]);
  const versionOutput = firstLine(run?.stdout);
  return {
    version,
    packageName,
    installed: true,
    versionOutput: versionOutput || null,
    reason: versionOutput ? `${packageName} present; ${versionOutput}` : `${packageName} present; java -version produced no output`,
  };
}

/**
 * Native Linux probe: on a host the JRE comes from the package manager, not the
 * Alpine apk repos, so it is reported installed only when the requested major's own
 * directory (java-<major>-openjdk*, which also matches Debian's -amd64 suffix) exists.
 */
function javaStateHost(version: JavaVersion, base: Omit<JavaInstallReport, "reason">): JavaInstallReport {
  const glob = `/usr/lib/jvm/${JVM_DIR_PREFIX[version]}*`;
  const probe = spawnSync("/bin/sh", ["-c", `ls -d ${glob}/bin/java 2>/dev/null | head -n1`], {
    encoding: "utf8",
    timeout: 60000,
  });
  const found = firstLine(probe.stdout);
  if (!found) {
    return {
      ...base,
      reason: `no JRE matching ${glob} on this host; install one with your package manager (e.g. apt-get install ${LINUX_JAVA_HINT[version]}) then re-check`,
    };
  }
  const run = spawnSync(found, ["-version"], { encoding: "utf8", timeout: 60000 });
  const versionOutput = firstLine(`${run.stderr ?? ""}${run.stdout ?? ""}`);
  return {
    ...base,
    installed: true,
    versionOutput: versionOutput || null,
    reason: versionOutput ? `${versionOutput} at ${found}` : `JRE present at ${found}; java -version produced no output`,
  };
}

export function javaStates(): JavaInstallReport[] {
  return JAVA_VERSIONS.map((version) => javaState(version));
}

/**
 * Installs one JRE with `apk add --no-cache`, then re-inspects. apk is invoked by
 * absolute path with an argv array (no shell, no PATH dependency - `wsl -e apk`
 * is known to fail because /sbin is not on the execve PATH).
 */
export function installJava(version: JavaVersion): JavaInstallReport {
  const packageName = JAVA_PACKAGES[version];
  // Native Linux: no auto-install. Package names and managers vary per distro and the
  // container-side apk rule (REQ-4.2) does not apply to the host, so refuse honestly.
  if (!IS_WIN) {
    return {
      version,
      packageName,
      installed: false,
      versionOutput: null,
      reason: `Linux host: install the JRE with your package manager (e.g. apt-get install ${LINUX_JAVA_HINT[version]}), then re-check`,
    };
  }
  const add = wslRun(["/sbin/apk", "add", "--no-cache", packageName]);
  if (!add) {
    return { version, packageName, installed: false, versionOutput: null, reason: "wsl.exe not found on PATH: cannot install" };
  }
  if (add.status !== 0) {
    const detail = firstLine(add.stderr) || firstLine(add.stdout) || `exit ${add.status}`;
    return { version, packageName, installed: false, versionOutput: null, reason: `apk_add_failed: ${detail}` };
  }
  const state = javaState(version);
  return state.installed
    ? { ...state, reason: `installed via apk add --no-cache ${packageName}; ${state.reason}` }
    : state;
}

/** Glob used to locate the JRE inside a container rootfs (JVM_DIR_PREFIX is shared with the engine). */
export function rootfsJavaGlob(version: JavaVersion, rootfsAbs: string): string {
  return `${rootfsAbs}/usr/lib/jvm/${JVM_DIR_PREFIX[version]}*/bin/java`;
}
