/// <reference types="vite/client" />
// Typed client for the mcm-server API. Token lives in localStorage; every
// authenticated call sends it as a Bearer header.
import type {
  ApiError,
  ArchiveTask,
  ChmodResult,
  ConsoleEvent,
  ContainerMetrics,
  CreateServerRequest,
  DownloadSoftwareRequest,
  EngineProbe,
  EulaStatus,
  SetEulaRequest,
  FileContent,
  FileListing,
  GamerulesPatch,
  GamerulesUpdateResult,
  GamerulesView,
  HealthStatus,
  JavaInstallReport,
  JavaVersion,
  LoginResponse,
  ProvisionReport,
  ProvisionStep,
  ServerPropertiesPatch,
  ServerPropertiesUpdateResult,
  ServerPropertiesView,
  ExtractConflictPolicy,
  ExtractStart,
  FlushResult,
  PlayerActionResult,
  PlayerActionRequest,
  PlayerListResult,
  ResourceStatus,
  WorldStateResult,
  ServerRecord,
  SessionInfo,
  SoftwareKind,
  SoftwareListing,
  StorageStatus,
  UpdateServerRequest,
  UploadConflict,
  UploadConflictPolicy,
  UploadResult,
  UploadStatus,
  WriteFileRequest,
} from "@mcm/contracts";

/**
 * A server-target upload adopts the sent bytes as that server's canonical launch jar.
 * The backend fixes the destination to `server/<serverId>/server.jar`, so `path` is
 * passed back verbatim to keep the resume probe and the single-shot upload in sync.
 */
export interface UploadTarget {
  serverId: string;
  path: string;
}

const TOKEN_KEY = "mcm.token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** Error carrying the backend's machine-readable code plus its human reason. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    reason: string,
  ) {
    super(reason);
    this.name = "ApiFailure";
  }
}

/**
 * Like fetch, but throws ApiFailure on a non-2xx response. Used by the raw
 * upload path, which sends a binary body rather than our JSON envelope.
 */
export async function authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  if (res.ok) return res;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (proxy error page, crash) - surface the code only.
  }
  const err = (data ?? {}) as ApiError;
  throw new ApiFailure(res.status, err.error ?? "request_failed", err.reason ?? `HTTP ${res.status}`);
}

/**
 * Appends `<sep><key>=<id>` when a scope id is given; empty string otherwise.
 * Callers whose URL carries no query string yet pass `sep = "?"`.
 * The upload endpoints pass key `scope`: `?server=` there already means
 * "replace this server's canonical launch jar", not "confine my path".
 */
function scopeQuery(server?: string, key = "server", sep = "&"): string {
  return server ? `${sep}${key}=${encodeURIComponent(server)}` : "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (proxy error page, crash) - surface it verbatim.
    if (!res.ok) throw new ApiFailure(res.status, "bad_response", text.slice(0, 200) || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    const err = (data ?? {}) as ApiError;
    throw new ApiFailure(res.status, err.error ?? "request_failed", err.reason ?? `HTTP ${res.status}`);
  }
  return data as T;
}

export type LifecycleAction = "start" | "stop" | "restart" | "kill";

/**
 * Origin the Socket.io client must dial. The Vite dev proxy only forwards
 * /api, so the live console needs the backend origin explicitly. A deployed
 * same-origin build talks to itself.
 */
export const backendOrigin =
  typeof location !== "undefined" && import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3001` : "";

export const api = {
  health: () => request<HealthStatus>("/api/health"),
  engine: () => request<EngineProbe>("/api/engine"),
  login: (password: string) =>
    request<LoginResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  session: () => request<SessionInfo>("/api/auth/session"),
  status: () => request<ResourceStatus>("/api/status"),
  servers: () => request<ServerRecord[]>("/api/servers"),
  createServer: (body: CreateServerRequest) =>
    request<ServerRecord>("/api/servers", { method: "POST", body: JSON.stringify(body) }),
  lifecycle: (id: string, action: LifecycleAction, options?: { acceptEula?: boolean }) =>
    request<ServerRecord>(
      `/api/servers/${encodeURIComponent(id)}/${action}${options?.acceptEula ? "?acceptEula=true" : ""}`,
      { method: "POST" },
    ),
  getEula: (id: string) => request<EulaStatus>(`/api/servers/${encodeURIComponent(id)}/eula`),
  setEula: (id: string, accepted: boolean) =>
    request<EulaStatus>(`/api/servers/${encodeURIComponent(id)}/eula`, {
      method: "POST",
      body: JSON.stringify({ accepted }),
    }),
  // An optional `server` id scopes the call to `server/<id>` (Manage view); omit it
  // for the standalone Files view, which keeps the whole canonical data root.
  listFiles: (path: string, server?: string) =>
    request<FileListing>(`/api/files?path=${encodeURIComponent(path)}${scopeQuery(server)}`),
  readFile: (path: string, server?: string) =>
    request<FileContent>(`/api/files/content?path=${encodeURIComponent(path)}${scopeQuery(server)}`),
  writeFile: (body: WriteFileRequest, server?: string) =>
    request<{ path: string; bytes: number }>(`/api/files/content${scopeQuery(server, "server", "?")}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteFile: (path: string, server?: string) =>
    request<{ deleted: boolean }>(`/api/files?path=${encodeURIComponent(path)}${scopeQuery(server)}`, {
      method: "DELETE",
    }),
  // Rename/move a single file or directory inside the managed root. The backend
  // rejects traversal and cross-scope moves, so a failure is surfaced verbatim.
  renameEntry: (from: string, to: string, server?: string) =>
    request<{ renamed: boolean; from: string; to: string }>(`/api/files/rename${scopeQuery(server, "server", "?")}`, {
      method: "POST",
      body: JSON.stringify({ from, to }),
    }),
  consoleRecent: (id: string) => request<ConsoleEvent[]>(`/api/console/${encodeURIComponent(id)}/recent`),
  updateServer: (id: string, body: UpdateServerRequest) =>
    request<ServerRecord>(`/api/servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteServer: (id: string) =>
    request<{ deleted: boolean; id: string; stoppedProcess: boolean; dataRemoved: boolean }>(
      `/api/servers/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  /** Canonical container-side storage root + read-only migration diagnostics. */
  storage: () => request<StorageStatus>("/api/storage"),
  metrics: (id: string) => request<ContainerMetrics>(`/api/servers/${encodeURIComponent(id)}/metrics`),
  provision: () => request<ProvisionReport>("/api/provision"),
  provisionStep: (step: ProvisionStep) =>
    request<ProvisionReport>("/api/provision", { method: "POST", body: JSON.stringify({ step }) }),
  /** Per-version JRE status straight from the Alpine (musl) repos. */
  java: () => request<JavaInstallReport[]>("/api/java"),
  /** Runs a real `apk add` for one JRE major version; a failure is surfaced verbatim. */
  javaInstall: (version: JavaVersion) =>
    request<JavaInstallReport>("/api/java", { method: "POST", body: JSON.stringify({ version }) }),
  /** Adopt an existing `.jar` (already in the server's scoped dir) as its launch jar. */
  selectServerJar: (serverId: string, jarName: string) =>
    request<ServerRecord>(`/api/servers/${encodeURIComponent(serverId)}`, {
      method: "PATCH",
      body: JSON.stringify({ legacyJarName: jarName } satisfies UpdateServerRequest),
    }),
  /** Resume/initial-size probe for the canonical-jar (`?server=`) upload target. */
  uploadTarget: (target: UploadTarget) =>
    request<UploadStatus>(
      `/api/files/upload?path=${encodeURIComponent(target.path)}&server=${encodeURIComponent(target.serverId)}`,
    ),
  /** Single-shot replacement of a server's canonical launch jar (whole file, offset 0). */
  uploadServerJar: async (target: UploadTarget, body: Blob): Promise<UploadResult> => {
    const res = await authorizedFetch(
      `/api/files/upload?path=${encodeURIComponent(target.path)}&server=${encodeURIComponent(target.serverId)}&offset=0`,
      { method: "POST", headers: { "content-type": "application/octet-stream" }, body },
    );
    return (await res.json()) as UploadResult;
  },
  uploadStatus: (path: string, server?: string) =>
    request<UploadStatus>(`/api/files/upload?path=${encodeURIComponent(path)}${scopeQuery(server, "scope")}`),
  /** Pre-upload probe: what already occupies the target path (for the conflict modal). */
  uploadConflict: (path: string, size: number, server?: string) =>
    request<UploadConflict>(
      `/api/files/upload/conflict?path=${encodeURIComponent(path)}&size=${size}${scopeQuery(server, "scope")}`,
    ),
  /** Removes a partial file left by a cancelled upload (only safe when no prior data existed). */
  uploadAbort: (path: string, server?: string) =>
    request<{ aborted: boolean; path: string }>(
      `/api/files/upload/abort?path=${encodeURIComponent(path)}${scopeQuery(server, "scope")}`,
      { method: "POST" },
    ),
  uploadChunk: async (
    path: string,
    body: Blob,
    offset?: number,
    server?: string,
    conflict?: UploadConflictPolicy,
  ): Promise<UploadResult> => {
    const query = offset === undefined ? "" : `&offset=${offset}`;
    const policy = conflict === undefined ? "" : `&conflict=${conflict}`;
    const res = await authorizedFetch(
      `/api/files/upload?path=${encodeURIComponent(path)}${query}${policy}${scopeQuery(server, "scope")}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      },
    );
    return (await res.json()) as UploadResult;
  },
  /**
   * Starts a background extraction of a scoped archive. Returns immediately with
   * a task whose progress is polled via `archiveTask`; completion is never assumed.
   */
  extractArchive: (path: string, policy: ExtractConflictPolicy, server?: string, destination?: string) =>
    request<ExtractStart>(`/api/files/extract${scopeQuery(server, "server", "?")}`, {
      method: "POST",
      body: JSON.stringify({ path, policy, ...(destination ? { destination } : {}) }),
    }),
  /** Polls one extraction task by id. */
  archiveTask: (id: string) => request<ArchiveTask>(`/api/files/extract?id=${encodeURIComponent(id)}`),
  /** Lists every retained extraction task (used to re-attach on mount). */
  archiveTasks: () => request<ArchiveTask[]>("/api/files/extract"),
  /** Streams a scoped folder as a ZIP (built server-side, never assembled in the browser). */
  downloadFolderZip: (path: string, server?: string) =>
    authorizedFetch(`/api/files/zip?path=${encodeURIComponent(path)}${scopeQuery(server)}`),
  // No kind -> the backend returns one listing per kind; that is the only shape
  // the UI needs, so the per-kind variant is not wrapped.
  software: () => request<SoftwareListing[]>("/api/software"),
  downloadSoftware: (body: DownloadSoftwareRequest) =>
    request<{ kind: SoftwareKind; path: string; filename: string; bytes: number; executable: boolean }>(
      "/api/software/download",
      { method: "POST", body: JSON.stringify(body) },
    ),
  chmodSoftware: (kind: SoftwareKind, name: string, executable: boolean) =>
    request<ChmodResult>(`/api/software/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/chmod`, {
      method: "POST",
      body: JSON.stringify({ executable }),
    }),
  /**
   * Online players for a server: the backend runs the game's `list` command and
   * parses its output, falling back to ops.json/whitelist.json names on disk.
   * Ping, chunks and entities are never returned here - no source exists for them.
   */
  players: (id: string) => request<PlayerListResult>(`/api/servers/${encodeURIComponent(id)}/players`),
  /** Validated management action (kick/op/deop/say); the backend maps it to one console line. */
  playerAction: (id: string, body: PlayerActionRequest) =>
    request<PlayerActionResult>(`/api/servers/${encodeURIComponent(id)}/players/action`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** File-backed world state: dimensions, server.properties, ops and whitelist. */
  world: (id: string) => request<WorldStateResult>(`/api/servers/${encodeURIComponent(id)}/world`),
  /** Read-only server.properties view; a missing file yields Minecraft defaults. */
  properties: (id: string) => request<ServerPropertiesView>(`/api/servers/${encodeURIComponent(id)}/properties`),
  /** Stopped-only: patches the allow-listed core fields and returns the re-read view. */
  updateProperties: (id: string, patch: ServerPropertiesPatch) =>
    request<ServerPropertiesUpdateResult>(`/api/servers/${encodeURIComponent(id)}/properties`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** Read-only gamerule catalog from level.dat; a missing file yields vanilla defaults. */
  gamerules: (id: string) => request<GamerulesView>(`/api/servers/${encodeURIComponent(id)}/gamerules`),
  /** Stopped-only: patches known vanilla gamerules and returns the re-read view. */
  updateGamerules: (id: string, patch: GamerulesPatch) =>
    request<GamerulesUpdateResult>(`/api/servers/${encodeURIComponent(id)}/gamerules`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  /** Destructive: asks the live server to write its world out (`save-all flush`); needs the id echoed. */
  flushWorld: (id: string) =>
    request<FlushResult>(`/api/servers/${encodeURIComponent(id)}/world/flush`, {
      method: "POST",
      body: JSON.stringify({ confirm: id }),
    }),
  /** Downloads the server's world folder as a streamed zip archive. */
  downloadWorld: (id: string) =>
    authorizedFetch(`/api/servers/${encodeURIComponent(id)}/world/download`),
  /** Permanently deletes the server's world folder. */
  deleteWorld: (id: string) =>
    request<{ deleted: boolean; levelName: string }>(`/api/servers/${encodeURIComponent(id)}/world`, {
      method: "DELETE",
    }),
  /** Imports an uploaded archive into the world directory. */
  importWorld: (id: string, archivePath: string) =>
    request<{ imported: boolean; levelName: string }>(`/api/servers/${encodeURIComponent(id)}/world/import`, {
      method: "POST",
      body: JSON.stringify({ archivePath }),
    }),
  /** Detects server network addresses (IPv4, IPv6, Public IP) and online status. */
  serverNetwork: (id: string) =>
    request<ServerNetworkInfo>(`/api/servers/${encodeURIComponent(id)}/network`),
};

export interface ServerNetworkInfo {
  online: boolean;
  ready: boolean;
  status: "ready" | "starting" | "offline";
  gamePort: number;
  primaryIpv4: string | null;
  primaryIpv6: string | null;
  vpnIpv4?: string | null;
  publicIpv4: string | null;
  isCgnat?: boolean;
  allIpv4: string[];
  allIpv6: string[];
  players?: {
    online: number;
    max: number;
  } | null;
  version?: string | null;
  motd?: string | null;
}

/** One-line, user-facing description of any thrown value. */
export function describeError(err: unknown): string {
  const raw =
    err instanceof ApiFailure
      ? `${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  return raw
    .replace(/\\\\wsl\.localhost\\[^\\]+\\server\\/gi, "")
    .replace(/\/\/wsl\.localhost\/[^\/]+\/server\//gi, "")
    .replace(/\\wsl\.localhost\\[^\\]+\\server\\/gi, "");
}