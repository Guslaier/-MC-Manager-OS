// Shared API contracts between server and web.

export interface HealthStatus {
  ok: boolean;
  service: string;
  uptimeSeconds: number;
}

/** Which runtime family the engine actually routes through. `none` = lifecycle refused.
 *  `native` = docker+runc, `runc` = runc directly on a Linux host, `wsl` = explicit WSL2 bridge. */
export type RuntimeMode = "native" | "runc" | "wsl" | "none";

export interface EngineProbe {
  available: boolean;
  reason: string;
  /** True when a container runtime binary exists but is not usable yet. */
  installed?: boolean;
  /** Absolute path of the detected runtime, when known. */
  runtimePath?: string | null;
  /** Active runtime family: native docker+runc, host runc (Linux), the explicit WSL bridge, or none. */
  mode?: RuntimeMode;
  /** WSL distro backing the bridge, when `mode` is `wsl`. */
  distro?: string | null;
  /** First line of `runc --version` inside the WSL distro, when known. */
  runcVersion?: string | null;
}

export type ServerState = "created" | "running" | "stopped";

/** JRE major versions provisioned from the Alpine repos (musl builds only). */
export type JavaVersion = "8" | "17" | "21";

export const JAVA_VERSIONS: JavaVersion[] = ["8", "17", "21"];

export type ServerType = "java" | "bedrock";

/**
 * Canonical stored/staged/launch name for a core server jar. A download or upload
 * targeting a server always lands as servers/<id>/server.jar, metadata records this
 * name, and the engine stages and binds it at /data/server.jar.
 */
export const CANONICAL_JAR_NAME = "server.jar";
export const CANONICAL_BEDROCK_NAME = "bedrock_server";

/** Default launch command offered for a new server; the server runs it as argv. */
export const DEFAULT_SCRIPT_RUN = `java -jar ${CANONICAL_JAR_NAME} --nogui`;
export const DEFAULT_BEDROCK_SCRIPT_RUN = "./bedrock_server";
export const DEFAULT_BEDROCK_PORT = 19132;
export const DEFAULT_BEDROCK_PORT_V6 = 19133;

export interface ServerRecord {
  id: string;
  name: string;
  serverType?: ServerType;
  gamePort: number;
  memoryMb: number;
  cpuCores: number;
  state: ServerState;
  createdAt: string;
  pid: number | null;
  /** Selected JRE major version; lifecycle uses it to pick the java binary. */
  javaVersion: JavaVersion;
  /** File name of the installed server jar under the server data dir, if any. */
  jarFile: string | null;
  /** Launch command tokenised into argv at start; never passed through a shell. */
  scriptRun: string;
  /**
   * Heavy-modpack optimization: raises the container file-handle limit (`ulimit -n 65535`)
   * so large modpacks are not starved of open files. Defaults to true for new records and
   * is backfilled to true for legacy records that predate the option; explicit false stays false.
   */
  optimizeHeavyModpack?: boolean;
  /**
   * LEGACY: external host folder previously pinned as this server's data dir. Storage is
   * now canonical container-side `server/<id>` inside the WSL distro, so this value is
   * ignored on load and can never redirect file/lifecycle access outside that root.
   */
  dataRoot?: string | null;
}

/** LEGACY (retired): body that used to pin a server's external host data folder. */
export interface SetDataRootRequest {
  path: string | null;
}

/**
 * Observed EULA state for a server, read from its canonical `eula.txt` (never
 * auto-accepted by the service). `missing` means the game has not booted yet.
 */
export type EulaState = "accepted" | "declined" | "missing";

export interface EulaStatus {
  serverId: string;
  /** Current state on disk; `missing` before the first boot writes eula.txt. */
  state: EulaState;
  /** True when the game requires agreement before it will keep running. */
  required: boolean;
}

/** Explicit operator decision: the only way the service ever writes `eula.txt`. */
export interface SetEulaRequest {
  accepted: boolean;
}

/**
 * Canonical storage mode reported by `GET /api/storage`. The server root is always
 * container-side; `dryRun`/`needsMigration` are read-only migration diagnostics.
 */
export interface StorageStatus {
  /** DATA_ROOT as the server sees it (UNC over Windows, FUSE mount inside the distro). */
  root: string;
  /** `wsl` when MCM_DATA_DIR targets the distro filesystem, otherwise `host`. */
  mode: "wsl" | "host";
  /** Existing records found in state.json (the ones migration would move). */
  knownRecords: number;
  /** Records whose files still live outside the canonical root. */
  pending: number;
  /** A migration run is required (pending > 0 and the canonical root holds no state.json). */
  needsMigration: boolean;
  /** Read-only migration preview; empty when nothing is pending. */
  dryRun: string[];
}

/** One navigable folder returned by the authenticated host folder browse bridge. */
export interface HostDirEntry {
  name: string;
  path: string;
}

export interface HostDirListing {
  /** Absolute path that was listed; empty string when only the filesystem roots are offered. */
  path: string;
  /** Absolute parent path, or `null` at a filesystem root. */
  parent: string | null;
  entries: HostDirEntry[];
}

export interface CreateServerRequest {
  name: string;
  serverType?: ServerType;
  gamePort?: number;
  memoryMb?: number;
  cpuCores?: number;
  javaVersion?: JavaVersion;
  /** Defaults to DEFAULT_SCRIPT_RUN (or DEFAULT_BEDROCK_SCRIPT_RUN for bedrock) when omitted. */
  scriptRun?: string;
  /** Defaults to true when omitted. */
  optimizeHeavyModpack?: boolean;
  /** Automatically accept the Minecraft EULA on creation so first boot does not crash */
  acceptEula?: boolean;
}

export interface UpdateServerRequest {
  name?: string;
  serverType?: ServerType;
  gamePort?: number;
  memoryMb?: number;
  cpuCores?: number;
  /** Selected JRE major version; lifecycle picks the java binary from it. */
  javaVersion?: JavaVersion;
  /** Launch command tokenised into argv at start; validated before it is stored. */
  scriptRun?: string;
  /** Heavy-modpack optimization toggle; stored as-is when a boolean, unchanged when omitted. */
  optimizeHeavyModpack?: boolean;
  /**
   * Name of a `.jar` already inside this server's scoped dir to adopt as the launch jar.
   * The backend validates it (plain basename, real ZIP/JAR) and canonicalises it to
   * `server.jar` after the whole update validates; `server.jar` itself is set by upload.
   */
  legacyJarName?: string;
}

export interface ContainerMetrics {
  serverId: string;
  running: boolean;
  /** Where the sample came from. `declared` means no live container to sample. */
  source: "docker-stats" | "declared" | "procfs";
  cpuPercent: number | null;
  /** Raw cumulative CPU percentage across all cores (from procfs/docker-stats) */
  cpuRawPercent?: number | null;
  memoryMb: number | null;
  memoryLimitMb: number;
  cpuCores: number;
  /** ISO timestamp of the live sample; null when unavailable (declared/none). */
  sampledAt?: string | null;
  /** Storage bytes used by the canonical data dir (296->real walk when readable). */
  storageUsedBytes?: number | null;
  /** Number of files counted during the storage walk. */
  storageFiles?: number | null;
  /** Free bytes on the volume holding the canonical data dir (statfs). */
  storageFreeBytes?: number | null;
  /** Total bytes on the volume holding the canonical data dir (statfs). */
  storageTotalBytes?: number | null;
  /** How the storage numbers were obtained: a directory walk or statfs. */
  storageSource?: "walk" | "statfs" | null;
  reason?: string;
}

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresInSeconds: number;
}

export interface SessionInfo {
  username: string;
  expiresAt: string;
}

export interface ResourceStatus {
  hostname: string;
  platform: string;
  cpuCount: number;
  loadAvg1m: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  uptimeSeconds: number;
}

export type FileEntryType = "file" | "dir";

export interface FileEntry {
  name: string;
  type: FileEntryType;
  sizeBytes: number;
  modifiedAt: string;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
}

export interface FileContent {
  path: string;
  content: string;
}

export interface WriteFileRequest {
  path: string;
  content: string;
}

export interface ConsoleEvent {
  serverId: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
  at: string;
}

export interface ApiError {
  error: string;
  reason?: string;
}

// --- Chunked / resumable uploads ---------------------------------------------

export interface UploadStatus {
  path: string;
  sizeBytes: number;
  maxBytes: number;
  /** Per-request (per-chunk) ceiling, independent of the overall maxBytes total. */
  maxBytesPerRequest: number;
}

/** What to do when the target path already holds data. */
export type UploadConflictPolicy = "replace" | "keep_both";

/** Reported by the conflict probe before the first byte of an upload. */
export interface UploadConflict {
  path: string;
  /** True when any entry (file or directory) already occupies the target path. */
  exists: boolean;
  /** Bytes already stored at `path` (a whole existing file, or the kept prefix of an interrupted upload). */
  existingBytes: number;
  /** True when the stored bytes came from an interrupted upload (resuming is lossless). */
  partial: boolean;
  /** `keep_both` auto-renames are only offered for a whole-file conflict, not a directory. */
  canKeepBoth: boolean;
}

export interface UploadResult {
  path: string;
  chunkBytes: number;
  totalBytes: number;
  /** Only set when the server renamed the target under the `keep_both` policy. */
  policy?: UploadConflictPolicy;
}

// --- Archive extraction + scoped folder download -----------------------------

/** Archive formats the extractor understands, by extension. */
export type ArchiveFormat = "zip" | "tar" | "tar.gz";

/** What to do when an archive entry collides with an existing path. Default is `overwrite`. */
export type ExtractConflictPolicy = "overwrite" | "skip";

export type ArchiveTaskStatus = "extracting" | "done" | "error";

/** Live state of a background extraction, polled by the client while it runs. */
export interface ArchiveTask {
  id: string;
  /** Canonical archive path relative to the data root. */
  path: string;
  /** Resolved destination directory (same value the extractor is confined to). */
  destination: string;
  format: ArchiveFormat;
  policy: ExtractConflictPolicy;
  status: ArchiveTaskStatus;
  /** Entries successfully written so far. */
  extractedEntries: number;
  /** Entries skipped because a file already existed (only under the `skip` policy). */
  skippedEntries: number;
  /** Total files discovered in the archive. */
  totalEntries: number;
  bytesWritten: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Non-fatal warnings (e.g. an entry rejected as an escape attempt). */
  warnings: string[];
}

/** Response to POST /api/files/extract: the accepted background task. */
export type ExtractStart = ArchiveTask;

// --- Software management (Alpine rootfs / JRE / custom jar / script) ---------

export type SoftwareKind = "rootfs" | "jre" | "core" | "script";

export interface SoftwareEntry {
  kind: SoftwareKind;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  executable: boolean;
}

export interface SoftwareListing {
  kind: SoftwareKind;
  entries: SoftwareEntry[];
}

export interface DownloadSoftwareRequest {
  kind: SoftwareKind;
  url: string;
  filename?: string;
  /**
   * Optional target server. When set, the validated artifact lands under
   * servers/<id>/ and is recorded on the server as its launch jar.
   */
  serverId?: string;
}

// --- Java provisioning (REQ-4.2: Alpine musl JRE via apk) --------------------

export interface JavaInstallRequest {
  version: JavaVersion;
}

/** Honest report of what the Alpine repos currently have installed. */
export interface JavaInstallReport {
  version: JavaVersion;
  /** Alpine package that backs this version (openjdk<N>-jre). */
  packageName: string;
  /** True only after `apk info -e` confirms the package is present. */
  installed: boolean;
  /** Raw first line of `java -version`, when the binary actually ran. */
  versionOutput: string | null;
  reason: string;
}

export interface ChmodResult {
  path: string;
  executable: boolean;
  changed: boolean;
  note?: string;
}

// --- Host provisioning (REQ-1.1: WSL detection + Alpine import + runc) -------

/** Which provisioning step the host is waiting on. Reported verbatim to the UI. */
export type ProvisionState =
  | "provisioning"
  | "wsl_absent"
  | "components_missing"
  | "restart_required"
  | "distro_missing"
  | "runc_missing"
  | "cgroup_unavailable"
  | "distro_ready"
  | "failed";

/** Provisioning steps that can be triggered explicitly. */
export type ProvisionStep = "install" | "import" | "runc";

/** Manual action the operator must take; `null` when nothing is required. */
export type ProvisionManualAction = "run_elevated_install" | "restart_then_retry" | null;

export interface ProvisionReport {
  state: ProvisionState;
  /** WSL distro the bridge targets (MCM_WSL_DISTRO). */
  distro: string;
  /** True when wsl.exe resolved on PATH. */
  wslPresent: boolean;
  /** True when the distro is registered (never unregistered by this service). */
  distroPresent: boolean;
  runcVersion: string | null;
  cgroup2: boolean;
  /** True while a provisioning operation is in flight (single-flight lock). */
  busy: boolean;
  /** True only when a Windows restart is genuinely required to continue. */
  restartRequired: boolean;
  manualAction: ProvisionManualAction;
  reason: string;
  /** Step that produced this report, when it came from a POST. */
  step?: ProvisionStep;
}

// --- Player & World management (honest, console/file-backed) ----------------
//
// There is no RCON/query protocol in this build, so nothing here is invented:
// online players are parsed from the game's own `list` output on the console,
// and every other fact (ops, whitelist, world folders) is read from the server's
// canonical files on disk. Chunks and entity counts have no source and are
// reported as null / omitted rather than guessed.

/**
 * One player name this service can actually name, tagged with where it came from.
 * `console` = parsed from the live `list` output; `ops`/`whitelist` = read from the
 * server's ops.json / whitelist.json.
 */
export interface PlayerRef {
  name: string;
  source: "console" | "ops" | "whitelist";
  op: boolean;
  whitelisted: boolean;
}

export interface PlayerListResult {
  serverId: string;
  /** True when the server process is alive; only then can `list` be asked. */
  running: boolean;
  /** Where the rows came from: live console output, files only, or nothing readable. */
  source: "console" | "files" | "none";
  players: PlayerRef[];
  /** Parsed `There are N of a max of M players online` count, when `list` ran. */
  onlineCount: number | null;
  maxPlayers: number | null;
  /** Raw `list` line, surfaced verbatim so the console parse is never hidden. */
  raw: string | null;
  /** Human explanation when a source was missing (stopped server, no output yet). */
  reason?: string;
}

/** Management actions, each mapped to a single validated console command line. */
export type PlayerAction = "kick" | "op" | "deop" | "say" | "whitelist-add" | "whitelist-remove";

export interface PlayerActionRequest {
  action: PlayerAction;
  /** Target name; required for kick/op/deop/whitelist-add/whitelist-remove, optional for `say`. */
  player?: string;
  /** Message body; required and length-limited for `say`. */
  message?: string;
  /** Explicit confirmation echoing the target name; required for destructive kick/whitelist-remove. */
  confirm?: string;
}

export interface PlayerActionResult {
  serverId: string;
  action: PlayerAction;
  /** The exact console line that was sent; never arbitrary shell text. */
  command: string;
  /** True only when the line was actually written to a live process stdin. */
  delivered: boolean;
}

/** One dimension folder found under the server's canonical data dir. */
export interface WorldDimension {
  /** Stable row id (the folder name). */
  id: string;
  /** Human label (`Overworld`, `Nether`, `The End`, or the raw folder name). */
  label: string;
  /** Folder name on disk (`world`, `world_nether`, `world_the_end`, ...). */
  directory: string;
  sizeBytes: number;
  /** Real file count and newest mtime, from a directory walk of the folder. */
  files: number;
  modifiedAt: string | null;
  /** Non-zero chunk count from the region header; null when region files are absent. */
  chunks: number | null;
  /** How `chunks` was derived: a region-header scan, or null when unknown. */
  chunksSource?: "region-header" | null;
}

export interface WorldStateResult {
  serverId: string;
  /** Read from server.properties when present; null when the file is absent. */
  levelName: string | null;
  difficulty: string | null;
  gamemode: string | null;
  maxPlayers: number | null;
  whitelistEnabled: boolean | null;
  /** Dimension folders found by walking the server's canonical data dir. */
  dimensions: WorldDimension[];
  /** Names from ops.json / whitelist.json; empty arrays when those files are absent. */
  ops: string[];
  whitelist: string[];
  source: "files" | "none";
  /** Newest save mtime across region files; null when no region files are present. */
  lastSaveAt?: string | null;
  /** How `lastSaveAt` was derived: newest region-file mtime, or null when unknown. */
  lastSaveSource?: "disk-mtime" | null;
  /** Autosave interval needs the server's live config; null when unavailable. */
  autosaveIntervalSeconds?: number | null;
  reason?: string;
}

export interface FlushResult {
  serverId: string;
  /** The exact command sent (`save-all flush`); never operator-supplied text. */
  command: string;
  delivered: boolean;
  reason?: string;
}

/** Values accepted by the `gamemode` property. */
export const GAMEMODES = ["survival", "creative", "adventure", "spectator"] as const;
export type GameMode = (typeof GAMEMODES)[number];

/** Values accepted by the `difficulty` property. */
export const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** One editable server.properties field, with Minecraft defaults applied when absent. */
export interface ServerPropertiesView {
  serverId: string;
  /** `file` when server.properties was read; `defaults` when the file is absent. */
  source: "file" | "defaults";
  maxPlayers: number;
  gamemode: GameMode;
  difficulty: Difficulty;
  whitelistEnabled: boolean;
  /** Mojang online authentication (`online-mode`). */
  onlineMode: boolean;
  /** Inverse convenience flag: true means `online-mode=false` (cracked). */
  cracked: boolean;
  allowFlight: boolean;
  forceGamemode: boolean;
  /** Player-vs-player damage (`pvp`). */
  pvp: boolean;
  spawnProtection: number;
  /** Whether clients must accept the configured resource pack to join. */
  resourcePackRequired: boolean;
  /** Empty string when no resource pack is configured. */
  resourcePack: string;
  resourcePackPrompt: string;
  /** Recognised property keys actually present in the file (fidelity indicator). */
  knownKeys: string[];
  reason?: string;
}

/** Only these fields may be patched; any other key is rejected with 400. */
export interface ServerPropertiesPatch {
  maxPlayers?: number;
  gamemode?: GameMode;
  difficulty?: Difficulty;
  whitelistEnabled?: boolean;
  /** Canonical flag; rejected when supplied together with `cracked`. */
  onlineMode?: boolean;
  /** Inverse of `onlineMode`; rejected when supplied together with `onlineMode`. */
  cracked?: boolean;
  allowFlight?: boolean;
  forceGamemode?: boolean;
  pvp?: boolean;
  spawnProtection?: number;
  resourcePackRequired?: boolean;
  resourcePack?: string;
  resourcePackPrompt?: string;
}

export interface ServerPropertiesUpdateResult {
  serverId: string;
  /** Re-resolved view read back from disk after the write. */
  properties: ServerPropertiesView;
  /** Property keys whose value actually changed on disk. */
  changed: string[];
}

/** Value type of a vanilla gamerule as stored in `level.dat`. */
export type GameruleType = "boolean" | "integer";

/** One gamerule resolved from `level.dat`, with its provenance. */
export interface GameruleValue {
  /** Canonical camelCase name as written in `level.dat` (e.g. `doDaylightCycle`). */
  name: string;
  type: GameruleType;
  value: boolean | number;
  /** `file` when present in level.dat; `default` when the rule was absent. */
  source: "file" | "default";
  description: string;
}

/**
 * Gamerules read from the world's `level.dat` (gzip-compressed NBT). Vanilla Java
 * Edition stores these under `Data.GameRules`; there is no separate `game_rules.dat`.
 */
export interface GamerulesView {
  serverId: string;
  /** `file` when level.dat was read; `defaults` when it is absent. */
  source: "file" | "defaults";
  /** Level name from `Data.LevelName`, when present. */
  levelName: string | null;
  rules: GameruleValue[];
  reason?: string;
  /** Resolved relative world directory, e.g. `world` or `worlds/Bedrock level`. */
  worldPath?: string;
  /** Server edition: `java` or `bedrock`. */
  serverType?: ServerType;
}

/** Only known vanilla gamerule names may be patched; any other key is rejected with 400. */
export type GamerulesPatch = Record<string, boolean | number>;

export interface GamerulesUpdateResult {
  serverId: string;
  /** Re-resolved view read back from disk after the write. */
  gamerules: GamerulesView;
  /** Gamerule names whose stored value actually changed on disk. */
  changed: string[];
}
