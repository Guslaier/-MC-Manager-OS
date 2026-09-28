import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProvisionReport, ProvisionState, ProvisionStep } from "@mcm/contracts";
import { wslDistro } from "./engine.js";

// REQ-1.1 provisioning boundary. It detects WSL capability and performs the three
// explicitly requested steps (elevated install, Alpine import, runc install). It
// NEVER unregisters or overwrites an existing distro, NEVER restarts Windows, and
// NEVER reports a step as done unless the process exit code proves it.

const SHA256_RE = /^[0-9a-f]{64}$/;
const DISTRO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ALPINE_HOSTS = ["dl-cdn.alpinelinux.org"];
const WIN_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WSL_CMD_TIMEOUT_MS = 60_000;
const WSL_LONG_TIMEOUT_MS = 900_000;

/** Repository-approved official Alpine minirootfs, pinned by SHA256 (fail closed). */
const DEFAULT_ALPINE_TAR_URL =
  "https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-minirootfs-3.21.4-x86_64.tar.gz";

/** Distro name is always passed as its own argv entry; still reject junk up front. */
function distro(): string {
  const name = wslDistro();
  if (!DISTRO_NAME_RE.test(name)) throw new Error(`invalid WSL distro name: ${JSON.stringify(name)}`);
  return name;
}

function wslPath(): string | null {
  const found = findOnPath("wsl");
  return found;
}

/** Minimal PATH lookup (engine's copy is not exported; keeps engine.ts untouched). */
function findOnPath(binary: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext.toLowerCase());
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here; keep scanning
      }
    }
  }
  return null;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Sync WSL call (detection only): array args, never a shell string, UTF-8 output. */
function wslSync(args: string[], timeout = WSL_CMD_TIMEOUT_MS): RunResult {
  const exe = wslPath();
  if (!exe) return { status: 127, stdout: "", stderr: "wsl.exe not found on PATH" };
  const r = spawnSync(exe, args, {
    encoding: "utf8",
    timeout,
    env: { ...process.env, WSL_UTF8: "1" },
  });
  return {
    status: r.status,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? r.error?.message ?? ""),
  };
}

interface AsyncOptions {
  input?: Buffer;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Async spawn (long steps): array args only; resolves on exit, timeout, or abort. */
function run(exe: string, args: string[], opts: AsyncOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(exe, args, {
      env: { ...process.env, WSL_UTF8: "1", ...(opts.env ?? {}) },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (status: number | null, extra = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ status, stdout, stderr: stderr + extra });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `\ntimed out after ${opts.timeoutMs ?? WSL_LONG_TIMEOUT_MS} ms`);
    }, opts.timeoutMs ?? WSL_LONG_TIMEOUT_MS);
    const onAbort = (): void => {
      child.kill();
      finish(null, "\naborted by operator");
    };
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => finish(null, `\nspawn error: ${err.message}`));
    child.on("close", (code) => finish(code));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.input) child.stdin?.end(opts.input);
  });
}

function trim(text: string, max = 400): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Registered distro names, captured from `wsl -l -q` (UTF-8). */
function listedDistros(): string[] {
  const r = wslSync(["-l", "-q"]);
  if (r.status !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter(Boolean);
}

interface Detection {
  wslPresent: boolean;
  wslReady: boolean;
  distroPresent: boolean;
  runcVersion: string | null;
  cgroup2: boolean;
}

function detectHost(): Detection {
  if (process.platform !== "win32") {
    // Native Linux: there is no WSL layer, so the host itself is the engine host.
    const runc = spawnSync("runc", ["--version"], { encoding: "utf8", timeout: 15_000 });
    const runcVersion = runc.status === 0 ? (runc.stdout.split("\n")[0]?.trim() ?? "") || null : null;
    let cgroup2 = false;
    try {
      cgroup2 = readFileSync("/sys/fs/cgroup/cgroup.controllers", "utf8").trim().length > 0;
    } catch {
      cgroup2 = false;
    }
    return { wslPresent: true, wslReady: true, distroPresent: true, runcVersion, cgroup2 };
  }
  const wslPresent = Boolean(wslPath());
  if (!wslPresent) {
    return { wslPresent: false, wslReady: false, distroPresent: false, runcVersion: null, cgroup2: false };
  }
  const status = wslSync(["--status"]);
  const combined = `${status.stdout}\n${status.stderr}`;
  const wslReady =
    status.status === 0 && !/not installed|is not installed|no installed distributions/i.test(combined);
  const distroPresent = listedDistros().some((d) => d === distro());
  if (!distroPresent) {
    return { wslPresent: true, wslReady, distroPresent: false, runcVersion: null, cgroup2: false };
  }
  const runc = wslSync(["-d", distro(), "-u", "root", "-e", "runc", "--version"]);
  const runcVersion = runc.status === 0 ? (runc.stdout.split("\n")[0]?.trim() ?? "") || null : null;
  const cg = wslSync(["-d", distro(), "-u", "root", "-e", "cat", "/sys/fs/cgroup/cgroup.controllers"]);
  return {
    wslPresent: true,
    wslReady,
    distroPresent: true,
    runcVersion,
    cgroup2: cg.status === 0 && Boolean(cg.stdout.trim()),
  };
}

function stateOf(d: Detection): { state: ProvisionState; reason: string; restartRequired: boolean } {
  if (process.platform !== "win32") {
    // Reuses the existing ProvisionState union unchanged; only the wording/advice differ.
    if (!d.runcVersion) {
      return {
        state: "runc_missing",
        reason: "runc is not installed on this host; install it with your package manager (apt-get install runc / dnf install runc)",
        restartRequired: false,
      };
    }
    if (!d.cgroup2) {
      return {
        state: "cgroup_unavailable",
        reason: "cgroup v2 unified hierarchy is not available on this host; runc resource limits cannot be applied",
        restartRequired: false,
      };
    }
    return {
      state: "distro_ready",
      reason: `${d.runcVersion} on the Linux host (cgroup v2); provide a prepared rootfs via MCM_WSL_ROOTFS`,
      restartRequired: false,
    };
  }
  if (!d.wslPresent) {
    return {
      state: "wsl_absent",
      reason: "wsl.exe not found on PATH: run the elevated WSL install step, then restart Windows if prompted",
      restartRequired: false,
    };
  }
  if (!d.wslReady) {
    return {
      state: "components_missing",
      reason:
        "the WSL optional components are not fully installed; run the elevated install step (wsl --install --no-distribution)",
      restartRequired: false,
    };
  }
  if (!d.distroPresent) {
    return {
      state: "distro_missing",
      reason: `WSL distro ${distro()} is not registered; import the verified Alpine rootfs (existing distros are never touched)`,
      restartRequired: false,
    };
  }
  if (!d.runcVersion) {
    return {
      state: "runc_missing",
      reason: `runc is not installed inside ${distro()}; run the runc step (apk add --no-cache runc)`,
      restartRequired: false,
    };
  }
  if (!d.cgroup2) {
    return {
      state: "cgroup_unavailable",
      reason: `cgroup v2 unified hierarchy is not available in ${distro()}; runc resource limits cannot be applied`,
      restartRequired: false,
    };
  }
  return {
    state: "distro_ready",
    reason: `${d.runcVersion} in WSL distro ${distro()} (cgroup v2, rootfs ready)`,
    restartRequired: false,
  };
}

/** Detects the true host state. `busy` reflects the single-flight lock, not a cached claim. */
export function detectProvision(): ProvisionReport {
  let d: Detection;
  try {
    d = detectHost();
  } catch (err) {
    // Bad MCM_WSL_DISTRO must be a visible refusal, never a 500 or a fake state.
    return {
      state: "failed",
      distro: String(process.env.MCM_WSL_DISTRO ?? "MC-Manager-OS"),
      wslPresent: false,
      distroPresent: false,
      runcVersion: null,
      cgroup2: false,
      busy: inflight !== null,
      restartRequired: false,
      manualAction: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const s = stateOf(d);
  return {
    state: inflight ? "provisioning" : s.state,
    distro: distro(),
    wslPresent: d.wslPresent,
    distroPresent: d.distroPresent,
    runcVersion: d.runcVersion,
    cgroup2: d.cgroup2,
    busy: inflight !== null,
    restartRequired: s.restartRequired,
    manualAction: manualActionFor(inflight ? "provisioning" : s.state),
    reason: inflight ? `provisioning in progress (${inflight}); ${s.reason}` : s.reason,
  };
}

function manualActionFor(state: ProvisionState): ProvisionReport["manualAction"] {
  if (state === "wsl_absent" || state === "components_missing") return "run_elevated_install";
  if (state === "restart_required") return "restart_then_retry";
  return null;
}

// --- guards ------------------------------------------------------------------

/** SHA256 must be explicitly configured; the service refuses to download unpinned. */
function alpineSha(): string {
  const sha = (process.env.MCM_ALPINE_SHA256 ?? "").trim().toLowerCase();
  if (!SHA256_RE.test(sha)) {
    throw new Error(
      "MCM_ALPINE_SHA256 must be set to the 64-hex SHA256 of the official Alpine minirootfs (fail closed, no unverified download)",
    );
  }
  return sha;
}

/** Only the official Alpine CDN over HTTPS is accepted. */
function alpineUrl(): { url: string; sha: string } {
  const url = (process.env.MCM_ALPINE_TAR_URL ?? DEFAULT_ALPINE_TAR_URL).trim();
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
  return { url, sha: alpineSha() };
}

/** Import destination must be an absolute Windows drive path; never a UNC/relative/root path. */
function importDir(): string {
  const raw = (process.env.MCM_WSL_IMPORT_DIR ?? "").trim();
  if (!raw) {
    throw new Error("MCM_WSL_IMPORT_DIR must be set to an absolute Windows folder for the distro's own filesystem");
  }
  if (raw.includes("..")) throw new Error("MCM_WSL_IMPORT_DIR must not contain parent-directory segments");
  if (!WIN_DRIVE_RE.test(raw)) throw new Error(`MCM_WSL_IMPORT_DIR must be an absolute Windows path (e.g. C:\\mcm\\wsl): ${raw}`);
  return raw;
}

function ensureWindows(): void {
  if (process.platform !== "win32") throw new Error("WSL provisioning is only available on Windows hosts");
}

/**
 * Ensures %USERPROFILE%\.wslconfig has hostAddressLoopback=true and networkingMode=mirrored
 * by default so the host machine itself and LAN/IPv6 connections connect smoothly without SYN_SENT.
 */
export function ensureWslConfigDefaults(): { updated: boolean; path: string } {
  if (process.platform !== "win32") return { updated: false, path: "" };
  const userProfile = process.env.USERPROFILE ?? os.homedir();
  if (!userProfile) return { updated: false, path: "" };
  const configPath = path.join(userProfile, ".wslconfig");

  try {
    let content = "";
    if (existsSync(configPath)) {
      content = readFileSync(configPath, "utf8");
    }

    let modified = false;
    if (!content.includes("[wsl2]")) {
      content = `[wsl2]\nhostAddressLoopback=true\nnetworkingMode=mirrored\nautoProxy=true\nfirewall=true\n` + content;
      modified = true;
    } else {
      if (!/hostAddressLoopback\s*=\s*true/i.test(content)) {
        content = content.replace(/\[wsl2\]/i, "[wsl2]\nhostAddressLoopback=true");
        modified = true;
      }
      if (!/networkingMode\s*=\s*mirrored/i.test(content)) {
        content = content.replace(/\[wsl2\]/i, "[wsl2]\nnetworkingMode=mirrored");
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(configPath, content, "utf8");
      return { updated: true, path: configPath };
    }
  } catch {
    // Non-fatal if permissions don't allow
  }
  return { updated: false, path: configPath };
}

// --- steps -------------------------------------------------------------------

/**
 * Elevated `wsl --install --no-distribution`. UAC decline (1223), nonzero exit, or
 * a still-missing component are all reported as-is; a Windows restart is only ever
 * reported as `restart_required`, never performed and never claimed as success.
 */
async function stepInstall(): Promise<string> {
  ensureWindows();
  const wsl = wslPath();
  if (!wsl) {
    const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // Fixed literal argv: no user-controlled value ever reaches -Verb RunAs.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$p = Start-Process -FilePath $env:MCM_WSL_EXE -ArgumentList '--install','--no-distribution' -Verb RunAs -PassThru -Wait",
      "exit $p.ExitCode",
    ].join("; ");
    const r = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { MCM_WSL_EXE: "wsl.exe" },
      timeoutMs: WSL_LONG_TIMEOUT_MS,
    });
    if (r.status !== 0) {
      throw new Error(
        `elevated WSL install did not complete (exit ${String(r.status)}; UAC declined is exit 1223): ${trim(r.stderr || r.stdout)}`,
      );
    }
  } else {
    const r = wslSync(["--install", "--no-distribution"], WSL_LONG_TIMEOUT_MS);
    if (r.status !== 0) {
      throw new Error(`wsl --install --no-distribution failed (exit ${String(r.status)}): ${trim(r.stderr || r.stdout)}`);
    }
  }
  const after = detectHost();
  if (!after.wslPresent || !after.wslReady) {
    return "wsl --install reported success but the WSL components are not active yet; restart Windows, then retry (restart_required)";
  }
  return "WSL components are active";
}

/** Imports the verified official Alpine rootfs, only when the distro is absent. */
async function stepImport(signal?: AbortSignal): Promise<string> {
  ensureWindows();
  const name = distro();
  const dest = importDir();
  const { url, sha } = alpineUrl();
  if (listedDistros().some((d) => d === name)) {
    return `distro ${name} already registered (import skipped; never overwritten)`;
  }
  const tarLocal = path.join(os.tmpdir(), `mcm-alpine-${Date.now()}.tar.gz`);
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // Fixed literal script; url/sha/tar travel through env, so nothing is interpolated
  // into the command line. Mismatch exits 3 before any import can run.
  const script = [
    "$ErrorActionPreference='Stop'",
    "Invoke-WebRequest -Uri $env:MCM_DL_URL -OutFile $env:MCM_DL_TAR -UseBasicParsing -TimeoutSec 600",
    "$h=(Get-FileHash -Algorithm SHA256 $env:MCM_DL_TAR).Hash.ToLower()",
    "if ($h -ne $env:MCM_DL_SHA) { Write-Error \"SHA256 MISMATCH expected=$env:MCM_DL_SHA actual=$h\"; exit 3 }",
    "exit 0",
  ].join("; ");
  const dl = await run(ps, ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { MCM_DL_URL: url, MCM_DL_SHA: sha, MCM_DL_TAR: tarLocal },
    timeoutMs: WSL_LONG_TIMEOUT_MS,
    signal,
  });
  if (dl.status !== 0) throw new Error(`Alpine download/verify failed (exit ${String(dl.status)}): ${trim(dl.stderr || dl.stdout)}`);
  let size = 0;
  try {
    size = statSync(tarLocal).size;
  } catch {
    throw new Error(`verified Alpine rootfs is missing at ${tarLocal}`);
  }
  // Stage inside the (running) distro, then import from its own filesystem so wsl.exe
  // never has to read the tar across a Windows path with quoting quirks.
  const staged = `/tmp/mcm-alpine-${Date.now()}.tar.gz`;
  const push = await run(wslPath() ?? "wsl.exe", ["-d", name, "-u", "root", "-e", "sh", "-c", `cat > ${staged}`], {
    input: readFileSync(tarLocal),
    timeoutMs: WSL_LONG_TIMEOUT_MS,
    signal,
  });
  if (push.status !== 0) throw new Error(`staging the verified rootfs inside ${name} failed: ${trim(push.stderr || push.stdout)}`);
  const uncTar = `\\\\wsl.localhost\\${name}${staged.replace(/\//g, "\\")}`;
  const imp = await run(wslPath() ?? "wsl.exe", ["--import", name, dest, uncTar, "--version", "2"], {
    timeoutMs: WSL_LONG_TIMEOUT_MS,
    signal,
  });
  if (imp.status !== 0) throw new Error(`wsl --import ${name} failed (exit ${String(imp.status)}): ${trim(imp.stderr || imp.stdout)}`);
  await run(wslPath() ?? "wsl.exe", ["-d", name, "-u", "root", "-e", "rm", "-f", staged], { signal });
  return `imported ${size} verified bytes of official Alpine into ${name} at ${dest}`;
}

/** Installs runc via apk (idempotent) and re-probes to prove it works. */
async function stepRunc(signal?: AbortSignal): Promise<string> {
  ensureWindows();
  const name = distro();
  if (!listedDistros().some((d) => d === name)) throw new Error(`distro ${name} is not registered; run the import step first`);
  const r = await run(wslPath() ?? "wsl.exe", ["-d", name, "-u", "root", "-e", "apk", "add", "--no-cache", "runc"], {
    timeoutMs: WSL_LONG_TIMEOUT_MS,
    signal,
  });
  if (r.status !== 0) throw new Error(`apk add --no-cache runc failed (exit ${String(r.status)}): ${trim(r.stderr || r.stdout)}`);
  const after = detectHost();
  if (!after.runcVersion) throw new Error("apk reported success but runc --version still fails inside the distro");
  if (!after.cgroup2) throw new Error("runc is installed but the cgroup v2 unified hierarchy is unavailable");
  return `${after.runcVersion} verified inside ${name} (cgroup v2)`;
}

// --- single-flight controller ------------------------------------------------

let inflight: ProvisionStep | null = null;
let lastError: { step: ProvisionStep; message: string } | null = null;

/** Last step failure, surfaced so GET /api/provision can report it honestly. */
export function lastProvisionError(): { step: ProvisionStep; message: string } | null {
  return lastError;
}

function launch(step: ProvisionStep, work: Promise<string>, signal: AbortSignal): void {
  inflight = step;
  lastError = null;
  void work
    .then(() => {
      inflight = null;
    })
    .catch((err: unknown) => {
      inflight = null;
      lastError = { step, message: err instanceof Error ? err.message : String(err) };
    })
    .finally(() => {
      void signal;
    });
}

/**
 * Starts one provisioning step. Idempotent steps that are already satisfied return
 * synchronously; long steps are launched and reported as `provisioning` so the HTTP
 * request returns immediately. Never blocks on the child process.
 */
export function startProvision(step: ProvisionStep): ProvisionReport {
  const current = detectProvision();
  if (current.busy) {
    return { ...current, step, reason: `a provisioning step (${String(inflight)}) is already running; ${current.reason}` };
  }
  const controller = new AbortController();
  const base = { ...current, step };

  if (process.platform !== "win32") {
    // The install/import/runc steps drive Windows/WSL tooling only. On a Linux host the
    // operator installs runc and provides the rootfs, so no step is launched here.
    return {
      ...base,
      reason: "host provisioning steps are Windows/WSL-only; on Linux install runc and provide a rootfs via MCM_WSL_ROOTFS manually",
    };
  }

  try {
    if (step === "install") {
      if (current.wslPresent && current.state !== "components_missing") {
        return { ...base, reason: `already satisfied: ${current.reason}` };
      }
      launch(step, stepInstall(), controller.signal);
      return { ...base, state: "provisioning", busy: true, reason: "launched elevated WSL component install; UAC prompt on the host" };
    }
    if (step === "import") {
      if (current.distroPresent) return { ...base, reason: `already provisioned: distro ${current.distro} is registered (import skipped)` };
      // Validate config synchronously so a bad/missing setting is refused in the HTTP
      // response instead of being swallowed by the detached worker.
      importDir();
      alpineUrl();
      launch(step, stepImport(controller.signal), controller.signal);
      return { ...base, state: "provisioning", busy: true, reason: "downloading + verifying official Alpine, then importing (distro absent)" };
    }
    if (current.runcVersion && current.cgroup2) return { ...base, reason: `already provisioned: ${current.reason}` };
    if (!current.distroPresent) {
      return { ...base, state: "distro_missing", reason: `distro ${current.distro} is not registered; run the import step first` };
    }
    launch(step, stepRunc(controller.signal), controller.signal);
    return { ...base, state: "provisioning", busy: true, reason: "installing runc inside the distro via apk (idempotent)" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastError = { step, message };
    return { ...base, state: "failed", busy: false, reason: `guard rejected ${step}: ${message}` };
  }
}
