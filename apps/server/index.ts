import "./load-env.js"; // must stay first: loads repo-root .env before any env reads
import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, readSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";
import os from "node:os";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { Server as SocketServer } from "socket.io";
import type {
  ApiError,
  ConsoleEvent,
  CreateServerRequest,
  DownloadSoftwareRequest,
  EulaStatus,
  HealthStatus,
  JavaInstallReport,
  JavaInstallRequest,
  JavaVersion,
  LoginResponse,
  ProvisionReport,
  ProvisionStep,
  ResourceStatus,
  ServerRecord,
  ServerType,
  SessionInfo,
  SetEulaRequest,
  UpdateServerRequest,
  UploadConflict,
  UploadConflictPolicy,
  UploadResult,
  UploadStatus,
  FlushResult,
  PlayerAction,
  PlayerActionRequest,
  PlayerActionResult,
  PlayerListResult,
  PlayerRef,
  WorldDimension,
  WorldStateResult,
  ServerPropertiesPatch,
  ServerPropertiesUpdateResult,
  ServerPropertiesView,
  GamerulesPatch,
  GamerulesUpdateResult,
  GamerulesView,
} from "@mcm/contracts";
import { CANONICAL_BEDROCK_NAME, CANONICAL_JAR_NAME, DEFAULT_BEDROCK_PORT, DEFAULT_BEDROCK_SCRIPT_RUN, DEFAULT_SCRIPT_RUN } from "@mcm/contracts";
import {
  SERVER_PROPERTY_KEYS,
  WHITELIST_FILE,
  mergeProperties,
  parseListLine,
  planPlayerAction,
  planPropertiesPatch,
  readJsonNameList,
  readProperties,
  readPropertiesText,
  resolveServerProperties,
  summarizeDir,
  writePropertiesAtomic,
} from "./players.js";
import { NbtError } from "./nbt.js";
import { patchGamerules, planGamerulesPatch, readGamerules, readGamerulesDefaults } from "./gamerules.js";
import { readBedrockGamerules, patchBedrockGamerules } from "./bedrock_gamerules.js";
import { containerMetrics, containerMetricsLive, engine, probeEngine, removeContainer, resourceStatus } from "./engine.js";
import { buildContainerCommand, scriptRunProblem } from "./script.js";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_CHUNK_BYTES,
  PathTraversalError,
  TargetExistsError,
  appendChunk,
  assertWithinScope,
  collectDataFiles,
  dataRoot,
  dataRootStatfs,
  deleteEntry,
  entryExists,
  listDir,
  measureDir,
  nextAvailableName,
  readEula,
  readFileText,
  removeIfExists,
  ensureDataRoot,
  renameEntry,
  resolveSafe,
  resolveUploadTarget,
  sanitizePath,
  writeEula,
  writeFileText,
} from "./files.js";
import { migrationStatus } from "./migration.js";
import { JAVA_PACKAGES, installJava, isJavaVersion, javaState, javaStates } from "./java.js";
import { detectProvision, ensureWslConfigDefaults, lastProvisionError, startProvision } from "./provisioning.js";

// Ensure WSL host loopback and mirrored networking are configured by default on Windows
ensureWslConfigDefaults();
import {
  SOFTWARE_KINDS,
  downloadSoftware,
  isJarArchive,
  isSoftwareKind,
  listSoftware,
  setExecutable,
  softwareRoot,
  stageCanonicalJar,
} from "./software.js";
import { createZip, createZipStream } from "./zip.js";
import {
  ArchiveFormatError,
  detectFormat,
  getArchiveTask,
  listArchiveTasks,
  openArchive,
  startExtraction,
  walkZipEntries,
} from "./archive.js";

export { probeEngine };

// --- Configuration -----------------------------------------------------------
// Development defaults are intentionally visible. Both MUST be overridden in
// any non-local deployment. Auth is single-user by design (see SRS).
const MASTER_PASSWORD = process.env.MCM_MASTER_PASSWORD ?? "changeme";
const JWT_SECRET = process.env.MCM_JWT_SECRET ?? "dev-insecure-secret-change-me";
const JWT_TTL_SECONDS = Number(process.env.MCM_JWT_TTL_SECONDS ?? 12 * 60 * 60);
const SINGLE_USER = "admin";

if (process.env.NODE_ENV === "production" && (!process.env.MCM_MASTER_PASSWORD || !process.env.MCM_JWT_SECRET)) {
  console.warn("[auth] production mode without MCM_MASTER_PASSWORD/MCM_JWT_SECRET overrides - refusing to advertise security");
}

// --- Token helpers (HMAC-signed, no extra dependency) ------------------------
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", JWT_SECRET).update(payload).digest("base64url");
}

export function issueToken(subject: string): string {
  const body = b64url(JSON.stringify({ sub: subject, exp: Date.now() + JWT_TTL_SECONDS * 1000 }));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): string | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const provided = Buffer.from(token.slice(idx + 1));
  const expected = Buffer.from(sign(body));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      sub: string;
      exp: number;
    };
    if (!parsed.exp || parsed.exp < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

// --- Server state -----------------------------------------------------------
// Server metadata lives in a JSON file under the data root so records survive a
// restart. PIDs and console buffers stay ephemeral on purpose: a PID from a
// previous boot is meaningless and console history is a session artifact.
const STATE_FILE = "state.json";
const processes = new Map<string, ChildProcess>();
const consoleBuffers = new Map<string, ConsoleEvent[]>();
const CONSOLE_BUFFER_LIMIT = 500;

const MIN_MEMORY_MB = 256;
const MAX_MEMORY_MB = 65536;
const MAX_CORES = 16;

/** undefined = not supplied, null = invalid, number = accepted. */
function parseMemoryMb(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_MEMORY_MB || parsed > MAX_MEMORY_MB) return null;
  return parsed;
}

function parseCores(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CORES) return null;
  return parsed;
}

function parsePort(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

function statePath(): string {
  return resolveSafe(STATE_FILE);
}

/** Recorded name of the pre-canonical core jar: only this fixed name is auto-migrated. */
const LEGACY_JAR_NAME = "jar.jar";

/** Canonical root-relative directory that holds one server's files: `server/<id>`. */
function serverDir(record: ServerRecord): string {
  return record.id;
}

/** Recorded .jar names present on disk for a server, sorted for a stable result. */
function jarNamesIn(record: ServerRecord): string[] {
  try {
    return readdirSync(resolveSafe(serverDir(record)))
      .filter((name) => name.toLowerCase().endsWith(".jar"))
      .sort();
  } catch {
    return [];
  }
}

/** True when the file at `abs` begins with the ZIP/JAR (PK\x03\x04) magic. */
function isJarFileAbs(abs: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(abs, "r");
    const head = Buffer.alloc(8);
    return readSync(fd, head, 0, head.length, 0) >= 8 && isJarArchive(head);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Validates a user-recorded launch jar name: a plain basename that is a real ZIP/JAR already
 * present in this server's scoped dir. Returns an error reason, or null when safe to store.
 */
function jarProblemIn(record: ServerRecord, name: string): string | null {
  if (!name || name !== path.basename(name) || !name.toLowerCase().endsWith(".jar")) {
    return "jarFile must be a .jar file name without a directory";
  }
  if (!jarNamesIn(record).includes(name)) return "no such .jar in this server's files";
  if (!isJarFileAbs(resolveSafe(`${serverDir(record)}/${name}`))) {
    return "file is not a ZIP/JAR archive (PK magic missing)";
  }
  // server.jar is the canonical launch jar; switching away from it silently would desync the
  // recorded name from what actually launches, so the conflicting jar must be removed first.
  if (name !== CANONICAL_JAR_NAME && jarNamesIn(record).includes(CANONICAL_JAR_NAME)) {
    return `${CANONICAL_JAR_NAME} already exists; delete it first to switch launch jars`;
  }
  return null;
}

/**
 * Canonicalises a server's core jar to server/<id>/server.jar. Only the fixed legacy
 * name (or, when nothing is recorded, the one jar on disk) is moved, so a custom
 * recorded name is never renamed; an existing canonical jar is never overwritten - the
 * legacy file is kept and the conflict is warned instead.
 */
function canonicalizeServerJar(record: ServerRecord): boolean {
  const dir = serverDir(record);
  const names = jarNamesIn(record);
  const recorded = typeof record.jarFile === "string" && record.jarFile ? record.jarFile : null;
  if (!names.includes(CANONICAL_JAR_NAME)) {
    const legacy =
      recorded === null ? (names.length === 1 ? names[0] : null) : recorded === LEGACY_JAR_NAME ? recorded : null;
    if (!legacy) return false;
    try {
      rmSync(resolveSafe(`${dir}/${CANONICAL_JAR_NAME}`), { force: true });
      renameSync(resolveSafe(`${dir}/${legacy}`), resolveSafe(`${dir}/${CANONICAL_JAR_NAME}`));
    } catch (err) {
      console.warn(`[state] ${record.id}: cannot canonicalise ${legacy} to ${CANONICAL_JAR_NAME}: ${String(err)}`);
      return false;
    }
  } else if (recorded !== null && recorded !== CANONICAL_JAR_NAME && names.includes(recorded)) {
    console.warn(`[state] ${record.id}: ${CANONICAL_JAR_NAME} and ${recorded} both exist; using ${CANONICAL_JAR_NAME}`);
  }
  if (record.jarFile !== CANONICAL_JAR_NAME) {
    record.jarFile = CANONICAL_JAR_NAME;
    return true;
  }
  return false;
}

/** Loads persisted servers; a missing or corrupt file is an empty registry, never a crash. */
function loadServers(): Map<string, ServerRecord> {
  const map = new Map<string, ServerRecord>();
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as ServerRecord[];
    for (const record of parsed) {
      // Nothing survived the restart, so a persisted "running" record is corrected.
      map.set(record.id, {
        ...record,
        serverType: record.serverType === "bedrock" ? "bedrock" : "java",
        cpuCores: record.cpuCores ?? 1,
        // Older records predate Java/Fabric support: default to 17 and no jar.
        javaVersion: isJavaVersion(record.javaVersion) ? record.javaVersion : "17",
        // Older records predate the heavy-modpack toggle: backfill to the default (on).
        optimizeHeavyModpack: typeof record.optimizeHeavyModpack === "boolean" ? record.optimizeHeavyModpack : true,
        jarFile: typeof record.jarFile === "string" ? record.jarFile : null,
        // LEGACY: a previously-pinned external folder. Storage is now canonical
        // container-side `server/<id>`, so the pin is retired (always null) and can
        // never redirect files or the runc jar bind outside the canonical root.
        dataRoot: null,
        // Older records predate custom launch commands: fall back to the default.
        scriptRun:
          typeof record.scriptRun === "string" && record.scriptRun.trim()
            ? record.scriptRun
            : record.serverType === "bedrock"
            ? DEFAULT_BEDROCK_SCRIPT_RUN
            : DEFAULT_SCRIPT_RUN,
        state: record.state === "running" ? "stopped" : record.state,
        pid: null,
      });
    }
    // Migration runs once at load: every record is canonicalised before the first
    // request, so the rest of the service only ever sees server/<id>/server.jar.
    let migrated = false;
    for (const record of map.values()) {
      if (record.serverType !== "bedrock" && canonicalizeServerJar(record)) migrated = true;
    }
    if (migrated) writeState([...map.values()]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[state] ignoring unreadable ${STATE_FILE}: ${String(err)}`);
    }
  }
  return map;
}

const servers = loadServers();

/** Writes a registry array write-then-rename, so a crash cannot truncate it. */
function writeState(list: ServerRecord[]): void {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  renameSync(tmp, file);
}

/** Persists the live registry. */
function persistServers(): void {
  writeState([...servers.values()]);
}

function bufferConsole(event: ConsoleEvent): void {
  const lines = consoleBuffers.get(event.serverId) ?? [];
  lines.push(event);
  if (lines.length > CONSOLE_BUFFER_LIMIT) lines.splice(0, lines.length - CONSOLE_BUFFER_LIMIT);
  consoleBuffers.set(event.serverId, lines);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform === "win32") {
    // Windows has no process groups here; taskkill /T covers the child tree.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill(signal);
}

// --- App + sockets ----------------------------------------------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, { cors: { origin: true } });

io.use((socket, next) => {
  const token = (socket.handshake.auth?.token as string | undefined) ?? "";
  if (verifyToken(token)) return next();
  next(new Error("unauthorized"));
});

io.on("connection", (socket) => {
  const serverId = socket.handshake.query.serverId as string | undefined;
  if (serverId) {
    socket.join(serverId);
    for (const line of consoleBuffers.get(serverId) ?? []) socket.emit("console", line);
  }
  // stdin: only reaches a process that is actually alive. No process means the
  // input is dropped silently rather than queued for a server that is not there.
  socket.on("stdin", (payload: unknown) => {
    const target = String((payload as { serverId?: unknown })?.serverId ?? serverId ?? "");
    const line = String((payload as { line?: unknown })?.line ?? "");
    if (!line) return;
    const child = processes.get(target);
    if (!child?.stdin?.writable) return;
    child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  });
});

function emitConsole(event: ConsoleEvent): void {
  bufferConsole(event);
  io.to(event.serverId).emit("console", event);
}

// --- Middleware -------------------------------------------------------------
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (verifyToken(token)) return next();
  const body: ApiError = { error: "unauthorized" };
  res.status(401).json(body);
}

function fail(res: Response, status: number, error: string, reason: string): void {
  const body: ApiError = { error, reason: sanitizePath(reason) };
  res.status(status).json(body);
}

// --- Public routes ----------------------------------------------------------
app.get("/api/health", (_req, res) => {
  const body: HealthStatus = {
    ok: true,
    service: "mcm-server",
    uptimeSeconds: Math.round(process.uptime()),
  };
  res.json(body);
});

app.get("/api/engine", (_req, res) => {
  res.json(probeEngine());
});

app.post("/api/auth/login", (req, res) => {
  const provided = String((req.body as { password?: unknown })?.password ?? "");
  const a = Buffer.from(provided);
  const b = Buffer.from(MASTER_PASSWORD);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) return fail(res, 401, "invalid_credentials", "master password does not match");
  const body: LoginResponse = { token: issueToken(SINGLE_USER), expiresInSeconds: JWT_TTL_SECONDS };
  res.json(body);
});

// --- Authenticated routes ---------------------------------------------------
app.get("/api/auth/session", requireAuth, (req, res) => {
  const token = (req.header("authorization") ?? "").slice(7);
  const idx = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf(".")), "base64url").toString("utf8"));
  const body: SessionInfo = { username: SINGLE_USER, expiresAt: new Date(idx.exp).toISOString() };
  res.json(body);
});

app.get("/api/status", requireAuth, (_req, res) => {
  res.json(resourceStatus());
});

// Host provisioning (REQ-1.1). Authenticated: it triggers elevated/import steps.
app.get("/api/provision", requireAuth, (_req, res) => {
  const report: ProvisionReport = detectProvision();
  const err = lastProvisionError();
  // Surface the last step failure honestly until the state is genuinely healthy.
  if (err && !report.busy && report.state !== "distro_ready") {
    return res.json({ ...report, state: "failed" as const, reason: `last ${err.step} failed: ${err.message}` });
  }
  res.json(report);
});

app.post("/api/provision", requireAuth, (req, res) => {
  const raw = String((req.body as { step?: unknown })?.step ?? "");
  if (raw !== "install" && raw !== "import" && raw !== "runc") {
    return fail(res, 400, "invalid_request", "step must be one of: install, import, runc");
  }
  const report: ProvisionReport = startProvision(raw as ProvisionStep);
  // A guard rejection is a client-visible refusal, not a server fault.
  res.status(report.state === "failed" ? 409 : 200).json(report);
});

// Java provisioning (REQ-4.2). Only Alpine musl packages are installable: a
// portable/glibc JDK URL is never accepted, so there is no download path here.
app.get("/api/java", requireAuth, (_req, res) => {
  res.json(javaStates());
});

app.post("/api/java", requireAuth, (req, res) => {
  const version = (req.body as JavaInstallRequest)?.version;
  if (!isJavaVersion(version)) {
    return fail(res, 400, "invalid_request", "version must be one of: 8, 17, 21");
  }
  const report: JavaInstallReport = installJava(version);
  // A failed apk add is a real refusal, not a silent success.
  res.status(report.installed ? 200 : 502).json(report);
});

// Server lifecycle
app.get("/api/servers", requireAuth, (_req, res) => {
  res.json([...servers.values()]);
});

app.post("/api/servers", requireAuth, async (req, res) => {
  const body = req.body as CreateServerRequest;
  if (!body?.name) return fail(res, 400, "invalid_request", "name is required");
  if (body.javaVersion !== undefined && !isJavaVersion(body.javaVersion)) {
    return fail(res, 400, "invalid_request", "javaVersion must be one of: 8, 17, 21");
  }
  const memoryMb = parseMemoryMb(body.memoryMb);
  if (memoryMb === null) {
    return fail(res, 400, "invalid_request", `memoryMb must be an integer ${MIN_MEMORY_MB}-${MAX_MEMORY_MB}`);
  }
  const cpuCores = parseCores(body.cpuCores);
  if (cpuCores === null) return fail(res, 400, "invalid_request", `cpuCores must be an integer 1-${MAX_CORES}`);
  const gamePort = parsePort(body.gamePort);
  if (gamePort === null) return fail(res, 400, "invalid_request", "gamePort must be an integer 1-65535");
  if (body.scriptRun !== undefined) {
    const problem = scriptRunProblem(body.scriptRun);
    if (problem) return fail(res, 400, "invalid_script", problem);
  }
  const id = `srv_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const isBedrock = body.serverType === "bedrock";
  const defaultPort = isBedrock ? DEFAULT_BEDROCK_PORT : 25565;
  const defaultRun = isBedrock ? DEFAULT_BEDROCK_SCRIPT_RUN : DEFAULT_SCRIPT_RUN;
  const record: ServerRecord = {
    id,
    name: body.name,
    serverType: isBedrock ? "bedrock" : "java",
    gamePort: gamePort ?? defaultPort,
    memoryMb: memoryMb ?? 1024,
    cpuCores: cpuCores ?? 1,
    javaVersion: (body.javaVersion as JavaVersion | undefined) ?? "17",
    jarFile: isBedrock ? CANONICAL_BEDROCK_NAME : null,
    // Defaults align with the Configuration tab; validated above when supplied.
    scriptRun:
      typeof body.scriptRun === "string" && body.scriptRun.trim() ? body.scriptRun.trim() : defaultRun,
    // Default ON; an explicit false is preserved.
    optimizeHeavyModpack: typeof body.optimizeHeavyModpack === "boolean" ? body.optimizeHeavyModpack : true,
    state: "created",
    createdAt: new Date().toISOString(),
    pid: null,
  };
  try {
    mkdirSync(resolveSafe(serverDir(record)), { recursive: true });
    if (body.acceptEula) {
      await writeEula(serverDir(record), true);
    }
  } catch {
    // best-effort folder creation
  }
  servers.set(id, record);
  persistServers();
  res.status(201).json(record);
});

/**
 * Ends a server process tree. Native docker: the CLI client is killed and removeContainer
 * issues `docker stop` for the container itself. WSL mode: the container runs inside the
 * distro, so taskkill only ends the wsl.exe launcher. Native Linux runc: the killed process
 * IS runc, so removeContainer reaps the bundle state. Either way the runc/docker state is
 * reaped separately to avoid a zombie container holding the port.
 */
function terminateContainer(serverId: string, child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  killTree(child, signal);
  removeContainer(serverId);
}

async function startServer(req: Request, res: Response): Promise<void> {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  if (record.state === "running") return fail(res, 409, "already_running", "server is already running");
  const isBedrock = record.serverType === "bedrock";
  // Java mode requires BOTH a provisioned JRE and an installed jar. This is the
  // most specific and most user-fixable blocker, so it is reported before the
  // generic runtime probe - otherwise a missing JRE would be masked by an
  // engine-level refusal and the caller would not know what to fix.
  const javaReady = isBedrock ? false : javaState(record.javaVersion).installed;
  if (!isBedrock && record.jarFile && !javaReady) {
    return fail(
      res,
      503,
      "java_not_installed",
      `java ${record.javaVersion} (${JAVA_PACKAGES[record.javaVersion]}) is not provisioned ${
        process.platform === "win32" ? "in the distro" : "on this host"
      }; POST /api/java first`,
    );
  }
  // Minecraft generates eula.txt on its first boot and then refuses to run until it
  // reads eula=true. A missing file means the game has not booted yet, so the first
  // start is allowed (it will create the file); an existing non-accepted file is
  // surfaced as an explicit EULA-required blocker instead of a silent early exit.
  if (!isBedrock && record.jarFile) {
    let eulaState = await readEula(serverDir(record));
    if (eulaState === "declined" && req.query.acceptEula === "true") {
      try {
        await writeEula(serverDir(record), true);
        eulaState = "accepted";
      } catch {}
    }
    if (eulaState === "declined") {
      return fail(
        res,
        409,
        "eula_required",
        'the Minecraft EULA is not accepted for this server; review https://aka.ms/MinecraftEULA then POST /api/servers/:id/eula with {"accepted":true} (the generated eula.txt stays in the server files)',
      );
    }
  }
  const probe = engine.probe();
  if (!probe.available) {
    // Honest failure: we never pretend the container started.
    return fail(res, 503, "engine_unavailable", probe.reason);
  }
  // The stored scriptRun is tokenised into argv here; a bare `java` resolves to the
  // provisioned JRE and the memory ceiling is injected unless the script sets -Xmx.
  let command: string[];
  try {
    command = buildContainerCommand(record, javaReady && Boolean(record.jarFile));
  } catch (err) {
    // The record holds an unusable command (e.g. legacy data): refuse honestly.
    return fail(res, 409, "invalid_script", err instanceof Error ? err.message : String(err));
  }
  let child: ChildProcess | null;
  try {
    child = engine.runContainer({
      id: record.id,
      image: process.env.MCM_SERVER_IMAGE ?? "itzg/minecraft-server",
      command,
      memoryMb: record.memoryMb,
      cpuCores: record.cpuCores,
      gamePort: record.gamePort,
      server: record,
    });
  } catch (err) {
    // Runtime detected but this exact request cannot be honoured (e.g. missing WSL
    // rootfs): report the real blocker instead of a fake success or a silent no-op.
    return fail(res, 503, "engine_unavailable", err instanceof Error ? err.message : String(err));
  }
  if (!child) return fail(res, 503, "engine_unavailable", "container runtime declined to start");
  processes.set(record.id, child);
  record.state = "running";
  record.pid = child.pid ?? null;
  persistServers();
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk: Buffer) =>
      emitConsole({ serverId: record.id, stream, line: chunk.toString().trimEnd(), at: new Date().toISOString() }),
    );
  }
  child.on("exit", (code) => {
    processes.delete(record.id);
    record.state = "stopped";
    record.pid = null;
    persistServers();
    removeContainer(record.id);
    emitConsole({
      serverId: record.id,
      stream: "system",
      line: `process exited with code ${code}`,
      at: new Date().toISOString(),
    });
  });
  res.json(record);
}

app.post("/api/servers/:id/start", requireAuth, startServer);

// EULA state is READ from the server's canonical eula.txt (server/<id>/eula.txt).
// The service never accepts the EULA on the operator's behalf: it only writes the
// file when the operator explicitly posts their decision here.
app.get("/api/servers/:id/eula", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const state = await readEula(serverDir(record));
  const body: EulaStatus = { serverId: record.id, state, required: Boolean(record.jarFile) && state !== "accepted" };
  res.json(body);
});

app.post("/api/servers/:id/eula", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const accepted = (req.body as SetEulaRequest | undefined)?.accepted;
  if (typeof accepted !== "boolean") return fail(res, 400, "invalid_request", "accepted must be a boolean");
  if (accepted && record.state === "running") {
    return fail(res, 409, "server_running", "stop the server before changing eula.txt");
  }
  try {
    await writeEula(serverDir(record), accepted);
  } catch (err) {
    if (guardTraversal(err, res)) return;
    return fail(res, 500, "write_failed", String(err));
  }
  const state = accepted ? "accepted" : "declined";
  const body: EulaStatus = { serverId: record.id, state, required: Boolean(record.jarFile) && !accepted };
  res.json(body);
});

function stopServer(req: Request, res: Response): void {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const child = processes.get(record.id);
  if (!child) return fail(res, 409, "not_running", "server has no running process");
  terminateContainer(record.id, child, "SIGTERM");
  processes.delete(record.id);
  record.state = "stopped";
  record.pid = null;
  persistServers();
  emitConsole({
    serverId: record.id,
    stream: "system",
    line: "stop signal sent",
    at: new Date().toISOString(),
  });
  res.json(record);
}

app.post("/api/servers/:id/stop", requireAuth, stopServer);

async function restartServer(req: Request, res: Response): Promise<void> {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const child = processes.get(record.id);
  if (child) {
    terminateContainer(record.id, child, "SIGTERM");
    processes.delete(record.id);
    record.state = "stopped";
    record.pid = null;
    persistServers();
  }
  return startServer(req, res);
}

app.post("/api/servers/:id/restart", requireAuth, restartServer);

function forceKillServer(req: Request, res: Response): void {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const child = processes.get(record.id);
  if (!child) return fail(res, 409, "not_running", "server has no running process");
  terminateContainer(record.id, child, "SIGKILL");
  processes.delete(record.id);
  record.state = "stopped";
  record.pid = null;
  persistServers();
  emitConsole({
    serverId: record.id,
    stream: "system",
    line: "force kill sent",
    at: new Date().toISOString(),
  });
  res.json(record);
}

app.post("/api/servers/:id/kill", requireAuth, forceKillServer);

// Resource limits: only editable while stopped, otherwise the live container and
// the stored record would silently disagree.
app.patch("/api/servers/:id", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  if (record.state === "running") {
    return fail(res, 409, "server_running", "stop the server before changing resource limits");
  }
  const body = (req.body ?? {}) as UpdateServerRequest;
  const memoryMb = parseMemoryMb(body.memoryMb);
  if (memoryMb === null) {
    return fail(res, 400, "invalid_request", `memoryMb must be an integer ${MIN_MEMORY_MB}-${MAX_MEMORY_MB}`);
  }
  const cpuCores = parseCores(body.cpuCores);
  if (cpuCores === null) return fail(res, 400, "invalid_request", `cpuCores must be an integer 1-${MAX_CORES}`);
  if (body.javaVersion !== undefined && !isJavaVersion(body.javaVersion)) {
    return fail(res, 400, "invalid_request", "javaVersion must be one of: 8, 17, 21");
  }
  const name = typeof body.name === "string" ? body.name.trim() : undefined;
  if (body.name !== undefined && !name) return fail(res, 400, "invalid_request", "name must not be empty");
  const gamePort = parsePort(body.gamePort);
  if (gamePort === null) return fail(res, 400, "invalid_request", "gamePort must be an integer 1-65535");
  if (body.scriptRun !== undefined) {
    const problem = scriptRunProblem(body.scriptRun);
    if (problem) return fail(res, 400, "invalid_script", problem);
  }
  if (body.optimizeHeavyModpack !== undefined && typeof body.optimizeHeavyModpack !== "boolean") {
    return fail(res, 400, "invalid_request", "optimizeHeavyModpack must be a boolean");
  }
  // Launch jar selection: the recorded name must be a real .jar already inside this server's
  // scoped dir. A pending legacy pick is canonicalised to server.jar once the update validates.
  const legacyJarName = typeof body.legacyJarName === "string" ? body.legacyJarName.trim() : undefined;
  if (body.legacyJarName !== undefined && legacyJarName) {
    const problem = jarProblemIn(record, legacyJarName);
    if (problem) return fail(res, 400, "invalid_jar", problem);
  }
  if (body.serverType !== undefined) {
    if (body.serverType !== "java" && body.serverType !== "bedrock") {
      return fail(res, 400, "invalid_request", "serverType must be java or bedrock");
    }
    record.serverType = body.serverType;
    if (body.serverType === "bedrock" && !record.jarFile) {
      record.jarFile = CANONICAL_BEDROCK_NAME;
    }
  }
  if (name !== undefined) record.name = name;
  if (gamePort !== undefined) record.gamePort = gamePort;
  if (memoryMb !== undefined) record.memoryMb = memoryMb;
  if (cpuCores !== undefined) record.cpuCores = cpuCores;
  if (body.javaVersion !== undefined) record.javaVersion = body.javaVersion;
  if (body.scriptRun !== undefined) record.scriptRun = (body.scriptRun as string).trim();
  if (typeof body.optimizeHeavyModpack === "boolean") record.optimizeHeavyModpack = body.optimizeHeavyModpack;
  if (legacyJarName) {
    // Adopt the picked jar as the launch core: rename it to the canonical name (when it is not
    // already) and record that name on the persisted record. A throwaway copy would leave
    // jarFile empty while the file on disk was renamed to server.jar.
    if (legacyJarName !== CANONICAL_JAR_NAME) {
      renameSync(resolveSafe(`${serverDir(record)}/${legacyJarName}`), resolveSafe(`${serverDir(record)}/${CANONICAL_JAR_NAME}`));
    }
    record.jarFile = CANONICAL_JAR_NAME;
  }
  persistServers();
  res.json(record);
});

// Metrics: a real `docker stats` sample (native) or a kernel procfs sample (wsl
// runc) when a container is alive, otherwise the declared limits tagged
// source:"declared" - never a fabricated usage figure. Storage bytes come from a
// cached directory walk plus a statfs of the volume holding the canonical root.
app.get("/api/servers/:id/metrics", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const metrics = await containerMetricsLive(record.id, record.memoryMb, record.cpuCores);
  const storage = await measureDir(serverDir(record));
  const statfs = await dataRootStatfs();
  res.json({
    ...metrics,
    storageUsedBytes: storage?.sizeBytes ?? null,
    storageFiles: storage?.files ?? null,
    storageFreeBytes: statfs?.freeBytes ?? null,
    storageTotalBytes: statfs?.totalBytes ?? null,
    storageSource: storage ? "walk" : statfs ? "statfs" : null,
  });
});

// --- Player & World management (honest, console/file-backed) -----------------
// No RCON/query protocol exists in this build. Online players are obtained by
// sending the game's own fixed `list` command and parsing its console output;
// ops/whitelist/world folders are read from the server's canonical files. Chunks
// and entity counts have no source and are reported null rather than guessed.

/** How long `GET /players` waits for the `list` reply before giving up honestly. */
const PLAYER_LIST_TIMEOUT_MS = 1500;
const PLAYER_LIST_POLL_MS = 100;

/**
 * Writes one already-validated console line to a live process stdin; returns false
 * when the server is stopped so the caller can answer 409 instead of pretending the
 * command ran. Only `planPlayerAction` output or a fixed literal ever reaches here,
 * so no operator-supplied string is passed through unvalidated.
 */
function sendCommand(serverId: string, line: string): boolean {
  const child = processes.get(serverId);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
  return true;
}

/**
 * Sends the fixed `list` command and waits for a NEW player-report line to appear in
 * the console buffer. Returns the parsed report plus the raw line; a timeout yields
 * nulls (never an invented count).
 */
async function requestPlayerList(
  serverId: string,
): Promise<{ raw: string | null; parsed: ReturnType<typeof parseListLine> }> {
  const matching = () => (consoleBuffers.get(serverId) ?? []).filter((evt) => parseListLine(evt.line) !== null);
  const before = matching().length;
  if (!sendCommand(serverId, "list")) return { raw: null, parsed: null };
  const deadline = Date.now() + PLAYER_LIST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PLAYER_LIST_POLL_MS));
    const matches = matching();
    if (matches.length > before) {
      const line = matches[matches.length - 1].line;
      return { raw: line, parsed: parseListLine(line) };
    }
  }
  return { raw: null, parsed: null };
}

app.get("/api/servers/:id/players", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const dir = serverDir(record);
  const ops = readJsonNameList(resolveSafe(`${dir}/ops.json`));
  // Bedrock writes its allow list to allowlist.json; prefer it when present so the
  // same file the /world view reports is the one used for the whitelisted flag.
  const whitelistFile = existsSync(resolveSafe(`${dir}/allowlist.json`))
    ? `${dir}/allowlist.json`
    : `${dir}/${WHITELIST_FILE}`;
  const whitelist = readJsonNameList(resolveSafe(whitelistFile));
  const running = record.state === "running" && Boolean(processes.get(record.id)?.stdin?.writable);
  let raw: string | null = null;
  let parsed: ReturnType<typeof parseListLine> = null;
  if (running) {
    const probe = await requestPlayerList(record.id);
    raw = probe.raw;
    parsed = probe.parsed;
  }
  // Live console names win; when `list` produced nothing, fall back to the names
  // actually on disk so the view is still honest about who exists.
  const names = parsed?.names.length ? parsed.names : [...new Set([...ops, ...whitelist])];
  const source: PlayerListResult["source"] = parsed ? "console" : names.length ? "files" : "none";
  const players: PlayerRef[] = names.map((name) => ({
    name,
    source: parsed ? "console" : ops.includes(name) ? "ops" : "whitelist",
    op: ops.includes(name),
    whitelisted: whitelist.includes(name),
  }));
  const body: PlayerListResult = {
    serverId: record.id,
    running,
    source,
    players,
    onlineCount: parsed?.onlineCount ?? null,
    maxPlayers: parsed?.maxPlayers ?? null,
    raw,
    ...(running ? {} : { reason: "server is stopped; only ops.json/whitelist.json names are shown" }),
  };
  res.json(body);
});

app.post("/api/servers/:id/players/action", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const body = (req.body ?? {}) as PlayerActionRequest;
  const plan = planPlayerAction(body);
  if ("error" in plan) return fail(res, 400, "invalid_request", plan.error);
  if (!sendCommand(record.id, plan.command)) {
    return fail(res, 409, "server_stopped", "start the server before sending player commands");
  }
  const result: PlayerActionResult = {
    serverId: record.id,
    action: body.action as PlayerAction,
    command: plan.command,
    delivered: true,
  };
  res.json(result);
});

/**
 * Counts live chunks in one dimension by summing the non-zero entries of every
 * region file's 4096-byte header (1024 x 4-byte location slots; zero == absent).
 * Returns null when the region folder or its files cannot be read, so callers
 * report chunks as unknown instead of guessing.
 */
function countRegionChunks(regionDirAbs: string): number | null {
  let regionFiles: string[];
  try {
    regionFiles = readdirSync(regionDirAbs).filter((name) => name.endsWith(".mca"));
  } catch {
    return null;
  }
  if (!regionFiles.length) return null;
  let chunks = 0;
  let readable = false;
  const header = Buffer.alloc(4096);
  for (const name of regionFiles) {
    let fd: number | null = null;
    try {
      fd = openSync(path.join(regionDirAbs, name), "r");
      const read = readSync(fd, header, 0, header.length, 0);
      for (let off = 0; off + 4 <= read; off += 4) {
        if (header.readUInt32BE(off) !== 0) chunks += 1;
      }
      readable = true;
    } catch {
      // unreadable region file: skip it, keep the rest
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  return readable ? chunks : null;
}

/** True when a directory name looks like a world/dimension folder for this level. */
function isWorldFolder(name: string, levelName: string | null): boolean {
  if (levelName && (name === levelName || name === `${levelName}_nether` || name === `${levelName}_the_end`)) return true;
  return /^world(_nether|_the_end)?$/.test(name);
}

const DIMENSION_LABELS: Record<string, string> = {
  world: "Overworld",
  world_nether: "Nether",
  world_the_end: "The End",
};

app.get("/api/servers/:id/world", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const dir = serverDir(record);
  const props = readProperties(resolveSafe(`${dir}/server.properties`));
  const isBedrock = record.serverType === "bedrock";
  const levelName = props["level-name"] ?? (isBedrock ? "Bedrock level" : null);

  const searchBaseRel = isBedrock
    ? (existsSync(resolveSafe(`${dir}/worlds`)) ? `${dir}/worlds` : existsSync(resolveSafe(`${dir}/world`)) ? `${dir}/world` : dir)
    : dir;
  const searchBaseAbs = resolveSafe(searchBaseRel);

  let names: string[] = [];
  try {
    if (existsSync(searchBaseAbs)) {
      names = readdirSync(searchBaseAbs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    }
  } catch {
    names = [];
  }
  const dimensions: WorldDimension[] = [];
  for (const name of names) {
    // Only real subdirectories that resolve back into this server's scope are read.
    if (!isWorldFolder(name, levelName)) continue;
    const summary = summarizeDir(resolveSafe(`${searchBaseRel}/${name}`));
    const chunks = countRegionChunks(resolveSafe(`${searchBaseRel}/${name}/region`));
    dimensions.push({
      id: name,
      label: isBedrock ? (name === levelName ? "Bedrock World" : name) : (DIMENSION_LABELS[name] ?? name),
      directory: isBedrock ? (searchBaseRel === dir ? name : `${path.basename(searchBaseRel)}/${name}`) : name,
      sizeBytes: summary.sizeBytes,
      files: summary.files,
      modifiedAt: summary.modifiedAt,
      chunks,
      chunksSource: chunks === null ? null : "region-header",
    });
  }
  // Newest dimension mtime stands in for the last on-disk save; null when no world
  // folder was found. Live autosave interval needs the running server, so it stays null.
  const lastSaveAt = dimensions.reduce<string | null>(
    (acc, dim) => (dim.modifiedAt && (!acc || dim.modifiedAt > acc) ? dim.modifiedAt : acc),
    null,
  );
  const autosaveIntervalSeconds: number | null = null;
  const opsFile = existsSync(resolveSafe(`${dir}/permissions.json`)) ? `${dir}/permissions.json` : `${dir}/ops.json`;
  const whitelistFile = existsSync(resolveSafe(`${dir}/allowlist.json`)) ? `${dir}/allowlist.json` : `${dir}/whitelist.json`;
  const ops = readJsonNameList(resolveSafe(opsFile));
  const whitelist = readJsonNameList(resolveSafe(whitelistFile));
  const hasProps = Object.keys(props).length > 0;
  const body: WorldStateResult = {
    serverId: record.id,
    levelName,
    difficulty: props["difficulty"] ?? null,
    gamemode: props["gamemode"] ?? null,
    maxPlayers: props["max-players"] !== undefined ? Number(props["max-players"]) : null,
    whitelistEnabled:
      props["white-list"] !== undefined
        ? props["white-list"] === "true"
        : props["whitelist"] !== undefined
          ? props["whitelist"] === "true"
          : null,
    dimensions,
    ops,
    whitelist,
    source: hasProps || dimensions.length || ops.length || whitelist.length ? "files" : "none",
    lastSaveAt,
    lastSaveSource: lastSaveAt ? "disk-mtime" : null,
    autosaveIntervalSeconds,
    ...(hasProps ? {} : { reason: "server.properties not found; only files present on disk are reported" }),
  };
  res.json(body);
});

// --- Server properties (editable core of server.properties) ------------------
/**
 * Resolves the editable core into a typed view, applying Minecraft's own defaults
 * so the panel always has a real value even before the game has written the file.
 */
function propertiesView(record: ServerRecord, props: Record<string, string>): ServerPropertiesView {
  const { values, present } = resolveServerProperties(props);
  return {
    serverId: record.id,
    source: present ? "file" : "defaults",
    ...values,
    gamemode: values.gamemode as ServerPropertiesView["gamemode"],
    difficulty: values.difficulty as ServerPropertiesView["difficulty"],
    cracked: !values.onlineMode,
    knownKeys: Object.values(SERVER_PROPERTY_KEYS).filter((propertyKey) =>
      propertyKey === "white-list"
        ? props["white-list"] !== undefined || props["whitelist"] !== undefined
        : props[propertyKey] !== undefined,
    ),
    ...(present
      ? {}
      : { reason: "server.properties not found; showing Minecraft defaults until the server first starts" }),
  };
}

// Read-only. A missing file is not an error: defaults are returned with source:"defaults".
app.get("/api/servers/:id/properties", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const props = readProperties(resolveSafe(`${serverDir(record)}/server.properties`));
  res.json(propertiesView(record, props));
});

// Editable only while stopped: the live JVM rewrites server.properties on stop and
// would clobber the edit. Only the twelve core fields are accepted (strict allow-list),
// values are written as file bytes through resolveSafe (never shell-interpolated),
// comments/unknown keys are preserved, and the write is temp-file + rename atomic.
app.patch("/api/servers/:id/properties", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  if (record.state === "running" || processes.has(record.id)) {
    return fail(res, 409, "server_running", "stop the server before editing server.properties");
  }
  const body = (req.body ?? {}) as ServerPropertiesPatch & Record<string, unknown>;
  const plan = planPropertiesPatch(body);
  if ("error" in plan) return fail(res, 400, "invalid_request", plan.error);
  const abs = resolveSafe(`${serverDir(record)}/server.properties`);
  const before = readProperties(abs);
  const changed = plan.writes.filter((write) => before[write.key] !== write.value).map((write) => write.key);
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
    writePropertiesAtomic(abs, mergeProperties(readPropertiesText(abs), plan.writes));
  } catch (err) {
    return fail(res, 500, "properties_write_failed", String(err));
  }
  const result: ServerPropertiesUpdateResult = {
    serverId: record.id,
    properties: propertiesView(record, readProperties(abs)),
    changed,
  };
  res.json(result);
});

/**
 * Resolves the world folder name strictly from `server.properties` key `level-name`.
 * Falls back to "world" (Java) or "Bedrock level" (Bedrock) when property is absent or empty.
 */
function serverWorldName(record: ServerRecord): string {
  const dir = serverDir(record);
  const props = readProperties(resolveSafe(`${dir}/server.properties`));
  const raw = props["level-name"]?.trim();
  const fallback = record.serverType === "bedrock" ? "Bedrock level" : "world";
  if (!raw) return fallback;
  const unquoted = raw.replace(/^["']|["']$/g, "").trim();
  return path.basename(unquoted) || fallback;
}

/**
 * Relative path to the server's world folder under DATA_ROOT.
 * - Java Edition: `server/<id>/<level-name>`
 * - Bedrock Edition: `server/<id>/worlds/<level-name>` (or fallback to `world/<level-name>` or `<level-name>`)
 */
function serverWorldRel(record: ServerRecord): string {
  const dir = serverDir(record);
  const levelName = serverWorldName(record);
  if (record.serverType === "bedrock") {
    if (existsSync(resolveSafe(`${dir}/worlds/${levelName}`))) {
      return `${dir}/worlds/${levelName}`;
    }
    if (existsSync(resolveSafe(`${dir}/world/${levelName}`))) {
      return `${dir}/world/${levelName}`;
    }
    if (existsSync(resolveSafe(`${dir}/${levelName}`))) {
      return `${dir}/${levelName}`;
    }
    return `${dir}/worlds/${levelName}`;
  }
  return `${dir}/${levelName}`;
}

/**
 * Absolute path of a server's `level.dat`.
 * - Java Edition: `server/<id>/<level-name>/level.dat`
 * - Bedrock Edition: `server/<id>/worlds/<level-name>/level.dat`
 */
function levelDatPath(record: ServerRecord): string {
  const worldRel = serverWorldRel(record);
  return resolveSafe(`${worldRel}/level.dat`);
}

// --- Gamerules (vanilla Java Edition, stored in level.dat) -------------------
/**
 * Resolves the world's gamerules from `level.dat`. A missing file is not
 * an error: the full catalog is returned with vanilla defaults and source:"defaults".
 * For Bedrock Edition, reports file presence without crashing on LevelDB format.
 */
function gamerulesView(record: ServerRecord, levelDatPath: string): GamerulesView {
  const levelName = serverWorldName(record);
  const worldRel = serverWorldRel(record);
  const worldAbs = resolveSafe(worldRel);
  const worldExists = existsSync(worldAbs);
  const isBedrock = record.serverType === "bedrock";
  const displayWorldPath = worldRel.replace(`${serverDir(record)}/`, "");

  if (isBedrock) {
    const rules = readBedrockGamerules(levelDatPath);
    return {
      serverId: record.id,
      source: worldExists ? "file" : "defaults",
      levelName,
      worldPath: displayWorldPath,
      serverType: "bedrock",
      rules,
      reason: worldExists ? undefined : `world folder not found at ${sanitizePath(worldRel)}`,
    };
  }

  try {
    const { rules } = readGamerules(levelDatPath);
    return {
      serverId: record.id,
      source: "file",
      levelName,
      worldPath: displayWorldPath,
      serverType: "java",
      rules,
    };
  } catch (err) {
    return {
      serverId: record.id,
      source: "defaults",
      levelName,
      worldPath: displayWorldPath,
      serverType: "java",
      rules: readGamerulesDefaults(),
      reason: err instanceof NbtError ? `level.dat not readable (${err.message}); showing vanilla defaults` : undefined,
    };
  }
}

let cachedPublicIpv4: string | null = null;
let lastPublicFetch = 0;
let cachedPublicIpv6: string | null = null;
let lastPublicIpv6Fetch = 0;
let isFetchingPublicIpv4 = false;

async function getPublicIpv4(): Promise<string | null> {
  const now = Date.now();
  if (cachedPublicIpv4 && now - lastPublicFetch < 600000) {
    return cachedPublicIpv4;
  }
  if (isFetchingPublicIpv4) {
    return cachedPublicIpv4;
  }
  isFetchingPublicIpv4 = true;
  lastPublicFetch = now;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch("https://api.ipify.org?format=json", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { ip?: string };
      if (typeof data.ip === "string" && data.ip) {
        cachedPublicIpv4 = data.ip;
        return data.ip;
      }
    }
  } catch {
    // offline or blocked, fallback
  } finally {
    isFetchingPublicIpv4 = false;
  }
  return cachedPublicIpv4;
}

async function getPublicIpv6(): Promise<string | null> {
  const now = Date.now();
  if (cachedPublicIpv6 && now - lastPublicIpv6Fetch < 600000) {
    return cachedPublicIpv6;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const res = await fetch("https://api64.ipify.org?format=json", { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { ip?: string };
      if (typeof data.ip === "string" && data.ip.includes(":")) {
        cachedPublicIpv6 = data.ip;
        lastPublicIpv6Fetch = now;
        return data.ip;
      }
    }
  } catch {
    // offline or blocked, fallback
  }
  return cachedPublicIpv6;
}

function detectNetworkAddresses() {
  const nets = os.networkInterfaces();
  const allIpv4: string[] = [];
  const allIpv6: string[] = [];
  let primaryIpv4: string | null = null;
  let primaryIpv6: string | null = null;
  let primaryIpv6IsPerm = false;
  let vpnIpv4: string | null = null;

  for (const [name, list] of Object.entries(nets)) {
    if (!list) continue;
    const isVpnIface =
      name.toLowerCase().includes("tailscale") ||
      name.toLowerCase().includes("zerotier") ||
      name.toLowerCase().includes("hamachi") ||
      name.toLowerCase().includes("radmin");

    for (const net of list) {
      if (net.internal) continue;
      const famStr = String((net as { family?: string | number }).family ?? "");
      const isIpv4 = famStr === "IPv4" || famStr === "4";
      const isIpv6 = famStr === "IPv6" || famStr === "6";
      const addr = net.address;

      if (isIpv4) {
        // Discard unassigned APIPA / link-local IPv4
        if (addr.startsWith("169.254.")) continue;
        if (!allIpv4.includes(addr)) allIpv4.push(addr);
        if (isVpnIface || addr.startsWith("100.") || addr.startsWith("25.") || addr.startsWith("26.")) {
          if (!vpnIpv4 && (addr.startsWith("100.") || addr.startsWith("25.") || addr.startsWith("26.") || !addr.startsWith("169.254."))) {
            vpnIpv4 = addr;
          }
        } else if (!primaryIpv4 && (addr.startsWith("192.168.") || addr.startsWith("10.") || addr.startsWith("172."))) {
          primaryIpv4 = addr;
        }
      } else if (isIpv6) {
        if (!allIpv6.includes(addr)) allIpv6.push(addr);
        // Identify global unicast IPv6 (starts with 2xxx or 3xxx, not fe80, fd, fc)
        const isGlobal =
          (addr.startsWith("2") || addr.startsWith("3")) &&
          !addr.startsWith("fe80:") &&
          !addr.startsWith("fd") &&
          !addr.startsWith("fc");
        // In Windows, permanent NIC address is /64, while temporary privacy addresses are /128
        const isPermanent =
          Boolean(net.cidr?.endsWith("/64")) ||
          (Boolean(net.netmask) && net.netmask !== "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");

        if (isGlobal && !isVpnIface) {
          if (!primaryIpv6 || (isPermanent && !primaryIpv6IsPerm)) {
            primaryIpv6 = addr;
            primaryIpv6IsPerm = isPermanent;
          }
        }
      }
    }
  }

  if (!primaryIpv4 && allIpv4.length > 0) {
    primaryIpv4 = allIpv4.find((a) => a !== vpnIpv4) ?? allIpv4[0];
  }
  if (!primaryIpv6 && allIpv6.length > 0) {
    primaryIpv6 =
      allIpv6.find((a) => (a.startsWith("2") || a.startsWith("3")) && !a.startsWith("fe80:") && !a.startsWith("fd")) ??
      allIpv6[0];
  }

  return { allIpv4, allIpv6, primaryIpv4, primaryIpv6, vpnIpv4 };
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  while (true) {
    if ((value & ~0x7f) === 0) {
      bytes.push(value);
      return Buffer.from(bytes);
    }
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
}

function readVarInt(buffer: Buffer, offset = 0): { value: number; length: number } {
  let value = 0;
  let length = 0;
  let currentByte: number;
  while (true) {
    if (offset + length >= buffer.length) break;
    currentByte = buffer[offset + length];
    value |= (currentByte & 0x7f) << (length * 7);
    length++;
    if ((currentByte & 0x80) !== 0x80) break;
  }
  return { value, length };
}

interface MinecraftPingResult {
  ready: boolean;
  players?: { online: number; max: number } | null;
  version?: string | null;
  motd?: string | null;
}

function checkTcpPort(port: number, host: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

function pingMinecraftSingle(port: number, host: string, timeoutMs = 600): Promise<MinecraftPingResult> {
  return new Promise<MinecraftPingResult>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let dataBuffer = Buffer.alloc(0);

    const finish = (result: MinecraftPingResult) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };

    let connectedTcp = false;
    socket.setTimeout(timeoutMs);
    socket.once("error", () => finish({ ready: connectedTcp }));
    socket.once("timeout", () => finish({ ready: connectedTcp }));

    socket.connect(port, host, () => {
      connectedTcp = true;
      try {
        const hostBuf = Buffer.from(host, "utf8");
        const handshakePayload = Buffer.concat([
          Buffer.from([0x00]), // Packet ID 0: Handshake
          writeVarInt(765),    // Protocol version
          writeVarInt(hostBuf.length),
          hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          writeVarInt(1),      // Next state: Status (1)
        ]);
        const handshakePacket = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload]);
        const requestPacket = Buffer.from([0x01, 0x00]); // Request Packet (Len 1, ID 0)
        socket.write(Buffer.concat([handshakePacket, requestPacket]));
      } catch {
        finish({ ready: true });
      }
    });

    socket.on("data", (chunk) => {
      dataBuffer = Buffer.concat([dataBuffer, chunk]);
      try {
        if (dataBuffer.length < 5) return;
        const pktLen = readVarInt(dataBuffer, 0);
        let offset = pktLen.length;
        const pktId = readVarInt(dataBuffer, offset);
        offset += pktId.length;
        if (pktId.value === 0x00) {
          const strLen = readVarInt(dataBuffer, offset);
          offset += strLen.length;
          const jsonBytes = dataBuffer.slice(offset, offset + strLen.value);
          if (jsonBytes.length >= strLen.value) {
            const json = JSON.parse(jsonBytes.toString("utf8"));
            const motd =
              typeof json.description === "string"
                ? json.description
                : json.description?.text ?? null;
            finish({
              ready: true,
              players: json.players
                ? { online: Number(json.players.online ?? 0), max: Number(json.players.max ?? 0) }
                : null,
              version: json.version?.name ?? null,
              motd,
            });
          }
        }
      } catch {
        finish({ ready: true });
      }
    });
  });
}

async function pingMinecraftServer(port: number, hosts = ["127.0.0.1", "::1"]): Promise<MinecraftPingResult> {
  const promises = hosts.map((h) => pingMinecraftSingle(port, h, 600));
  const results = await Promise.all(promises);
  return results.find((r) => r.ready) ?? { ready: false };
}

function pingRakNetSingle(port: number, host: string, timeoutMs = 350): Promise<MinecraftPingResult> {
  return new Promise<MinecraftPingResult>((resolve) => {
    const isV6 = net.isIPv6(host);
    const socket = dgram.createSocket(isV6 ? "udp6" : "udp4");
    let settled = false;

    const finish = (result: MinecraftPingResult) => {
      if (!settled) {
        settled = true;
        try {
          socket.close();
        } catch {}
        resolve(result);
      }
    };

    const timer = setTimeout(() => finish({ ready: false }), timeoutMs);
    socket.once("error", () => finish({ ready: false }));

    socket.on("message", (msg) => {
      try {
        if (msg.length > 35 && msg[0] === 0x1c) {
          const strLen = msg.readUInt16BE(33);
          const dataStr = msg.toString("utf8", 35, 35 + strLen);
          const parts = dataStr.split(";");
          clearTimeout(timer);
          finish({
            ready: true,
            motd: parts[1] || "",
            version: parts[3] || "",
            players: {
              online: Number.parseInt(parts[4] || "0", 10),
              max: Number.parseInt(parts[5] || "0", 10),
            },
          });
          return;
        }
      } catch {}
      clearTimeout(timer);
      finish({ ready: true });
    });

    const magic = Buffer.from("00ffff00fefefefefdfdfdfd12345678", "hex");
    const packet = Buffer.alloc(1 + 8 + 16 + 8);
    packet.writeUInt8(0x01, 0);
    packet.writeBigInt64BE(BigInt(Date.now()), 1);
    magic.copy(packet, 9);
    packet.writeBigInt64BE(BigInt(2), 25);

    socket.send(packet, port, host, (err) => {
      if (err) finish({ ready: false });
    });
  });
}

async function pingBedrockServer(port: number, hosts = ["127.0.0.1", "::1"]): Promise<MinecraftPingResult> {
  // Parallel TCP check (for NetherNet transport which listens on TCP) + RakNet UDP check
  const tcpPromises = hosts.map((h) => checkTcpPort(port, h, 300));
  const raknetPromises = hosts.map((h) => pingRakNetSingle(port, h, 350));

  const [tcpResults, raknetResults] = await Promise.all([
    Promise.all(tcpPromises),
    Promise.all(raknetPromises),
  ]);

  const raknetSuccess = raknetResults.find((r) => r.ready);
  if (raknetSuccess) return raknetSuccess;

  if (tcpResults.some(Boolean)) {
    return { ready: true };
  }
  return { ready: false };
}

// Server Network & IP Addresses with True Minecraft Online Status
app.get("/api/servers/:id/network", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const { allIpv4, allIpv6, primaryIpv4, primaryIpv6, vpnIpv4 } = detectNetworkAddresses();
  const publicIpv4 = await getPublicIpv4();

  const isRunning = record.state === "running";
  let ready = false;
  let players: { online: number; max: number } | null = null;
  let version: string | null = null;
  let motd: string | null = null;

  if (isRunning) {
    const probeHosts = ["127.0.0.1", "::1"];
    if (primaryIpv4 && !probeHosts.includes(primaryIpv4)) probeHosts.push(primaryIpv4);
    const ping = record.serverType === "bedrock"
      ? await pingBedrockServer(record.gamePort, probeHosts)
      : await pingMinecraftServer(record.gamePort, probeHosts);
    ready = ping.ready;
    players = ping.players ?? null;
    version = ping.version ?? null;
    motd = ping.motd ?? null;
  }

  const status: "ready" | "starting" | "offline" = !isRunning
    ? "offline"
    : ready
      ? "ready"
      : "starting";

  res.json({
    online: isRunning,
    ready,
    status,
    gamePort: record.gamePort,
    primaryIpv4,
    primaryIpv6,
    vpnIpv4,
    publicIpv4,
    isCgnat: true,
    allIpv4,
    allIpv6,
    players,
    version,
    motd,
  });
});

// Read-only. A missing level.dat is not an error: defaults are returned.
app.get("/api/servers/:id/gamerules", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const levelDat = levelDatPath(record);
  res.json(gamerulesView(record, levelDat));
});

// Editable only while stopped: the live JVM rewrites level.dat on save and would
// clobber the edit. Only known vanilla gamerule names are accepted (strict
// allow-list), values are validated by type/range, and the write goes through the
// lossless NBT layer (temp-file + rename atomic) so unrelated world tags survive.
app.patch("/api/servers/:id/gamerules", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const isBedrock = record.serverType === "bedrock";

  // Editable only while stopped for Java (JVM rewrites level.dat on stop)
  if (!isBedrock && (record.state === "running" || processes.has(record.id))) {
    return fail(res, 409, "server_running", "stop the server before editing gamerules");
  }

  const body = (req.body ?? {}) as GamerulesPatch & Record<string, unknown>;
  const levelDat = levelDatPath(record);

  if (isBedrock) {
    const writes: Record<string, boolean | number> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "boolean" || typeof v === "number") {
        writes[k.toLowerCase()] = v;
      }
    }
    // If Bedrock server is running, dispatch live console commands
    if (record.state === "running" || processes.has(record.id)) {
      for (const [name, val] of Object.entries(writes)) {
        sendCommand(record.id, `gamerule ${name} ${val}`);
      }
    }
    // Also patch level.dat on disk atomically
    let changed: string[] = [];
    try {
      changed = patchBedrockGamerules(levelDat, writes);
    } catch (err) {
      if (record.state !== "running") {
        return fail(res, 500, "gamerules_write_failed", String(err));
      }
    }
    const result: GamerulesUpdateResult = {
      serverId: record.id,
      gamerules: gamerulesView(record, levelDat),
      changed: changed.length > 0 ? changed : Object.keys(writes),
    };
    return res.json(result);
  }

  const plan = planGamerulesPatch(body);
  if ("error" in plan) return fail(res, 400, "invalid_request", plan.error);
  let changed: string[];
  try {
    changed = patchGamerules(levelDat, plan.writes);
  } catch (err) {
    if (err instanceof NbtError) return fail(res, 400, "level_dat_invalid", err.message);
    return fail(res, 500, "gamerules_write_failed", String(err));
  }
  const result: GamerulesUpdateResult = {
    serverId: record.id,
    gamerules: gamerulesView(record, levelDat),
    changed,
  };
  res.json(result);
});

app.post("/api/servers/:id/world/flush", requireAuth, (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  // save-all writes live world state to disk: require the operator to echo the id
  // so a stray click can never trigger a flush.
  const confirm = String((req.body as { confirm?: unknown } | undefined)?.confirm ?? "");
  if (confirm !== record.id) {
    return fail(res, 400, "confirmation_required", `resend with {"confirm":"${record.id}"} to flush ${record.id}`);
  }
  if (!sendCommand(record.id, "save-all flush")) {
    return fail(res, 409, "server_stopped", "start the server before flushing world saves");
  }
  const body: FlushResult = { serverId: record.id, command: "save-all flush", delivered: true };
  res.json(body);
});

// Streams the world folder as a zip archive
app.get("/api/servers/:id/world/download", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const levelName = serverWorldName(record);
  const worldRel = serverWorldRel(record);
  const worldAbs = resolveSafe(worldRel);
  if (!existsSync(worldAbs)) {
    return fail(res, 404, "no_world", `world folder '${levelName}' does not exist on disk at ${sanitizePath(worldAbs)}`);
  }
  const stat = statSync(worldAbs);
  if (!stat.isDirectory()) {
    return fail(res, 400, "invalid_world", `world path '${levelName}' is not a directory`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${levelName}-${stamp}.zip"`);
  const stream = createZipStream(walkZipEntries(worldAbs, levelName));
  stream.on("error", (err: unknown) => {
    console.error("[world] zip export failed:", err);
    if (!res.headersSent) fail(res, 500, "zip_failed", "failed to build world archive");
    else res.destroy();
  });
  stream.pipe(res);
});

// Deletes the server's world folder completely
app.delete("/api/servers/:id/world", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  if (record.state === "running") {
    return fail(res, 409, "server_running", "stop the server before deleting the world");
  }
  const levelName = serverWorldName(record);
  const worldRel = serverWorldRel(record);
  const worldAbs = resolveSafe(worldRel);
  if (existsSync(worldAbs)) {
    await fs.rm(worldAbs, { recursive: true, force: true });
  }
  res.json({ deleted: true, levelName });
});

// Extracts an uploaded archive into the server's world directory, auto-flattening any top-level folder
app.post("/api/servers/:id/world/import", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  if (record.state === "running") {
    return fail(res, 409, "server_running", "stop the server before importing a world");
  }
  const body = (req.body ?? {}) as { archivePath?: string };
  const archiveRel = typeof body.archivePath === "string" ? body.archivePath : "";
  if (!archiveRel) return fail(res, 400, "invalid_request", "archivePath is required");
  const dir = serverDir(record);
  assertWithinScope(dir, archiveRel);

  const levelName = serverWorldName(record);
  const destDirRel = serverWorldRel(record);
  const destDirAbs = resolveSafe(destDirRel);

  let archive;
  try {
    archive = await openArchive(archiveRel);
  } catch (err) {
    if (err instanceof ArchiveFormatError) return fail(res, 400, "unsupported_archive", err.message);
    return fail(res, 500, "open_archive_failed", String(err));
  }

  try {
    // Detect if world files are wrapped in a root folder (e.g. "world/level.dat", "worlds/MyMap/level.dat", "MyMap/level.dat") or at root ("level.dat")
    let prefix = "";
    for (const entry of archive.entries) {
      const normalized = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
      if (
        normalized.toLowerCase().endsWith("level.dat") ||
        normalized.toLowerCase().endsWith("levelname.txt")
      ) {
        const parts = normalized.split("/");
        if (parts.length > 1) {
          prefix = parts.slice(0, -1).join("/") + "/";
        }
        break;
      }
    }

    // Recreate destination directory cleanly
    if (existsSync(destDirAbs)) {
      await fs.rm(destDirAbs, { recursive: true, force: true });
    }
    await fs.mkdir(destDirAbs, { recursive: true });

    // Extract entries into world directory
    for (const entry of archive.entries) {
      let rawName = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
      if (prefix && rawName.startsWith(prefix)) {
        rawName = rawName.slice(prefix.length);
      }
      if (!rawName || rawName === "." || rawName.includes("..")) continue;

      const outAbs = path.join(destDirAbs, rawName);
      if (entry.dir) {
        await fs.mkdir(outAbs, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(outAbs), { recursive: true });
      const data = await entry.read();
      await fs.writeFile(outAbs, data);
    }

    await archive.close();

    // Clean up temporary archive file
    try {
      await fs.rm(resolveSafe(archiveRel), { force: true });
    } catch {
      // best-effort
    }

    res.json({ imported: true, levelName });
  } catch (err) {
    await archive.close().catch(() => {});
    return fail(res, 500, "world_import_failed", String(err));
  }
});

// Delete: destructive. Requires auth plus an explicit confirm matching the id, so
// a mistyped or replayed request can never delete a server silently.
app.delete("/api/servers/:id", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const confirm = String(req.query.confirm ?? req.header("x-mcm-confirm") ?? "");
  if (confirm !== record.id) {
    return fail(res, 400, "confirmation_required", `resend with ?confirm=${record.id} to delete ${record.id}`);
  }
  const child = processes.get(record.id);
  if (child) {
    killTree(child, "SIGTERM");
    processes.delete(record.id);
  }
  try {
    const dataRemoved = await removeIfExists(record.id);
    servers.delete(record.id);
    consoleBuffers.delete(record.id);
    persistServers();
    res.json({ deleted: true, id: record.id, stoppedProcess: Boolean(child), dataRemoved });
  } catch (err) {
    fail(res, 500, "delete_failed", String(err));
  }
});

// --- Canonical storage status (external root retired) ------------------------
// Storage is single-rooted container-side, so the host-folder browse bridge and the
// data-root pin are gone: no request can point a server's files at a PC/external folder.
// GET /api/storage is a READ-ONLY diagnostic reporting the canonical root, whether it is
// the distro filesystem, and a migration dry-run for records still stored on the PC.
app.get("/api/storage", requireAuth, async (_req, res) => {
  try {
    res.json(await migrationStatus());
  } catch (err) {
    fail(res, 500, "storage_status_failed", String(err));
  }
});

// Files
function guardTraversal(err: unknown, res: Response): boolean {
  if (err instanceof PathTraversalError) {
    fail(res, 400, "path_traversal", err.message);
    return true;
  }
  return false;
}

/**
 * Optional server scope: when the client declares `?server=<id>` (or `?scope=<id>`)
 * every file path it sends must stay inside `server/<id>`, so the Manage view
 * cannot reach a sibling server's directory. Absent the query the standalone
 * Files view keeps its unscoped root. Returns the scope, `undefined` when
 * unscoped, or an error string when the id is unknown (never resolved from a
 * client-supplied path). `keys` lets the upload route exclude `server`, which it
 * already uses for the canonical-jar target.
 */
function serverScope(req: Request, keys: readonly string[] = ["server", "scope"]): string | undefined | "error" {
  for (const key of keys) {
    const raw = req.query[key];
    if (raw === undefined || raw === "") continue;
    const record = servers.get(String(raw));
    if (!record) return "error";
    return serverDir(record);
  }
  return undefined;
}

app.get("/api/files", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? ".");
    if (scope) assertWithinScope(scope, relPath);
    res.json(await listDir(relPath));
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "read_failed", String(err));
  }
});

app.get("/api/files/content", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (scope) assertWithinScope(scope, relPath);
    res.json({ path: relPath, content: await readFileText(relPath) });
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "read_failed", String(err));
  }
});

app.put("/api/files/content", requireAuth, async (req, res) => {
  try {
    const { path: relPath, content } = req.body as { path: string; content: string };
    if (typeof relPath !== "string" || typeof content !== "string") {
      return fail(res, 400, "invalid_request", "path and content must be strings");
    }
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    if (scope) assertWithinScope(scope, relPath);
    await writeFileText(relPath, content);
    res.json({ path: relPath, bytes: Buffer.byteLength(content) });
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "write_failed", String(err));
  }
});

app.delete("/api/files", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (scope) assertWithinScope(scope, relPath);
    await deleteEntry(relPath);
    res.json({ deleted: true });
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "delete_failed", String(err));
  }
});

// Rename/move one entry inside the managed root. Both paths are traversal-checked
// and the target must not already exist, so a rename can never silently clobber.
app.post("/api/files/rename", requireAuth, async (req, res) => {
  try {
    const { from, to } = req.body as { from: string; to: string };
    if (typeof from !== "string" || typeof to !== "string") {
      return fail(res, 400, "invalid_request", "from and to must be strings");
    }
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    if (scope) {
      assertWithinScope(scope, from);
      assertWithinScope(scope, to);
    }
    await renameEntry(from, to);
    res.json({ renamed: true, from, to });
  } catch (err) {
    if (guardTraversal(err, res)) return;
    if (err instanceof TargetExistsError) return fail(res, 409, "target_exists", err.message);
    fail(res, 500, "rename_failed", String(err));
  }
});

// Chunked/resumable upload: raw body instead of JSON, so a chunk is not inflated
// by base64 and can be retried byte-for-byte. The cap applies per chunk and to
// the resulting total, so many small chunks cannot walk past it.
app.post("/api/files/upload", express.raw({ type: "*/*", limit: MAX_UPLOAD_CHUNK_BYTES }), requireAuth, async (req, res) => {
  try {
    let relPath = String(req.query.path ?? "");
    // Conflict policy picked in the pre-upload conflict modal (GET .../upload/conflict).
    const conflictPolicy: UploadConflictPolicy | undefined =
      req.query.conflict === "keep_both" ? "keep_both" : req.query.conflict === "replace" ? "replace" : undefined;
    // Optional server target: a core uploaded for a server becomes its canonical
    // launch jar. The client cannot choose the path and it is always single-shot.
    const serverId = req.query.server === undefined ? "" : String(req.query.server);
    let serverTarget: ServerRecord | undefined;
    if (serverId) {
      serverTarget = servers.get(serverId);
      if (!serverTarget) return fail(res, 404, "not_found", "unknown serverId");
      if (serverTarget.state === "running") {
        return fail(res, 409, "server_running", "stop the server before replacing its launch jar");
      }
      if (req.query.offset !== undefined && Number(req.query.offset) !== 0) {
        return fail(
          res,
          400,
          "resume_unsupported_for_server_target",
          "server-target uploads are single-shot; send the whole jar with offset=0",
        );
      }
      relPath = `${serverDir(serverTarget)}/${CANONICAL_JAR_NAME}`;
    }
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    // `?scope=<id>` (distinct from the canonical-jar `?server=<id>` above) confines a
    // plain scoped upload from the Manage view to server/<id>.
    const scope = serverScope(req, ["scope"]);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    if (scope) assertWithinScope(scope, relPath);
    // `keep_both` uploads beside the existing file under an auto-renamed name. Never
    // honoured for a canonical-jar target, which always replaces byte from 0.
    if (!serverTarget && conflictPolicy === "keep_both") {
      relPath = await nextAvailableName(relPath);
      if (scope) assertWithinScope(scope, relPath);
    }
    // Scoped uploads come from the Manage/Configuration UI: rootfs is engine-owned and .bat
    // cannot run in the Linux container, so both are refused at the boundary rather than stored.
    if (scope && relPath.split("/").some((seg) => seg.trim().toLowerCase() === "rootfs")) {
      return fail(res, 400, "invalid_request", "rootfs is provisioned by the engine, not uploaded");
    }
    if (relPath.toLowerCase().endsWith(".bat")) {
      return fail(res, 400, "unsupported_script_type", ".bat cannot execute in a Linux container; provide a .sh");
    }
    let offset: number | undefined;
    if (req.query.offset !== undefined) {
      offset = Number(req.query.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        return fail(res, 400, "invalid_request", "offset must be a non-negative integer");
      }
    }
    // An explicit server-target upload replaces the canonical jar from byte 0.
    if (serverTarget) offset = 0;
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (chunk.length === 0) return fail(res, 400, "invalid_request", "empty chunk body");
    const target = await resolveUploadTarget(relPath);
    const projected = target.existingBytes + (offset === 0 ? 0 : chunk.length);
    if (projected > MAX_UPLOAD_BYTES) {
      return fail(res, 413, "upload_too_large", `upload would exceed ${MAX_UPLOAD_BYTES} bytes`);
    }
    const totalBytes = await appendChunk(relPath, chunk, offset);
    if (serverTarget) {
      const abs = resolveSafe(relPath);
      if (!isJarFileAbs(abs)) {
        // A rejected body is removed so it can never be adopted as the launch jar.
        rmSync(abs, { force: true });
        return fail(res, 400, "invalid_jar_content", "uploaded file is not a ZIP/JAR archive (PK magic missing)");
      }
      serverTarget.jarFile = CANONICAL_JAR_NAME;
      persistServers();
    }
    const body: UploadResult = { path: relPath, chunkBytes: chunk.length, totalBytes, policy: conflictPolicy };
    res.json(body);
  } catch (err) {
    if (guardTraversal(err, res)) return;
    if (err instanceof RangeError) return fail(res, 409, "offset_mismatch", err.message);
    fail(res, 500, "upload_failed", String(err));
  }
});

// Pre-upload conflict probe: reports what already occupies the target path so the
// client can offer Replace / Keep Both / Cancel before sending a single byte.
// `?size=` (the intended file size) distinguishes an interrupted-upload prefix
// (safe to resume) from a whole pre-existing file.
app.get("/api/files/upload/conflict", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    if (scope) assertWithinScope(scope, relPath);
    const intended = Number(req.query.size ?? 0);
    const exists = await entryExists(relPath);
    const { existingBytes } = await resolveUploadTarget(relPath);
    const isDir = exists && existingBytes === 0;
    const body: UploadConflict = {
      path: relPath,
      exists,
      existingBytes,
      partial: existingBytes > 0 && intended > existingBytes,
      canKeepBoth: exists && !isDir,
    };
    res.json(body);
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "conflict_check_failed", String(err));
  }
});

// Abort cleanup for an interrupted upload. The client only sends `abort` when no
// pre-existing data was at the path before the upload started, so removing the
// partial file can never destroy an earlier file the operator wanted to keep.
app.post("/api/files/upload/abort", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    if (scope) assertWithinScope(scope, relPath);
    await deleteEntry(relPath);
    res.json({ aborted: true, path: relPath });
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "abort_failed", String(err));
  }
});

// Resume support: tells a client how many bytes are already stored for the path.
app.get("/api/files/upload", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    if (scope) assertWithinScope(scope, relPath);
    const { existingBytes } = await resolveUploadTarget(relPath);
    const body: UploadStatus = {
      path: relPath,
      sizeBytes: existingBytes,
      maxBytes: MAX_UPLOAD_BYTES,
      maxBytesPerRequest: MAX_UPLOAD_CHUNK_BYTES,
    };
    res.json(body);
  } catch (err) {
    if (!guardTraversal(err, res)) fail(res, 500, "upload_status_failed", String(err));
  }
});

// --- Archive extraction (background task) -----------------------------------
// Extraction runs off the request thread and is polled via GET /api/files/extract.
// Every entry is confined to the resolved destination (never outside server/<id>),
// traversal/symlink entries are rejected, and the archive + decompressed sizes are
// capped by archive.ts. Overwrite is the default; `skip` leaves existing files.
app.post("/api/files/extract", requireAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as { path?: string; destination?: string; policy?: string };
    const relPath = typeof body.path === "string" ? body.path : "";
    if (!relPath) return fail(res, 400, "invalid_request", "path is required");
    if (!detectFormat(relPath)) {
      return fail(res, 400, "unsupported_archive", "only .zip, .tar and .tar.gz archives can be extracted");
    }
    // `rootfs` is engine-provisioned; an archive must not inflate into it.
    if (relPath.split("/").some((seg) => seg.trim().toLowerCase() === "rootfs")) {
      return fail(res, 400, "invalid_request", "rootfs is provisioned by the engine, not extracted into");
    }
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    if (scope) {
      assertWithinScope(scope, relPath);
      if (body.destination) assertWithinScope(scope, body.destination);
    }
    const task = await startExtraction({
      relPath,
      destinationRel: typeof body.destination === "string" && body.destination ? body.destination : undefined,
      policy: body.policy === "skip" ? "skip" : "overwrite",
    });
    res.status(202).json(task);
  } catch (err) {
    if (guardTraversal(err, res)) return;
    if (err instanceof ArchiveFormatError) return fail(res, 400, "unsupported_archive", err.message);
    fail(res, 500, "extract_failed", String(err));
  }
});

// Poll one task by id (`?id=`) or list every retained task.
app.get("/api/files/extract", requireAuth, (req, res) => {
  const id = String(req.query.id ?? "");
  if (id) {
    const task = getArchiveTask(id);
    if (!task) return fail(res, 404, "not_found", "unknown extraction task");
    res.json(task);
    return;
  }
  res.json(listArchiveTasks());
});

// Scoped folder download, streamed on the fly (no whole-folder buffering). The
// directory is confined to the scope and its symlinks are skipped by the walker.
app.get("/api/files/zip", requireAuth, async (req, res) => {
  try {
    const scope = serverScope(req);
    if (scope === "error") return fail(res, 404, "not_found", "unknown serverId");
    const relPath = String(req.query.path ?? "");
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    if (scope) assertWithinScope(scope, relPath);
    const abs = resolveSafe(relPath);
    const stat = statSync(abs);
    if (!stat.isDirectory()) return fail(res, 400, "invalid_request", "path must be a directory");
    const baseName = path.basename(abs) || "download";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}-${stamp}.zip"`);
    const stream = createZipStream(walkZipEntries(abs, baseName));
    stream.on("error", (err: unknown) => {
      console.error("[zip] folder archive failed:", err);
      // Headers may already be flushed mid-stream; drop the connection either way.
      if (!res.headersSent) fail(res, 500, "zip_failed", "failed to build folder archive");
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    if (guardTraversal(err, res)) return;
    fail(res, 500, "zip_failed", String(err));
  }
});

// --- Software management ----------------------------------------------------
// Downloads always land under software/<kind>/ through resolveSafe, so a URL can
// never choose a destination path.
app.get("/api/software", requireAuth, async (req, res) => {
  const kind = String(req.query.kind ?? "");
  try {
    if (kind === "") {
      res.json(await Promise.all(SOFTWARE_KINDS.map((entry) => listSoftware(entry))));
      return;
    }
    if (!isSoftwareKind(kind)) {
      return fail(res, 400, "invalid_request", `kind must be one of ${SOFTWARE_KINDS.join(", ")}`);
    }
    res.json(await listSoftware(kind));
  } catch (err) {
    fail(res, 500, "list_failed", String(err));
  }
});

app.post("/api/software/download", requireAuth, async (req, res) => {
  const body = req.body as DownloadSoftwareRequest;
  if (!isSoftwareKind(body?.kind)) {
    return fail(res, 400, "invalid_request", `kind must be one of ${SOFTWARE_KINDS.join(", ")}`);
  }
  if (typeof body.url !== "string") return fail(res, 400, "invalid_request", "url is required");
  // rootfs is provisioned by the engine (Alpine distro), never fetched into the data dir.
  if (body.kind === "rootfs") {
    return fail(res, 400, "unsupported_software_kind", "rootfs is provisioned by the engine; it cannot be downloaded");
  }
  // Optional server target: a validated core is canonicalised into the server data dir
  // as server.jar and becomes the launch jar. The client cannot choose a path, and an
  // existing canonical jar is never overwritten (the download then stays a plain core).
  const target = body.serverId ? servers.get(String(body.serverId)) : undefined;
  if (body.serverId && !target) return fail(res, 404, "not_found", "unknown serverId");
  if (target && target.state === "running") {
    return fail(res, 409, "server_running", "stop the server before replacing its launch jar");
  }
  try {
    const result = await downloadSoftware(body.kind, body.url, body.filename);
    if (target && body.kind === "core") {
      const staged = await stageCanonicalJar(serverDir(target), result.path, result.filename);
      target.jarFile = staged.filename;
      persistServers();
      res.json({
        ...result,
        path: staged.path,
        filename: staged.filename,
        ...(staged.conflict ? { conflict: staged.conflict, downloadedPath: result.path } : {}),
      });
      return;
    }
    res.json(result);
  } catch (err) {
    fail(res, 400, "download_failed", err instanceof Error ? err.message : String(err));
  }
});

// Scripts: .sh is accepted and chmod'd; .bat is refused explicitly because it
// cannot execute inside the Linux container runtime.
app.post("/api/software/:kind/:name/chmod", requireAuth, async (req, res) => {
  const kind = req.params.kind;
  if (!isSoftwareKind(kind)) {
    return fail(res, 400, "invalid_request", `kind must be one of ${SOFTWARE_KINDS.join(", ")}`);
  }
  const name = String(req.params.name);
  if (kind === "script" && name.toLowerCase().endsWith(".bat")) {
    return fail(res, 400, "unsupported_script_type", ".bat cannot execute in a Linux container; provide a .sh");
  }
  const rawExecutable = (req.body as { executable?: unknown })?.executable;
  const executable = rawExecutable === undefined ? true : Boolean(rawExecutable);
  try {
    res.json(await setExecutable(`${softwareRoot(kind)}/${name}`, executable));
  } catch (err) {
    if (guardTraversal(err, res)) return;
    fail(res, 404, "chmod_failed", String(err));
  }
});

// Downloads an installed artifact back to the client.
app.get("/api/software/download", requireAuth, (req, res) => {
  try {
    const relPath = String(req.query.path ?? "");
    if (!relPath) return fail(res, 400, "invalid_request", "path query parameter is required");
    res.download(resolveSafe(relPath));
  } catch (err) {
    if (guardTraversal(err, res)) return;
    fail(res, 500, "download_failed", String(err));
  }
});

// Console: recent buffer over HTTP (smoke-testable) + Socket.io for live lines.
app.get("/api/console/:id/recent", requireAuth, (req, res) => {
  res.json(consoleBuffers.get(req.params.id) ?? []);
});

// Export: streams a ZIP of the data root. Read-only - source data is never
// modified or removed by an export.
app.get("/api/export", requireAuth, async (_req, res) => {
  try {
    const entries = await collectDataFiles();
    const archive = createZip(entries);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="mcm-export-${stamp}.zip"`);
    res.setHeader("X-Export-Files", String(entries.length));
    res.send(archive);
  } catch (err) {
    fail(res, 500, "export_failed", String(err));
  }
});

// Uninstall: destructive. Requires auth plus an explicit confirm field matching
// the server id, so a mistyped or replayed request can never delete silently.
app.post("/api/servers/:id/uninstall", requireAuth, async (req, res) => {
  const record = servers.get(req.params.id);
  if (!record) return fail(res, 404, "not_found", "unknown server id");
  const confirm = String((req.body as { confirm?: unknown })?.confirm ?? "");
  if (confirm !== record.id) {
    return fail(
      res,
      400,
      "confirmation_required",
      `resend with {"confirm":"${record.id}"} to uninstall ${record.id}`,
    );
  }
  const child = processes.get(record.id);
  if (child) {
    terminateContainer(record.id, child, "SIGTERM");
    processes.delete(record.id);
  }
  try {
    const dataRemoved = await removeIfExists(record.id);
    servers.delete(record.id);
    consoleBuffers.delete(record.id);
    persistServers();
    res.json({
      uninstalled: true,
      id: record.id,
      stoppedProcess: Boolean(child),
      dataRemoved,
    });
  } catch (err) {
    fail(res, 500, "uninstall_failed", String(err));
  }
});

// --- Lifecycle --------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, stopping ${processes.size} process(es)`);
  for (const [id, child] of processes) {
    terminateContainer(id, child, "SIGKILL");
    processes.delete(id);
  }
  io.close();
  httpServer.close(() => process.exit(0));
  // Hard stop if sockets keep the loop alive.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const port = Number(process.env.PORT ?? 3001);

// Create the canonical data root before the first request so the very first
// `/api/files` call lists an empty root instead of failing with ENOENT. A failure
// here (permissions, unusable path) is loud but non-fatal: the API still starts and
// every file route keeps reporting the real error rather than being hidden.
async function bootstrapDataRoot(): Promise<void> {
  try {
    await ensureDataRoot();
    console.log(`[files] data root ready: ${dataRoot()}`);
  } catch (err) {
    console.warn(`[files] could not prepare data root ${dataRoot()}: ${String(err)}`);
  }
}

void bootstrapDataRoot().finally(() => {
  httpServer.listen(port, () => {
    console.log(`mcm-server listening on http://localhost:${port}`);
    console.log(`[files] data root: ${dataRoot()}`);
  });
});
